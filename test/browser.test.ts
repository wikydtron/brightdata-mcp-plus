import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, unwrap, type Harness } from './helpers/harness.js';
import { startStub, type Stub } from './helpers/stub.js';

/*
 * Drives the browser tools against a real local Chromium (Chrome or Edge)
 * through BROWSER_CDP_ENDPOINT, the same CDP path the remote Bright Data
 * browser uses. Skipped when no browser is installed (set CHROME_PATH).
 */

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);
const executable = CANDIDATES.find((p) => existsSync(p));

const PAGE = `<!doctype html><html><head><title>Form test</title></head><body>
<h1>Hello</h1>
<input aria-label="Name" id="name">
<button onclick="document.getElementById('out').textContent='Hi '+document.getElementById('name').value; fetch('/api/ping')">Greet</button>
<div id="out"></div>
<a href="/next">Next page</a>
</body></html>`;

let stub: Stub;
let site: Server;
let siteUrl = '';
let chrome: ChildProcess | undefined;
let profile = '';
let h: Harness;

before(async () => {
  if (!executable) return;
  stub = await startStub();
  site = createServer((req, res) => {
    if (req.url === '/api/ping') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"pong":true}');
    if (req.url === '/next') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Next</title><p>Second page</p>');
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  profile = mkdtempSync(join(tmpdir(), 'bdmcp-browser-'));
  chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  // cold starts on busy CI runners (other test files start Chrome in parallel) can take well over 10 s
  const portFile = join(profile, 'DevToolsActivePort');
  let exited: number | null = null;
  chrome.once('exit', (code) => { exited = code ?? -1; });
  const deadline = Date.now() + 45_000;
  while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
    if (exited !== null) throw new Error(`Chrome exited with code ${exited} before opening its DevTools port`);
    if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port within 45 s');
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  h = await connect(stub, { BROWSER_CDP_ENDPOINT: `ws://127.0.0.1:${port}${path}` });
});

after(async () => {
  if (!executable) return;
  await h?.close();
  chrome?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  site?.close();
  await stub?.close();
});

const refOf = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  const ref = line && /\[(?:ref=)?([a-z0-9-]+)\]/i.exec(line)?.[1];
  if (!ref) throw new Error(`no element matching ${pattern} in:\n${snapshot}`);
  return ref;
};

test('browser tools: navigate, snapshot refs, type, click, read, network, screenshot, close', { skip: !executable && 'no Chromium found' }, async () => {
  const nav = unwrap(h.text(await h.call('scraping_browser_navigate', { url: siteUrl })));
  assert.match(nav, /Title: Form test/);
  assert.match(nav, /HTTP status: 200/);

  const snap = unwrap(h.text(await h.call('scraping_browser_snapshot', { filtered: true })));
  const nameRef = refOf(snap, /textbox "Name"/);
  const greetRef = refOf(snap, /button "Greet"/);

  const typed = await h.call('scraping_browser_type_ref', { ref: nameRef, element: 'Name field', text: 'Ada' });
  assert.equal(typed.isError, undefined, h.text(typed));
  const clicked = await h.call('scraping_browser_click_ref', { ref: greetRef, element: 'Greet button' });
  assert.equal(clicked.isError, undefined, h.text(clicked));

  const text = unwrap(h.text(await h.call('scraping_browser_get_text', {})));
  assert.match(text, /Hi Ada/);

  let pings = 0;
  for (let i = 0; i < 20 && !pings; i++) {
    const net = JSON.parse(unwrap(h.text(await h.call('scraping_browser_network_requests', { url_contains: '/api/ping' }))));
    pings = net.matched;
    if (!pings) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(pings, 1);

  const shot = await h.call('scraping_browser_screenshot', {});
  const img = shot.content[0] as { type: string; mimeType: string; data: string };
  assert.equal(img.type, 'image');
  assert.equal(img.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(img.data, 'base64').length > 1000);

  const html = unwrap(h.text(await h.call('scraping_browser_get_html', { max_chars: 500 })));
  assert.match(html, /<h1>Hello<\/h1>/);

  const bad = await h.call('scraping_browser_click_ref', { ref: 'e9999', element: 'missing' });
  assert.equal(bad.isError, true);
  assert.match(h.text(bad), /not on the current page/);

  const stats = (await h.call('session_stats')).structuredContent as { billable: Record<string, number>; open_browser_sessions: number };
  assert.equal(stats.billable.browser_navigations, 1);
  assert.equal(stats.open_browser_sessions, 1);

  assert.match(h.text(await h.call('scraping_browser_close', { all: true })), /Closed 1/);
  const after = await h.call('scraping_browser_get_text', {});
  assert.equal(after.isError, true);
  assert.match(h.text(after), /navigate/);
});
