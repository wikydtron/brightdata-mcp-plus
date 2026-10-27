import type { BrightDataClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import { toBdError } from '../errors.js';

export type ZoneState = 'exists' | 'created' | 'missing' | 'unknown';

export interface ZoneReport {
  unlocker: ZoneState;
  browser: ZoneState;
  error?: string;
}

interface ZoneSpec {
  name: string;
  body: unknown;
}

/**
 * Makes sure the Web Unlocker and Browser API zones exist, creating them when
 * allowed. Never throws: a failed check is reported and tool calls surface the
 * precise error later.
 */
export async function ensureZones(client: BrightDataClient, opts: {
  unlockerZone: string;
  browserZone: string;
  autoCreate: boolean;
  needBrowser: boolean;
  timeoutMs: number;
  logger: Logger;
}): Promise<ZoneReport> {
  const report: ZoneReport = { unlocker: 'unknown', browser: opts.needBrowser ? 'unknown' : 'missing' };
  try {
    const res = await client.request<Array<{ name?: string }> | undefined>({
      path: '/zone/get_active_zones', timeoutMs: opts.timeoutMs, what: 'Listing zones',
    });
    const names = new Set((Array.isArray(res.data) ? res.data : []).map((z) => z?.name));
    const specs: Array<[keyof Omit<ZoneReport, 'error'>, ZoneSpec]> = [
      ['unlocker', { name: opts.unlockerZone, body: { zone: { name: opts.unlockerZone, type: 'unblocker' }, plan: { type: 'unblocker', ub_premium: true } } }],
    ];
    if (opts.needBrowser) {
      specs.push(['browser', { name: opts.browserZone, body: { zone: { name: opts.browserZone, type: 'browser_api' }, plan: { type: 'browser_api' } } }]);
    }
    for (const [key, spec] of specs) {
      if (names.has(spec.name)) {
        report[key] = 'exists';
        continue;
      }
      if (!opts.autoCreate) {
        report[key] = 'missing';
        opts.logger.warn('zone missing and AUTO_CREATE_ZONES is off', { zone: spec.name });
        continue;
      }
      opts.logger.info('creating zone', { zone: spec.name });
      await client.request({
        method: 'POST', path: '/zone', body: spec.body, idempotent: false,
        timeoutMs: opts.timeoutMs, what: `Creating zone ${spec.name}`,
      });
      report[key] = 'created';
    }
  } catch (e) {
    const err = toBdError(e);
    report.error = err.message;
    opts.logger.warn('zone check failed; continuing', { kind: err.kind, error: err.message });
  }
  return report;
}
