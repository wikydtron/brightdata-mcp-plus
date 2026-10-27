import type { Browser, Locator, Page, Request, Response } from 'playwright-core';
import type { BrightDataClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { UsageMeter } from '../usage.js';
import type { Redactor } from '../util/redact.js';
import { BdError, toBdError } from '../errors.js';

const MAX_TRACKED_REQUESTS = 500;
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'slider', 'tab', 'menuitem', 'option']);

interface Slot {
  key: string;
  browser: Browser;
  page: Page;
  requests: Map<Request, Response | null>;
  domRefs: Set<string>;
  lastUsed: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  url: string | null;
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

export function formatElements(elements: SnapshotElement[]): string {
  return elements.map((el) => {
    const parts = [`[${el.ref}]`, el.role];
    if (el.name) parts.push(`"${short(el.name, 60)}"`);
    if (el.url && !el.url.startsWith('#')) parts.push(`-> ${short(el.url, 50)}`);
    return parts.join(' ');
  }).join('\n');
}

/** Keeps only interactive elements of a Playwright AI-mode ARIA snapshot. */
export function filterAriaSnapshot(snapshot: string): SnapshotElement[] {
  const lines = snapshot.split('\n');
  const out: SnapshotElement[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) return;
    const ref = /\[ref=([^\]]+)\]/.exec(trimmed)?.[1];
    const role = /^-\s+([a-zA-Z]+)/.exec(trimmed)?.[1];
    if (!ref || !role || !INTERACTIVE_ROLES.has(role)) return;
    const name = /"([^"]*)"/.exec(trimmed)?.[1] ?? '';
    const url = /\/url:\s*(.+)/.exec(lines[i + 1] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
    out.push({ ref, role, name, url });
  });
  return out;
}

/**
 * Remote Browser API sessions. One browser per (country, hostname) slot, LRU
 * capped and closed after an idle period so forgotten sessions stop costing
 * bandwidth. playwright-core is loaded lazily: servers that never use the
 * browser tools never pay its startup cost.
 */
