import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { classifyDirect, htmlToMarkdown, isPrivateAddress, toMarkdown } from '../src/services/direct.js';
import { connect, unwrap } from './helpers/harness.js';
import { startStub, type Stub } from './helpers/stub.js';

const ARTICLE = `<!doctype html><html><head><title>Article</title><style>.x{}</style></head><body>
<nav><a href="/home">Home</a></nav><h1>Direct article</h1>
<p>Readable <b>content</b> with a <a href="/docs/page">relative link</a>.</p>
${'<p>More paragraph text for a realistic article body.</p>'.repeat(80)}
<script>tracking()</script></body></html>`;

let stub: Stub;
let site: Server;
let base = '';
const hits = new Map<string, number>();

before(async () => {
  stub = await startStub();
  site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://site').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const html = (status: number, body: string, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);
    switch (path) {
      case '/article': return html(200, ARTICLE);
      case '/redirect': return html(302, '', { location: '/article' });
      case '/cf': return html(403, '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>');
      case '/spa': return html(200, '<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
      case '/captcha-short': return html(200, '<html><body><h1>Verify</h1><div class="g-recaptcha"></div></body></html>');
      case '/captcha-long': return html(200, ARTICLE.replace('</body>', '<form><div class="g-recaptcha"></div></form></body>'));
      case '/gzip': return void res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync(ARTICLE));
      case '/big': return html(200, `<html><body>${'x'.repeat(50_000)}</body></html>`);
      case '/pdf': return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7');
      case '/json': return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}');
      default: return html(404, 'not found');
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
after(async () => {
  site.close();
  await stub.close();
});

const AUTO = { FETCH_STRATEGY: 'auto', DIRECT_ALLOW_PRIVATE: 'true' };

test('private-address detection covers IPv4, IPv6 and mapped addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.2.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['93.184.215.14', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a);
});

test('block classifier: walls, JS shells and content types', () => {
  const r = (status: number, body: string, contentType = 'text/html') => ({ status, url: 'https://x.example/', contentType, body });
  assert.deepEqual(classifyDirect(r(200, ARTICLE), htmlToMarkdown(ARTICLE, 'https://x.example/')), { ok: true });
  assert.deepEqual(classifyDirect(r(403, '<title>Just a moment...</title>'), ''), { ok: false, reason: 'cloudflare_challenge' });
  assert.deepEqual(classifyDirect(r(404, 'nope'), 'nope'), { ok: false, reason: 'http_404' });
  assert.deepEqual(classifyDirect(r(200, '%PDF', 'application/pdf'), ''), { ok: false, reason: 'unsupported_content_type' });
  assert.deepEqual(classifyDirect(r(200, '<div id=root></div><script src=a.js></script>'), ''), { ok: false, reason: 'needs_javascript' });
  assert.deepEqual(classifyDirect(r(200, '<p>Robot or human?</p>'), 'Robot or human?'), { ok: false, reason: 'bot_wall' });
  assert.equal(toMarkdown(r(200, '{"a":1}', 'application/json')), '```json\n{\n  "a": 1\n}\n```');
});

test('HTML conversion drops scripts and styles and makes links absolute', () => {
  const md = htmlToMarkdown(ARTICLE, 'https://site.example/a/b');
  assert.ok(md.includes('# Direct article'));
  assert.ok(md.includes('(https://site.example/docs/page)'));
  assert.ok(!md.includes('tracking()') && !md.includes('.x{}'));
});

test('auto: readable pages are fetched directly for free', async () => {
  const h = await connect(stub, AUTO);
  const r = await h.call('scrape_as_markdown', { url: `${base}/article` });
  const text = h.text(r);
  assert.ok(unwrap(text).includes('# Direct article'));
  assert.ok(unwrap(text).includes(`(${base}/docs/page)`));
  assert.match(text, /\[server\] Fetched directly \(free\)\.$/);
  assert.equal(stub.unlockCalls(`${base}/article`), 0);
  const again = h.text(await h.call('scrape_as_markdown', { url: `${base}/article` }));
  assert.match(again, /Served from cache \(originally via free direct fetch/);
  const stats = (await h.call('session_stats')).structuredContent as { free: { direct_fetches: number }; billable: { unlocker_requests: number } };
  assert.equal(stats.free.direct_fetches, 1);
  assert.equal(stats.billable.unlocker_requests, 0);
  await h.close();
});

test('auto: follows redirects and decodes gzip', async () => {
  const h = await connect(stub, AUTO);
  assert.match(h.text(await h.call('scrape_as_markdown', { url: `${base}/redirect` })), /Fetched directly/);
  const gz = h.text(await h.call('scrape_as_markdown', { url: `${base}/gzip` }));
  assert.ok(unwrap(gz).includes('# Direct article'));
  await h.close();
});

for (const [path, reason] of [['/cf', 'cloudflare_challenge'], ['/spa', 'needs_javascript'], ['/captcha-short', 'captcha'], ['/pdf', 'unsupported_content_type'], ['/big', 'too_large']] as const) {
  test(`auto: falls back to Bright Data on ${reason}`, async () => {
    const h = await connect(stub, { ...AUTO, DIRECT_MAX_BYTES: '20000' });
    const text = h.text(await h.call('scrape_as_markdown', { url: `${base}${path}` }));
    assert.match(text, new RegExp(`Fetched via Bright Data \\(billed\\): free routes were not usable \\(${reason}\\)`));
    assert.equal(stub.unlockCalls(`${base}${path}`), 1);
    await h.close();
  });
}

test('auto: a long article with an embedded captcha form is not mistaken for a wall', async () => {
  const h = await connect(stub, AUTO);
  assert.match(h.text(await h.call('scrape_as_markdown', { url: `${base}/captcha-long` })), /Fetched directly/);
  await h.close();
});

test('auto: hosts that blocked recently go straight to Bright Data', async () => {
  const h = await connect(stub, AUTO);
  await h.call('scrape_as_markdown', { url: `${base}/cf` });
  const before = hits.get('/json') ?? 0;
  const text = h.text(await h.call('scrape_as_markdown', { url: `${base}/json` }));
  assert.match(text, /host_recently_blocked/);
  assert.equal(hits.get('/json') ?? 0, before, 'site not contacted again');
  await h.close();
});

test('direct strategy never bills: blocked pages fail with the reason', async () => {
  const h = await connect(stub, { FETCH_STRATEGY: 'direct', DIRECT_ALLOW_PRIVATE: 'true' });
  const r = await h.call('scrape_as_markdown', { url: `${base}/cf?direct-only` });
  assert.equal(r.isError, true);
  assert.match(h.text(r), /\[blocked\].*cloudflare_challenge/);
  assert.equal(stub.unlockCalls('direct-only'), 0);
  await h.close();
});

test('brightdata strategy and country routing skip the direct fetch', async () => {
  const h = await connect(stub, AUTO);
  const before = hits.get('/article') ?? 0;
  const text = h.text(await h.call('scrape_as_markdown', { url: `${base}/article`, country: 'de' }));
  assert.match(text, /Fetched via Bright Data \(billed\)\.$/);
  assert.equal(hits.get('/article') ?? 0, before);
  await h.close();
});

test('SSRF guard: private targets are refused by IP and by DNS name, and never sent to Bright Data', async () => {
  const h = await connect(stub, { FETCH_STRATEGY: 'auto' });
  const port = new URL(base).port;
  for (const url of [`${base}/article?ssrf=ip`, `http://localhost:${port}/article?ssrf=dns`]) {
    const r = await h.call('scrape_as_markdown', { url });
    assert.equal(r.isError, true, url);
    assert.match(h.text(r), /private or local network address/);
  }
  assert.equal(stub.unlockCalls('ssrf='), 0);
  await h.close();
});

test('free mode: no token, only free tools, everything direct', async () => {
  const h = await connect(stub, { API_TOKEN: '', DIRECT_ALLOW_PRIVATE: 'true' });
  const names = (await h.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['extract', 'scrape_as_html', 'scrape_as_markdown', 'scrape_batch', 'session_stats']);
  const batch = JSON.parse(unwrap(h.text(await h.call('scrape_batch', { urls: [`${base}/article`, `${base}/cf`] }))));
  assert.equal(batch[0].source, 'direct');
  assert.equal(batch[1].ok, false);
  assert.match(batch[1].error, /Add a Bright Data API_TOKEN/);
  const html = unwrap(h.text(await h.call('scrape_as_html', { url: `${base}/article`, max_chars: 600 })));
  assert.ok(html.startsWith('<!doctype html>'));
  const stats = (await h.call('session_stats')).structuredContent as { fetch_strategy: string };
  assert.equal(stats.fetch_strategy, 'direct');
  await h.close();
});
