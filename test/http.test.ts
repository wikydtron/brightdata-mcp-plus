import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { startHttpServer, type HttpHandle } from '../src/http/server.js';
import { createLogger } from '../src/logger.js';
import { Redactor } from '../src/util/redact.js';
import { startStub, type Stub } from './helpers/stub.js';

let stub: Stub;
let http: HttpHandle;
before(async () => {
  stub = await startStub();
  const redactor = new Redactor();
  const config = loadConfig({ BRIGHTDATA_API_URL: stub.url, BRIGHTDATA_DOCS_URL: stub.url, LOG_LEVEL: 'silent', PORT: '0' });
  http = await startHttpServer(config, createLogger('silent', redactor), redactor);
});
after(async () => {
  await http.close();
  await stub.close();
});

const connectHttp = async (headers: Record<string, string>, query = '') => {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}${query}`), { requestInit: { headers } }));
  return client;
};

test('health endpoint reports status', async () => {
  const res = await fetch(http.url.replace('/mcp', '/healthz'));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, 'ok');
});

test('rejects sessions without a token when the server has none', async () => {
  await assert.rejects(connectHttp({}), /401|token/i);
});

test('per-session token from the Authorization header, isolated sessions, group filtering', async () => {
  const a = await connectHttp({ authorization: 'Bearer tenant-a-token' });
  const b = await connectHttp({ authorization: 'Bearer tenant-b-token' }, '?groups=browser');
  assert.equal(http.sessions(), 2);
  assert.equal((await a.listTools()).tools.length, 34);
  const bTools = (await b.listTools()).tools.map((t) => t.name);
  assert.ok(bTools.includes('scraping_browser_navigate') && !bTools.includes('run_scraper'));

  const r = await a.callTool({ name: 'scrape_as_markdown', arguments: { url: 'https://http.example/a' } });
  assert.equal(r.isError, undefined);
  const call = stub.calls.filter((c) => c.path === '/request').at(-1)!;
  assert.equal(call.headers.authorization, 'Bearer tenant-a-token');
  assert.equal(call.headers['x-mcp-client-name'], 'http-test');

  await b.callTool({ name: 'scrape_as_markdown', arguments: { url: 'https://http.example/a' } });
  assert.equal(stub.calls.filter((c) => c.path === '/request').at(-1)!.headers.authorization, 'Bearer tenant-b-token',
    'tenant B is not served from tenant A\'s cache');

  await a.close();
  await b.close();
});

test('rejects unknown session ids', async () => {
  const res = await fetch(http.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 404);
});
