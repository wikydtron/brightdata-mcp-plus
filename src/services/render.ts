import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Browser, Route } from 'playwright-core';
import { BdError, toBdError } from '../errors.js';
import type { Logger } from '../logger.js';
import { Semaphore } from '../util/async.js';
import { isPrivateAddress } from './direct.js';

/*
 * Free JavaScript rendering in a local headless Chrome/Edge, used when a page
 * is an empty client-side shell. It renders pages; it does not try to get past
 * bot detection: a page that shows a bot wall to a real browser goes to Bright
 * Data, which is the service built for that.
 *
 * One browser process is shared by every session (each render gets its own
 * incognito context) and shuts down after an idle period.
 */

export interface RenderResult {
  status: number | null;
  url: string;
  html: string;
}

export interface RenderOptions {
  timeoutMs: number;
  allowPrivate: boolean;
  userAgent: string;
  signal?: AbortSignal | undefined;
}

const SKIPPED_TYPES = new Set(['image', 'media', 'font']);
const MIN_TEXT = 400;

export function isLocalRequest(hostname: string, resolve: (host: string) => Promise<string[]>): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return Promise.resolve(isPrivateAddress(host));
  if (host === 'localhost' || host.endsWith('.localhost')) return Promise.resolve(true);
  return resolve(host).then((addrs) => addrs.some(isPrivateAddress), () => false);
}

export class LocalRenderer {
  private browser: Promise<Browser> | null = null;
  private unavailable: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly semaphore: Semaphore;
  private readonly dns = new Map<string, Promise<string[]>>();

  constructor(private readonly opts: { executablePath?: string | undefined; idleMs: number; concurrency: number; logger: Logger }) {
    this.semaphore = new Semaphore(opts.concurrency);
  }

  /** Why rendering is unavailable (no browser found), or null. */
  get unavailableReason(): string | null {
    return this.unavailable;
  }

  async render(url: string, o: RenderOptions): Promise<RenderResult> {
    if (this.unavailable) throw new BdError('config', this.unavailable);
    return this.semaphore.run(async () => {
      const browser = await this.launch();
      const context = await browser.newContext({
        userAgent: o.userAgent, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: false,
      });
      const onAbort = () => void context.close().catch(() => undefined);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const deadline = Date.now() + o.timeoutMs;
      try {
        await context.route('**/*', (route) => this.guard(route, o.allowPrivate));
        const page = await context.newPage();
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs });
        // done when the app has produced text, or its network has gone quiet (an empty shell
        // fails fast instead of waiting); long-polling apps are covered by the text check
        const left = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()));
        const hasText = page.waitForFunction((min) => (document.body?.innerText ?? '').trim().length > min, MIN_TEXT,
          { timeout: left(12_000) });
        const idle = page.waitForLoadState('networkidle', { timeout: left(12_000) });
        await Promise.race([hasText, idle]).catch(() => undefined);
        hasText.catch(() => undefined);
        idle.catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: left(2_000) }).catch(() => undefined);
        const finalUrl = page.url();
        if (!o.allowPrivate && await isLocalRequest(new URL(finalUrl).hostname, (h) => this.resolve(h))) {
          throw new BdError('bad_request', `Refusing rendered content from ${new URL(finalUrl).hostname}: it is a private or local network address`);
        }
        return { status: res?.status() ?? null, url: finalUrl, html: await page.content() };
      } catch (e) {
        if (o.signal?.aborted) throw new BdError('cancelled', 'The request was cancelled');
        const err = toBdError(e);
        throw err.kind === 'internal' ? new BdError('upstream', `Local render failed: ${err.message.split('\n')[0]}`) : err;
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
        await context.close().catch(() => undefined);
        this.armIdle();
      }
    }, o.signal);
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.browser;
    this.browser = null;
    if (pending) await pending.then((b) => b.close(), () => undefined).catch(() => undefined);
  }

  /** Blocks images/media/fonts (speed) and any request to a private address (SSRF). */
  private async guard(route: Route, allowPrivate: boolean): Promise<void> {
    const req = route.request();
    if (SKIPPED_TYPES.has(req.resourceType())) return route.abort();
    const u = new URL(req.url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !allowPrivate
      && await isLocalRequest(u.hostname, (h) => this.resolve(h))) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  }

  private resolve(host: string): Promise<string[]> {
    let hit = this.dns.get(host);
    if (!hit) {
      hit = lookup(host, { all: true }).then((list) => list.map((a) => a.address));
      this.dns.set(host, hit);
      if (this.dns.size > 500) this.dns.delete(this.dns.keys().next().value!);
    }
    return hit;
  }

  private launch(): Promise<Browser> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.browser ??= (async () => {
      let chromium: typeof import('playwright-core').chromium;
      try {
        ({ chromium } = await import('playwright-core'));
      } catch {
        throw this.markUnavailable('Local rendering needs the optional dependency playwright-core');
      }
      const attempts: Array<{ channel?: string; executablePath?: string }> = this.opts.executablePath
        ? [{ executablePath: this.opts.executablePath }]
        : [{ channel: 'chrome' }, { channel: 'msedge' }];
      for (const attempt of attempts) {
        try {
          const browser = await chromium.launch({ ...attempt, headless: true, args: ['--disable-gpu', '--no-first-run', '--disable-dev-shm-usage'] });
          browser.on('disconnected', () => { this.browser = null; });
          this.opts.logger.info('local renderer started', { browser: attempt.channel ?? attempt.executablePath, version: browser.version() });
          return browser;
        } catch { /* try the next browser */ }
      }
      throw this.markUnavailable('No local Chrome or Edge found for JavaScript rendering');
    })().catch((e: unknown) => {
      this.browser = null;
      throw e;
    });
    return this.browser;
  }

  private markUnavailable(message: string): BdError {
    this.unavailable = message;
    this.opts.logger.warn('local rendering disabled', { reason: message });
    return new BdError('config', message, { hint: 'Install Chrome or Edge, or set CHROME_PATH. LOCAL_RENDER=off hides this.' });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.semaphore.pending === 0) void this.dispose();
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }
}

let shared: LocalRenderer | null = null;

/** The process-wide renderer (one browser process for all sessions). */
export function sharedRenderer(opts: ConstructorParameters<typeof LocalRenderer>[0]): LocalRenderer {
  shared ??= new LocalRenderer(opts);
  return shared;
}

export async function disposeSharedRenderer(): Promise<void> {
  await shared?.dispose();
  shared = null;
}
