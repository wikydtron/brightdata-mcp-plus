import { BdError, toBdError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { UsageMeter } from '../usage.js';
import { TtlCache } from '../util/cache.js';
import { classifyDirect, directFetch, toMarkdown, type DirectOptions } from './direct.js';
import type { Unlocker } from './unlocker.js';

export type FetchStrategy = 'auto' | 'direct' | 'brightdata';
export type PageSource = 'direct' | 'brightdata';

export interface PageResult {
  body: string;
  source: PageSource;
  cached: boolean;
  /** Why the free direct fetch was not used, when Bright Data served the page. */
  fallbackReason?: string | undefined;
}

interface Entry {
  body: string;
  source: PageSource;
  fallbackReason?: string | undefined;
}

const BLOCKED_HOST_TTL_MS = 30 * 60 * 1000;

/**
 * Fetches pages with the cheapest route that works. In "auto" mode it tries a
 * free direct request first and pays for Bright Data Web Unlocker only when
 * the site blocks, needs JavaScript, or fails. Hosts that blocked a direct
 * request are remembered for 30 minutes so they go straight to Bright Data.
 */
export class PageFetcher {
  readonly cache: TtlCache<Entry>;
  private readonly blockedHosts = new Map<string, number>();

  constructor(private readonly opts: {
    strategy: FetchStrategy;
    direct: DirectOptions;
    unlocker: Unlocker | null;
    meter: UsageMeter;
    logger: Logger;
    cacheTtlMs: number;
    cacheMaxEntries: number;
  }) {
    this.cache = new TtlCache<Entry>(opts.cacheTtlMs, opts.cacheMaxEntries);
  }

  get strategy(): FetchStrategy {
    return this.opts.strategy;
  }

  markdown(url: string, o: { country?: string | undefined; tool: string; signal?: AbortSignal; fresh?: boolean }): Promise<PageResult> {
    return this.get('md', url, o);
  }

  html(url: string, o: { country?: string | undefined; tool: string; signal?: AbortSignal; fresh?: boolean }): Promise<PageResult> {
    return this.get('html', url, o);
  }

  private async get(kind: 'md' | 'html', url: string, o: { country?: string | undefined; tool: string; signal?: AbortSignal; fresh?: boolean }): Promise<PageResult> {
    const country = o.country?.toLowerCase();
    const key = `${kind}|${country ?? ''}|${url}`;
    const [entry, cached] = await this.cache.getOrLoad(key, () => this.load(kind, url, country, o), { bypass: o.fresh ?? false });
    return { ...entry, cached };
  }

  private async load(kind: 'md' | 'html', url: string, country: string | undefined, o: { tool: string; signal?: AbortSignal }): Promise<Entry> {
    const host = new URL(url).hostname;
    let reason: string | undefined;
    let detail: string | undefined;
    const tryDirect = this.opts.strategy !== 'brightdata' && !country;
    if (country && this.opts.strategy === 'direct') {
      throw new BdError('config', 'Country routing needs Bright Data', { hint: 'Set FETCH_STRATEGY=auto (with API_TOKEN) or drop country.' });
    }
    const knownBlocked = (this.blockedHosts.get(host) ?? 0) > Date.now();
    if (tryDirect && knownBlocked && this.opts.strategy === 'auto') {
      reason = 'host_recently_blocked';
    } else if (tryDirect) {
      try {
        const res = await directFetch(url, this.opts.direct, o.signal);
        const text = toMarkdown(res);
        const verdict = classifyDirect(res, text);
        if (verdict.ok) {
          this.opts.meter.recordDirect(true);
          return { body: kind === 'md' ? text : res.body, source: 'direct' };
        }
        reason = verdict.reason;
      } catch (e) {
        const err = toBdError(e, o.signal);
        if (err.kind === 'cancelled' || (err.kind === 'bad_request' && /private or local/.test(err.message))) throw err;
        reason = err.code ?? err.kind;
        detail = err.message;
      }
      this.blockedHosts.set(host, Date.now() + BLOCKED_HOST_TTL_MS);
      if (this.opts.strategy === 'direct') {
        this.opts.meter.recordDirect(false);
        throw new BdError('blocked', `Direct fetch of ${host} did not return usable content (${reason}${detail ? `: ${detail}` : ''})`, {
          hint: this.opts.unlocker ? 'Set FETCH_STRATEGY=auto to fall back to Bright Data for sites like this.'
            : 'Add a Bright Data API_TOKEN to fetch protected sites through Web Unlocker.',
        });
      }
    }
    if (!this.opts.unlocker) throw new BdError('config', 'Bright Data is not configured (no API_TOKEN)');
    if (tryDirect) {
      this.opts.meter.recordDirect(false);
      this.opts.logger.info('falling back to Bright Data', { host, reason, detail });
    }
    const res = await this.opts.unlocker.fetch(url, {
      ...(kind === 'md' ? { dataFormat: 'markdown' as const } : {}),
      country, tool: o.tool, bypassCache: true, ...(o.signal ? { signal: o.signal } : {}),
    });
    return { body: res.body, source: 'brightdata', fallbackReason: reason };
  }
}

/** One-line, trusted server note telling the agent (and user) how a page was fetched. */
export function sourceNote(r: PageResult): string {
  if (r.cached) return `[server] Served from cache (originally via ${r.source === 'direct' ? 'free direct fetch' : 'Bright Data'}; no cost).`;
  if (r.source === 'direct') return '[server] Fetched directly (free).';
  return r.fallbackReason
    ? `[server] Fetched via Bright Data (billed): direct fetch was not usable (${r.fallbackReason}).`
    : '[server] Fetched via Bright Data (billed).';
}