export class BrowserManager {
  private readonly slots = new Map<string, Slot>();
  private current: string | null = null;
  private credentials: { customer: string; password: string } | null = null;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly opts: {
    client: BrightDataClient;
    zone: string;
    cdpEndpoint?: string | undefined;
    idleTimeoutMs: number;
    maxSessions: number;
    meter: UsageMeter;
    redactor: Redactor;
    logger: Logger;
    zonesReady: () => Promise<unknown>;
  }) {
    this.idleTimer = setInterval(() => void this.reapIdle(), Math.min(30_000, opts.idleTimeoutMs));
    this.idleTimer.unref();
  }

  get openSessions(): number {
    return this.slots.size;
  }

  private async endpoint(country: string, signal?: AbortSignal): Promise<string> {
    if (this.opts.cdpEndpoint) return this.opts.cdpEndpoint;
    if (!this.credentials) {
      await this.opts.zonesReady();
      const sig = signal ? { signal } : {};
      const status = await this.opts.client.request<{ customer?: string }>({ path: '/status', what: 'Reading account status', ...sig });
      const pw = await this.opts.client.request<{ passwords?: string[] }>({
        path: '/zone/passwords', query: { zone: this.opts.zone }, what: `Reading ${this.opts.zone} credentials`, ...sig,
      }).catch((e: unknown) => {
        const err = toBdError(e);
        throw err.status === 422 ? new BdError('config', `Browser zone "${this.opts.zone}" does not exist`, { status: 422 }) : err;
      });
      const customer = status.data?.customer;
      const password = pw.data?.passwords?.[0];
      if (!customer || !password) throw new BdError('upstream', 'Could not read browser zone credentials');
      this.opts.redactor.add(password);
      this.credentials = { customer, password };
    }
    const suffix = country ? `-country-${country}` : '';
    return `wss://brd-customer-${this.credentials.customer}-zone-${this.opts.zone}${suffix}:${this.credentials.password}@brd.superproxy.io:9222`;
  }

  private async playwright() {
    try {
      return await import('playwright-core');
    } catch (cause) {
      throw new BdError('config', 'Browser tools need the optional dependency playwright-core', {
        hint: 'Install it with: npm install playwright-core@1.64.1', cause,
      });
    }
  }

  /** Returns the page for the target (or current) slot, connecting if needed. */
  async page(opts: { url?: string; country?: string | undefined; signal?: AbortSignal } = {}): Promise<Page> {
    const slot = await this.slot(opts);
    return slot.page;
  }

  async slot(opts: { url?: string; country?: string | undefined; signal?: AbortSignal } = {}): Promise<Slot> {
    let key = this.current;
    if (opts.url) {
      const host = new URL(opts.url).hostname;
      key = `${(opts.country ?? '').toLowerCase()}|${host}`;
    }
    if (!key) throw new BdError('bad_request', 'No browser page is open', { hint: 'Call scraping_browser_navigate first.' });
    let slot = this.slots.get(key);
    if (slot && !slot.browser.isConnected()) {
      this.slots.delete(key);
      slot = undefined;
    }
    if (!slot) {
      if (!opts.url) throw new BdError('bad_request', 'The browser session ended', { hint: 'Call scraping_browser_navigate again.' });
      await this.evictIfFull();
      const { chromium } = await this.playwright();
      const country = key.split('|')[0] ?? '';
      const endpoint = await this.endpoint(country, opts.signal);
      this.opts.logger.info('connecting remote browser', { slot: key });
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 }).catch((e: unknown) => {
        throw new BdError('upstream', `Could not connect to the remote browser: ${this.opts.redactor.redact(toBdError(e).message)}`);
      });
      const context = browser.contexts()[0] ?? await browser.newContext();
      const page = context.pages()[0] ?? await context.newPage();
      const created: Slot = { key, browser, page, requests: new Map(), domRefs: new Set(), lastUsed: Date.now() };
      page.on('request', (r) => {
        if (created.requests.size >= MAX_TRACKED_REQUESTS) {
          const oldest = created.requests.keys().next().value;
          if (oldest) created.requests.delete(oldest);
        }
        created.requests.set(r, null);
      });
      page.on('response', (r) => {
        if (created.requests.has(r.request())) created.requests.set(r.request(), r);
      });
      browser.on('disconnected', () => {
        if (this.slots.get(key) === created) this.slots.delete(key);
      });
      this.slots.set(key, created);
      slot = created;
    }
    slot.lastUsed = Date.now();
    this.current = key;
    return slot;
  }

  async navigate(url: string, opts: { country?: string | undefined; waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeoutMs: number; signal?: AbortSignal }) {
    const slot = await this.slot({ url, country: opts.country, ...(opts.signal ? { signal: opts.signal } : {}) });
    slot.requests.clear();
    slot.domRefs.clear();
    const response = await slot.page.goto(url, { waitUntil: opts.waitUntil, timeout: opts.timeoutMs });
    this.opts.meter.settle(0, 'browser_navigations', 1);
    return { title: await slot.page.title(), url: slot.page.url(), status: response?.status() ?? null };
  }

  async snapshot(filtered: boolean): Promise<string> {
    const slot = await this.slot();
    const page = slot.page;
    const full = await page.ariaSnapshot({ mode: 'ai' });
    const header = [`Page: ${page.url()}`, `Title: ${await page.title()}`, ''];
    if (!filtered) return [...header, full].join('\n');
    const aria = filterAriaSnapshot(full);
    const dom = await collectDomElements(page);
    slot.domRefs = new Set(dom.map((d) => d.ref));
    const lines = [...header, 'Interactive Elements:', aria.length ? formatElements(aria) : 'No interactive elements found'];
    if (dom.length) lines.push('', 'DOM Interactive Elements:', formatElements(dom));
    return lines.join('\n');
  }

  /** Resolves a snapshot ref to a locator, refusing refs that are ambiguous. */
  async locator(ref: string, element: string): Promise<Locator> {
    const slot = await this.slot();
    if (slot.domRefs.has(ref)) return slot.page.locator(`[data-mcp-ref="${ref}"]`).first().describe(element);
    const snapshot = await slot.page.ariaSnapshot({ mode: 'ai' });
    const occurrences = snapshot.split(`[ref=${ref}]`).length - 1;
    if (!occurrences) throw new BdError('bad_request', `Ref ${ref} is not on the current page`, { hint: 'Capture a new snapshot.' });
    if (occurrences > 1) {
      throw new BdError('bad_request', `Ref ${ref} appears more than once in the snapshot and cannot be resolved safely`, {
        hint: 'Capture a new snapshot and use the ref from an element line, not from page text.',
      });
    }
    return slot.page.locator(`aria-ref=${ref}`).describe(element);
  }

  async requests(): Promise<Array<{ method: string; url: string; status: number | null; type: string }>> {
    const slot = await this.slot();
    return [...slot.requests].map(([req, res]) => ({
      method: req.method(), url: req.url(), status: res?.status() ?? null, type: req.resourceType(),
    }));
  }

  async close(all: boolean): Promise<number> {
    const keys = all ? [...this.slots.keys()] : this.current ? [this.current] : [];
    for (const key of keys) {
      const slot = this.slots.get(key);
      this.slots.delete(key);
      await slot?.browser.close().catch(() => undefined);
    }
    if (all || (this.current && keys.includes(this.current))) this.current = null;
    return keys.length;
  }

  async dispose(): Promise<void> {
    clearInterval(this.idleTimer);
    await this.close(true);
  }

  private async evictIfFull(): Promise<void> {
    while (this.slots.size >= this.opts.maxSessions) {
      const oldest = [...this.slots.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) return;
      this.opts.logger.info('closing least recently used browser', { slot: oldest.key });
      this.slots.delete(oldest.key);
      if (this.current === oldest.key) this.current = null;
      await oldest.browser.close().catch(() => undefined);
    }
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.opts.idleTimeoutMs;
    for (const slot of [...this.slots.values()]) {
      if (slot.lastUsed < cutoff) {
        this.opts.logger.info('closing idle browser', { slot: slot.key });
        this.slots.delete(slot.key);
        if (this.current === slot.key) this.current = null;
        await slot.browser.close().catch(() => undefined);
      }
    }
  }
}

