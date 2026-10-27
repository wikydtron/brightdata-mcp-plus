import { BdError, toBdError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { UsageMeter } from '../usage.js';
import { TtlCache } from '../util/cache.js';
import { classifyDirect, directFetch, htmlToMarkdown, toMarkdown, type DirectOptions } from './direct.js';
import type { LocalRenderer } from './render.js';
import type { Unlocker } from './unlocker.js';

export type FetchStrategy = 'auto' | 'direct' | 'brightdata';
export type PageSource = 'direct' | 'local_browser' | 'brightdata';

export interface PageResult {
  body: string;
  source: PageSource;
  cached: boolean;
  /** Why the free routes were not used, when Bright Data served the page. */
  fallbackReason?: string | undefined;
}

interface Entry {
  body: string;
  source: PageSource;
  fallbackReason?: string | undefined;
}

type HostMode = 'render' | 'blocked';
const HOST_MEMORY_MS = 30 * 60 * 1000;

export interface RenderSettings {
  renderer: LocalRenderer;
  /** Direct-fetch failure reasons that trigger a local render. */
  on: ReadonlySet<string>;
  timeoutMs: number;
}

/**
 * Fetches pages with the cheapest route that works:
 *   1. direct request from this machine (free)
 *   2. local headless Chrome/Edge when the page is a JavaScript shell (free)
 *   3. Bright Data Web Unlocker for bot walls and everything else (billed, "auto" only)
 * Hosts are remembered for 30 minutes: ones that needed rendering go straight
 * to the renderer, ones that blocked go straight to Bright Data.
 */
export class PageFetcher {
  readonly cache: TtlCache<Entry>;
  private readonly hosts = new Map<string, { mode: HostMode; until: number }>();

  constructor(private readonly opts: {
    strategy: FetchStrategy;
    direct: DirectOptions;
    render: RenderSettings | null;
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

  get renderingEnabled(): boolean {
    return !!this.opts.render && !this.opts.render.renderer.unavailableReason;
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

  private hostMode(host: string): HostMode | null {
    const m = this.hosts.get(host);
    return m && m.until > Date.now() ? m.mode : null;
  }

  private remember(host: string, mode: HostMode): void {
    this.hosts.set(host, { mode, until: Date.now() + HOST_MEMORY_MS });
  }

  private async load(kind: 'md' | 'html', url: string, country: string | undefined, o: { tool: string; signal?: AbortSignal }): Promise<Entry> {
    const host = new URL(url).hostname;
    const reasons: string[] = [];
    let detail: string | undefined;
    if (country && this.opts.strategy === 'direct') {
      throw new BdError('config', 'Country routing needs Bright Data', { hint: 'Set FETCH_STRATEGY=auto (with API_TOKEN) or drop country.' });
    }
    const free = this.opts.strategy !== 'brightdata' && !country;
    const mode = this.hostMode(host);

    if (free && mode === 'blocked' && this.opts.strategy === 'auto') {
      reasons.push('host_recently_blocked');
    } else if (free) {
      let renderTarget: string | null = null;
      if (mode === 'render' && this.renderingEnabled) {
        reasons.push('host_needs_javascript');
        renderTarget = url;
      } else {
        try {
          const res = await directFetch(url, this.opts.direct, o.signal);
          const text = toMarkdown(res);
          const verdict = classifyDirect(res, text);
          if (verdict.ok) {
            this.opts.meter.recordFetch('direct');
            return { body: kind === 'md' ? text : res.body, source: 'direct' };
          }
          reasons.push(verdict.reason);
          // render the URL the direct fetch ended on: its redirect chain already passed the SSRF guard
          if (this.opts.render?.on.has(verdict.reason)) renderTarget = res.url;
        } catch (e) {
          const err = toBdError(e, o.signal);
          if (err.kind === 'cancelled' || (err.kind === 'bad_request' && /private or local/.test(err.message))) throw err;
          reasons.push(err.code ?? err.kind);
          detail = err.message;
        }
      }

      if (renderTarget && this.renderingEnabled) {
        const rendered = await this.tryRender(kind, renderTarget, o.signal);
        if (rendered.entry) {
          this.remember(host, 'render');
          this.opts.meter.recordFetch('local_render');
          return rendered.entry;
        }
        reasons.push(`render:${rendered.reason}`);
      }

      this.remember(host, 'blocked');
      if (this.opts.strategy === 'direct') {
        this.opts.meter.recordFetch('fallback');
        throw new BdError('blocked', `No free route returned usable content for ${host} (${reasons.join(' > ')}${detail ? `: ${detail}` : ''})`, {
          hint: this.opts.unlocker ? 'Set FETCH_STRATEGY=auto to fall back to Bright Data for sites like this.'
            : 'Add a Bright Data API_TOKEN to fetch protected sites through Web Unlocker.',
        });
      }
    }

    if (!this.opts.unlocker) throw new BdError('config', 'Bright Data is not configured (no API_TOKEN)');
    const reason = reasons.length ? reasons.join(' > ') : undefined;
    if (free) {
      this.opts.meter.recordFetch('fallback');
      this.opts.logger.info('falling back to Bright Data', { host, reason, detail });
    }
    const res = await this.opts.unlocker.fetch(url, {
      ...(kind === 'md' ? { dataFormat: 'markdown' as const } : {}),
      country, tool: o.tool, bypassCache: true, ...(o.signal ? { signal: o.signal } : {}),
    });
    return { body: res.body, source: 'brightdata', fallbackReason: reason };
  }

  private async tryRender(kind: 'md' | 'html', url: string, signal?: AbortSignal): Promise<{ entry?: Entry; reason: string }> {
    const settings = this.opts.render!;
    try {
      const r = await settings.renderer.render(url, {
        timeoutMs: settings.timeoutMs, allowPrivate: this.opts.direct.allowPrivate, userAgent: this.opts.direct.userAgent, signal,
      });
      const text = htmlToMarkdown(r.html, r.url);
      const verdict = classifyDirect({ status: r.status ?? 200, url: r.url, contentType: 'text/html', body: r.html }, text);
      if (verdict.ok) return { entry: { body: kind === 'md' ? text : r.html, source: 'local_browser' }, reason: 'ok' };
      return { reason: verdict.reason };
    } catch (e) {
      const err = toBdError(e, signal);
      if (err.kind === 'cancelled' || (err.kind === 'bad_request' && /private or local/.test(err.message))) throw err;
      this.opts.logger.warn('local render failed', { url, error: err.message });
      return { reason: err.kind === 'config' ? 'unavailable' : 'failed' };
    }
  }
}

/** One-line, trusted server note telling the agent (and user) how a page was fetched. */
export function sourceNote(r: PageResult): string {
  const how = { direct: 'free direct fetch', local_browser: 'free local browser render', brightdata: 'Bright Data' }[r.source];
  if (r.cached) return `[server] Served from cache (originally via ${how}; no cost).`;
  if (r.source === 'direct') return '[server] Fetched directly (free).';
  if (r.source === 'local_browser') return '[server] Rendered in a local headless browser (free): the page needs JavaScript.';
  return r.fallbackReason
    ? `[server] Fetched via Bright Data (billed): free routes were not usable (${r.fallbackReason}).`
    : '[server] Fetched via Bright Data (billed).';
}
