import type { BrightDataClient } from '../http/client.js';
import type { TtlCache } from '../util/cache.js';
import type { UsageMeter } from '../usage.js';

export interface UnlockOptions {
  dataFormat?: 'markdown' | 'parsed_light';
  country?: string | undefined;
  tool: string;
  signal?: AbortSignal;
  bypassCache?: boolean;
}

export interface UnlockResult {
  body: string;
  cached: boolean;
}

/** Web Unlocker access with response caching and budget accounting. */
export class Unlocker {
  constructor(
    private readonly client: BrightDataClient,
    private readonly zone: string,
    private readonly cache: TtlCache<string>,
    private readonly meter: UsageMeter,
    private readonly zonesReady: () => Promise<unknown>,
  ) {}

  async fetch(url: string, opts: UnlockOptions): Promise<UnlockResult> {
    const country = opts.country?.toLowerCase();
    const key = [this.zone, opts.dataFormat ?? 'raw', country ?? '', url].join('|');
    const [body, cached] = await this.cache.getOrLoad(key, async () => {
      this.meter.reserve(1);
      let billed = 0;
      try {
        await this.zonesReady();
        const res = await this.client.request<string>({
          method: 'POST',
          path: '/request',
          body: {
            url,
            zone: this.zone,
            format: 'raw',
            ...(opts.dataFormat ? { data_format: opts.dataFormat } : {}),
            ...(country ? { country } : {}),
          },
          responseType: 'text',
          idempotent: true,
          tool: opts.tool,
          what: `Fetching ${new URL(url).host}`,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        billed = 1;
        return res.data;
      } finally {
        this.meter.settle(1, 'unlocker_requests', billed);
      }
    }, { bypass: opts.bypassCache ?? false });
    return { body, cached };
  }
}
