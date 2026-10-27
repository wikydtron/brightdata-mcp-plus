import { z } from 'zod';
import { pageFooter, paginate } from '../util/text.js';
import { defineTool, json } from './types.js';

const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const acts = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const ref = z.string().min(1).describe('The ref from scraping_browser_snapshot (e.g. "e23" or "dom-4")');
const element = z.string().min(1).describe('Human-readable description of the element, for logs and errors');
const paging = {
  offset: z.number().int().min(0).optional().default(0),
  max_chars: z.number().int().min(500).max(2_000_000).optional(),
};

export const navigate = defineTool({
  name: 'scraping_browser_navigate',
  title: 'Browser Navigate',
  description: 'Open a URL in a remote Bright Data browser (handles JS, CAPTCHAs and fingerprinting). Use only when the '
    + 'task needs clicks, typing, scrolling or screenshots; scrape_as_markdown is cheaper for reading pages.',
  input: {
    url: z.string().url(),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Route the browser through this country'),
    wait_until: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional().default('domcontentloaded'),
    timeout_seconds: z.number().int().min(5).max(180).optional().default(120),
  },
  annotations: ro,
  untrusted: true,
  async handler(a, ctx, svc) {
    const r = await svc.browser.navigate(a.url, {
      country: a.country, waitUntil: a.wait_until, timeoutMs: a.timeout_seconds * 1000, signal: ctx.signal,
    });
    return { text: [`Navigated to ${r.url}`, `Title: ${r.title}`, `HTTP status: ${r.status ?? 'unknown'}`].join('\n') };
  },
});

const history = (direction: 'back' | 'forward') => defineTool({
  name: `scraping_browser_go_${direction}`,
  title: `Browser Go ${direction === 'back' ? 'Back' : 'Forward'}`,
  description: `Go ${direction} in the browser history`,
  input: {},
  annotations: ro,
  untrusted: true,
  async handler(_a, _ctx, svc) {
    const page = await svc.browser.page();
    await (direction === 'back' ? page.goBack() : page.goForward());
    return { text: [`Went ${direction}`, `Title: ${await page.title()}`, `URL: ${page.url()}`].join('\n') };
  },
});

export const snapshot = defineTool({
  name: 'scraping_browser_snapshot',
  title: 'Browser Snapshot',
  description: 'ARIA snapshot of the current page with element refs for the *_ref tools. filtered=true lists only '
    + 'interactive elements (fewer tokens, and page text cannot pose as an element); use it for sensitive actions.',
  input: { filtered: z.boolean().optional().default(false), ...paging },
  annotations: ro,
  untrusted: true,
  async handler(a, _ctx, svc) {
    const text = await svc.browser.snapshot(a.filtered || svc.config.browserFilteredSnapshot);
    const w = paginate(text, a.offset, a.max_chars ?? svc.config.maxOutputChars);
    return { text: w.content + pageFooter(w) };
  },
});

export const clickRef = defineTool({
  name: 'scraping_browser_click_ref',
  title: 'Browser Click',
  description: 'Click an element by its snapshot ref.',
  input: { ref, element, double_click: z.boolean().optional().default(false) },
  annotations: acts,
  untrusted: false,
  async handler(a, _ctx, svc) {
    const loc = await svc.browser.locator(a.ref, a.element);
    await (a.double_click ? loc.dblclick({ timeout: 10_000 }) : loc.click({ timeout: 10_000 }));
    return { text: `Clicked ${a.element} (ref=${a.ref})` };
  },
});

export const typeRef = defineTool({
  name: 'scraping_browser_type_ref',
  title: 'Browser Type',
  description: 'Type text into an element by its snapshot ref; submit=true presses Enter afterwards.',
  input: { ref, element, text: z.string().max(10_000), submit: z.boolean().optional().default(false) },
  annotations: acts,
  untrusted: false,
  async handler(a, _ctx, svc) {
    const loc = await svc.browser.locator(a.ref, a.element);
    await loc.fill(a.text, { timeout: 10_000 });
    if (a.submit) await loc.press('Enter');
    return { text: `Typed ${a.text.length} characters into ${a.element} (ref=${a.ref})${a.submit ? ' and pressed Enter' : ''}` };
  },
});

