import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../src/logger.js';
import { disposeSharedRenderer, isLocalRequest, LocalRenderer } from '../src/services/render.js';
import { Redactor } from '../src/util/redact.js';
import { connect, unwrap } from './helpers/harness.js';
import { startStub, type Stub } from './helpers/stub.js';

/*
 * The local render step against a real headless Chrome/Edge. Skipped when no
 * browser is installed (CI runners ship Google Chrome).
 */

const hasBrowser = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
].some((p) => !!p && existsSync(p));
const skip = !hasBrowser && 'no Chrome/Edge found';

const shell = (script: string, extra = '') =>
  `<!doctype html><html><head><title>App</title></head><body><div id="root"></div>${extra}<script>${script}</script></body></html>`;
const RENDER_ARTICLE = `document.getElementById('root').innerHTML = '<h1>Rendered by JavaScript</h1>'
  + '<p>Paragraph rendered on the client. </p>'.repeat(40) + '<a href="/docs/intro">Docs</a>';`;

let stub: Stub;
let site: Server;
let base = '';
const hits: Array<{ path: string; browser: boolean }> = [];
const count = (path: string, browser?: boolean) =>
  hits.filter((h) => h.path === path && (browser === undefined || h.browser === browser)).length;

before(async () => {
  stub = await startStub();
  site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://site').pathname;
    // Chrome sends fetch metadata headers; the Node direct fetcher does not
    hits.push({ path, browser: !!req.headers['sec-fetch-mode'] });
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    switch (path) {
      case '/csr': return html(shell(RENDER_ARTICLE, '<img src="/pixel.png">'));
      case '/csr-2': return html(shell(RENDER_ARTICLE));
      case '/csr-xhr': return html(shell(`fetch('/api/items').then(r => r.json()).then(items => {
        document.getElementById('root').innerHTML = '<h1>Items</h1><ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>'; });`));
      case '/api/items': return void res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(Array.from({ length: 60 }, (_, i) => `Item number ${i} loaded over XHR`)));
      case '/csr-empty': return html(shell('/* renders nothing */'));
      // the wall text only exists after JavaScript runs, like a client-side challenge
      case '/csr-wall': return html(shell(`document.getElementById('root').innerHTML = '<h1>Prove your ' + 'humanity</h1><p>Complete the challenge.</p>';`));
      case '/pixel.png': return void res.writeHead(200, { 'content-type': 'image/png' }).end();
      default: return void res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(async () => {
  await disposeSharedRenderer();
  site.close();
  await stub.close();
});

const RENDER = { FETCH_STRATEGY: 'auto', DIRECT_ALLOW_PRIVATE: 'true', LOCAL_RENDER: 'on' };

test('isLocalRequest flags private IPs, localhost and names that resolve privately', async () => {
  const resolve = async (h: string) => (h === 'evil.example' ? ['10.0.0.5'] : ['93.184.215.14']);
  assert.equal(await isLocalRequest('169.254.169.254', resolve), true);
  assert.equal(await isLocalRequest('[::1]', resolve), true);
  assert.equal(await isLocalRequest('app.localhost', resolve), true);
  assert.equal(await isLocalRequest('evil.example', resolve), true);
  assert.equal(await isLocalRequest('good.example', resolve), false);
  assert.equal(await isLocalRequest('nxdomain.example', () => Promise.reject(new Error('ENOTFOUND'))), false);
});

test('a JavaScript-only page is rendered locally for free, with images skipped', { skip }, async () => {
  const h = await connect(stub, RENDER);
  const text = h.text(await h.call('scrape_as_markdown', { url: `${base}/csr` }));
  const page = unwrap(text);
  assert.ok(page.includes('# Rendered by JavaScript'), page.slice(0, 200));
  assert.ok(page.includes(`(${base}/docs/intro)`), 'links are absolute');
  assert.match(text, /\[server\] Rendered in a local headless browser \(free\)/);
  assert.equal(stub.unlockCalls('/csr'), 0, 'Bright Data not used');
  assert.equal(count('/pixel.png'), 0, 'images are not downloaded');
  const stats = (await h.call('session_stats')).structuredContent as { free: { local_renders: number; fallbacks: number }; local_rendering: string };
  assert.equal(stats.free.local_renders, 1);
  assert.equal(stats.free.fallbacks, 0);
  assert.equal(stats.local_rendering, 'on');
  await h.close();
});

test('rendering runs the page\'s own XHR calls, and scrape_as_html returns the rendered DOM', { skip }, async () => {
  const h = await connect(stub, RENDER);
  const md = unwrap(h.text(await h.call('scrape_as_markdown', { url: `${base}/csr-xhr` })));
  assert.ok(md.includes('Item number 59 loaded over XHR'));
  const html = unwrap(h.text(await h.call('scrape_as_html', { url: `${base}/csr-2` })));
  assert.ok(html.includes('<h1>Rendered by JavaScript</h1>'));
  await h.close();
});

test('a host that needed rendering skips the direct attempt next time', { skip }, async () => {
  const h = await connect(stub, RENDER);
  await h.call('scrape_as_markdown', { url: `${base}/csr` });
  const before = count('/csr-2', false);
  const text = h.text(await h.call('scrape_as_markdown', { url: `${base}/csr-2` }));
  assert.match(text, /Rendered in a local headless browser/);
  assert.equal(count('/csr-2', false), before, 'no direct (non-browser) request was made');
  await h.close();
});

for (const [path, reason] of [['/csr-empty', 'needs_javascript > render:needs_javascript'], ['/csr-wall', 'needs_javascript > render:bot_wall']] as const) {
  test(`falls back to Bright Data when rendering does not help (${path})`, { skip }, async () => {
    const h = await connect(stub, RENDER);
    const text = h.text(await h.call('scrape_as_markdown', { url: `${base}${path}` }));
    assert.ok(text.includes(`free routes were not usable (${reason})`), text.slice(-300));
    assert.equal(stub.unlockCalls(path), 1);
    await h.close();
  });
}

test('LOCAL_RENDER=off goes straight from direct to Bright Data', { skip }, async () => {
  const h = await connect(stub, { ...RENDER, LOCAL_RENDER: 'off' });
  const browserHits = count('/csr', true);
  const text = h.text(await h.call('scrape_as_markdown', { url: `${base}/csr?off` }));
  assert.match(text, /free routes were not usable \(needs_javascript\)/);
  assert.equal(count('/csr', true), browserHits, 'browser not used');
  await h.close();
});

test('free mode renders too, and reports a wall without billing anything', { skip }, async () => {
  const h = await connect(stub, { API_TOKEN: '', DIRECT_ALLOW_PRIVATE: 'true', LOCAL_RENDER: 'on' });
  assert.match(h.text(await h.call('scrape_as_markdown', { url: `${base}/csr?free` })), /Rendered in a local headless browser/);
  const wall = await h.call('scrape_as_markdown', { url: `${base}/csr-wall?free` });
  assert.equal(wall.isError, true);
  assert.match(h.text(wall), /render:bot_wall/);
  await h.close();
});

test('the renderer\'s own guard blocks private addresses inside the browser', { skip }, async () => {
  const redactor = new Redactor();
  const renderer = new LocalRenderer({ idleMs: 5_000, concurrency: 1, logger: createLogger('silent', redactor) });
  const before = count('/csr', true);
  await assert.rejects(
    renderer.render(`${base}/csr?ssrf`, { timeoutMs: 15_000, allowPrivate: false, userAgent: 'test' }),
    /ERR_BLOCKED_BY_CLIENT|private or local/,
  );
  assert.equal(count('/csr', true), before, 'the private page was never requested');
  await renderer.dispose();
});
