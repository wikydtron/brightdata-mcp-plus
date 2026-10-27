import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BdError } from '../src/errors.js';
import { BrightDataClient } from '../src/http/client.js';
import { createLogger } from '../src/logger.js';
import { Redactor } from '../src/util/redact.js';
import { startStub, type Stub } from './helpers/stub.js';

let stub: Stub;
before(async () => { stub = await startStub(); });
after(async () => { await stub.close(); });

const client = (over: Partial<ConstructorParameters<typeof BrightDataClient>[0]> = {}) => {
  const redactor = new Redactor();
  return new BrightDataClient({
    baseUrl: stub.url, token: 'client-test-token', timeoutMs: 5_000, maxRetries: 2, concurrency: 4,
    redactor, logger: createLogger('silent', redactor), backoffBaseMs: 5, clientName: () => 'test-client', ...over,
  });
};

const unlock = (c: BrightDataClient, url: string, extra: { idempotent?: boolean; signal?: AbortSignal } = {}) =>
  c.request<string>({ method: 'POST', path: '/request', body: { url, zone: 'z' }, responseType: 'text', tool: 'probe', idempotent: true, ...extra });

test('retries transient 5xx for idempotent requests', async () => {
  const c = client();
  const res = await unlock(c, 'https://t.example/flaky/1');
  assert.equal(res.status, 200);
  assert.equal(c.upstreamCalls, 2);
});

test('does not retry a non-idempotent request after a 5xx (no duplicate billed jobs)', async () => {
  const c = client();
  await assert.rejects(unlock(c, 'https://t.example/flaky/2', { idempotent: false }), (e: BdError) => e.kind === 'upstream');
  assert.equal(c.upstreamCalls, 1);
});

test('retries 429 honouring Retry-After even for non-idempotent requests', async () => {
  const c = client();
  const res = await unlock(c, 'https://t.example/ratelimited/1', { idempotent: false });
  assert.equal(res.status, 200);
  assert.equal(c.upstreamCalls, 2);
});

test('4xx errors fail fast with a typed, redacted error', async () => {
  const c = client();
  await assert.rejects(unlock(c, 'https://t.example/bad'), (e: BdError) => e.kind === 'bad_request' && e.status === 400);
  assert.equal(c.upstreamCalls, 1);
  await assert.rejects(unlock(c, 'https://t.example/quota'), (e: BdError) => e.kind === 'usage_limit' && /free monthly/.test(e.hint ?? ''));
});

test('times out slow requests', async () => {
  const c = client({ timeoutMs: 100, maxRetries: 0 });
  await assert.rejects(unlock(c, 'https://t.example/slow/timeout'), (e: BdError) => e.kind === 'timeout');
});

test('cancellation aborts the upstream request immediately', async () => {
  const c = client();
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(unlock(c, 'https://t.example/slow/cancel', { signal: ac.signal }), (e: BdError) => e.kind === 'cancelled');
  assert.ok(Date.now() - started < 1000);
});

test('sends auth and telemetry headers, omits auth for public endpoints', async () => {
  const c = client();
  await unlock(c, 'https://t.example/headers');
  const call = stub.calls.filter((x) => x.path === '/request').at(-1)!;
  assert.equal(call.headers.authorization, 'Bearer client-test-token');
  assert.equal(call.headers['x-mcp-tool'], 'probe');
  assert.equal(call.headers['x-mcp-client-name'], 'test-client');
  assert.match(String(call.headers['user-agent']), /^brightdata-mcp-plus\//);
  await c.request({ path: `${stub.url}/scrapers.json`, auth: false });
  const docs = stub.calls.filter((x) => x.path === '/scrapers.json').at(-1)!;
  assert.equal(docs.headers.authorization, undefined);
});