export const pressKey = defineTool({
  name: 'scraping_browser_press_key',
  title: 'Browser Press Key',
  description: 'Press a key or chord on the page, e.g. "Enter", "Escape", "PageDown", "Control+A".',
  input: { key: z.string().min(1).max(50) },
  annotations: acts,
  untrusted: false,
  async handler(a, _ctx, svc) {
    await (await svc.browser.page()).keyboard.press(a.key);
    return { text: `Pressed ${a.key}` };
  },
});

export const fillForm = defineTool({
  name: 'scraping_browser_fill_form',
  title: 'Browser Fill Form',
  description: 'Fill several form fields in one call. Each field needs its snapshot ref and type.',
  input: {
    fields: z.array(z.object({
      name: z.string().describe('Human-readable field name'),
      type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']),
      ref,
      value: z.string().describe('Text; "true"/"false" for checkbox/radio; option label for combobox'),
    })).min(1).max(50),
  },
  annotations: acts,
  untrusted: false,
  async handler(a, _ctx, svc) {
    const done: string[] = [];
    for (const f of a.fields) {
      const loc = await svc.browser.locator(f.ref, f.name);
      if (f.type === 'checkbox' || f.type === 'radio') {
        await loc.setChecked(f.value === 'true', { timeout: 10_000 });
        done.push(`${f.name}: ${f.value === 'true' ? 'checked' : 'unchecked'}`);
      } else if (f.type === 'combobox') {
        await loc.selectOption({ label: f.value }, { timeout: 10_000 });
        done.push(`${f.name}: selected "${f.value}"`);
      } else {
        await loc.fill(f.value, { timeout: 10_000 });
        done.push(`${f.name}: filled`);
      }
    }
    return { text: `Filled ${done.length} field(s):\n${done.join('\n')}` };
  },
});

export const screenshot = defineTool({
  name: 'scraping_browser_screenshot',
  title: 'Browser Screenshot',
  description: 'Screenshot the viewport (or the whole page with full_page=true; can be large). JPEG keeps it small.',
  input: {
    full_page: z.boolean().optional().default(false),
    format: z.enum(['png', 'jpeg']).optional().default('jpeg'),
    quality: z.number().int().min(20).max(100).optional().default(70).describe('JPEG quality'),
  },
  annotations: ro,
  untrusted: false,
  async handler(a, _ctx, svc) {
    const page = await svc.browser.page();
    const buffer = await page.screenshot({
      fullPage: a.full_page, type: a.format, ...(a.format === 'jpeg' ? { quality: a.quality } : {}),
    });
    return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType: `image/${a.format}` }] };
  },
});

export const getText = defineTool({
  name: 'scraping_browser_get_text',
  title: 'Browser Get Text',
  description: 'Visible text of the current page, paginated with offset/max_chars.',
  input: paging,
  annotations: ro,
  untrusted: true,
  async handler(a, ctx, svc) {
    const text = await (await svc.browser.page()).$eval('body', (b) => (b as HTMLElement).innerText);
    const w = paginate(text, a.offset, a.max_chars ?? svc.config.maxOutputChars);
    const [kept] = (await ctx.gate([w.content], (t) => t)).items;
    return { text: kept === null || kept === undefined ? 'Content withheld by the content gate.' : kept + pageFooter(w) };
  },
});

export const getHtml = defineTool({
  name: 'scraping_browser_get_html',
  title: 'Browser Get HTML',
  description: 'HTML of the current page body (full_page=true includes <head> and scripts), paginated.',
  input: { full_page: z.boolean().optional().default(false), ...paging },
  annotations: ro,
  untrusted: true,
  async handler(a, _ctx, svc) {
    const page = await svc.browser.page();
    const html = a.full_page ? await page.content() : await page.$eval('body', (b) => b.innerHTML);
    const w = paginate(html, a.offset, a.max_chars ?? svc.config.maxOutputChars);
    return { text: w.content + pageFooter(w) };
  },
});