/** Visible clickable DOM elements that the ARIA tree can miss (div buttons etc.). */
async function collectDomElements(page: Page): Promise<SnapshotElement[]> {
  return page.evaluate(() => {
    const selectors = ['a[href]', 'button', 'input', 'select', 'textarea', '[role]', '[tabindex]', '[onclick]',
      '[data-action]', '[data-click]', '[aria-pressed]', '[aria-haspopup]'];
    const collapse = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
    const labelFor = (el: Element) => {
      const id = el.id?.trim();
      if (!id) return '';
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null;
      return lbl ? collapse(lbl.innerText || lbl.textContent) : '';
    };
    const labelledBy = (el: Element) => (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)
      .map((id) => document.getElementById(id))
      .map((n) => (n ? collapse((n as HTMLElement).innerText || n.textContent) : ''))
      .filter(Boolean).join(' ');
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return !top || top === el || el.contains(top) || top.contains(el);
    };
    const out: Array<{ ref: string; role: string; name: string; url: string | null }> = [];
    // continue numbering after refs from earlier snapshots so refs never collide
    let counter = Math.max(0, ...Array.from(document.querySelectorAll('[data-mcp-ref]'))
      .map((n) => Number((n as HTMLElement).dataset.mcpRef?.slice(4)) || 0));
    for (const el of Array.from(document.querySelectorAll(selectors.join(',')))) {
      if (!visible(el)) continue;
      const h = el as HTMLElement;
      let name = collapse(el.getAttribute('aria-label')) || labelledBy(el) || collapse(el.getAttribute('title'))
        || collapse(el.getAttribute('alt')) || collapse(el.getAttribute('placeholder')) || labelFor(el)
        || collapse(h.innerText || h.textContent);
      if (name.length > 80) name = `${name.slice(0, 77)}...`;
      const url = (el as HTMLAnchorElement).href || el.getAttribute('data-url') || '';
      if (!name && !url) continue;
      if (!h.dataset.mcpRef) h.dataset.mcpRef = `dom-${++counter}`;
      out.push({ ref: h.dataset.mcpRef, role: el.getAttribute('role') || el.tagName.toLowerCase(), name, url: url || null });
    }
    return out;
  });
}