export const scroll = defineTool({
  name: 'scraping_browser_scroll',
  title: 'Browser Scroll',
  description: 'Scroll the page: to the bottom (default; triggers infinite-scroll loading), top, or one screen up/down.',
  input: { direction: z.enum(['bottom', 'top', 'down', 'up']).optional().default('bottom') },
  annotations: ro,
  untrusted: false,
  async handler(a, _ctx, svc) {
    const page = await svc.browser.page();
    const pos = await page.evaluate((dir) => {
      const y = { bottom: document.body.scrollHeight, top: 0, down: scrollY + innerHeight * 0.9, up: scrollY - innerHeight * 0.9 }[dir];
      scrollTo(0, y);
      return { y: Math.round(scrollY), height: document.body.scrollHeight };
    }, a.direction);
    return { text: `Scrolled ${a.direction}: y=${pos.y} of ${pos.height}` };
  },
});

export const scrollToRef = defineTool({
  name: 'scraping_browser_scroll_to_ref',
  title: 'Browser Scroll to Element',
  description: 'Scroll an element into view by its snapshot ref.',
  input: { ref, element },
  annotations: ro,
  untrusted: false,
  async handler(a, _ctx, svc) {
    await (await svc.browser.locator(a.ref, a.element)).scrollIntoViewIfNeeded({ timeout: 10_000 });
    return { text: `Scrolled to ${a.element} (ref=${a.ref})` };
  },
});

export const waitForRef = defineTool({
  name: 'scraping_browser_wait_for_ref',
  title: 'Browser Wait for Element',
  description: 'Wait until an element (by snapshot ref) is visible.',
  input: { ref, element, timeout: z.number().int().min(100).max(120_000).optional().default(30_000).describe('Milliseconds') },
  annotations: ro,
  untrusted: false,
  async handler(a, _ctx, svc) {
    await (await svc.browser.locator(a.ref, a.element)).waitFor({ state: 'visible', timeout: a.timeout });
    return { text: `${a.element} (ref=${a.ref}) is visible` };
  },
});

export const networkRequests = defineTool({
  name: 'scraping_browser_network_requests',
  title: 'Browser Network Requests',
  description: 'Requests made since the last navigation (method, URL, status, resource type). Filter by resource type '
    + 'or URL substring to find the API calls behind a page.',
  input: {
    resource_types: z.array(z.string()).optional().describe('e.g. ["xhr","fetch"]'),
    url_contains: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional().default(100),
  },
  annotations: ro,
  untrusted: true,
  async handler(a, _ctx, svc) {
    const types = a.resource_types?.map((t) => t.toLowerCase());
    const all = await svc.browser.requests();
    const matched = all.filter((r) => (!types || types.includes(r.type)) && (!a.url_contains || r.url.includes(a.url_contains)));
    return { text: json({ total: all.length, matched: matched.length, requests: matched.slice(-a.limit) }) };
  },
});

export const close = defineTool({
  name: 'scraping_browser_close',
  title: 'Browser Close',
  description: 'Close the current remote browser (or all with all=true). Browser time is billed by traffic, so close '
    + 'sessions you no longer need; idle sessions also close automatically.',
  input: { all: z.boolean().optional().default(false) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  untrusted: false,
  async handler(a, _ctx, svc) {
    const n = await svc.browser.close(a.all);
    return { text: n ? `Closed ${n} browser session(s)` : 'No browser session was open' };
  },
});

export const browserTools = [navigate, history('back'), history('forward'), snapshot, clickRef, typeRef, pressKey, fillForm,
  screenshot, getText, getHtml, scroll, scrollToRef, waitForRef, networkRequests, close];
