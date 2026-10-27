#!/usr/bin/env node
// Live smoke test: starts the built server over stdio and fetches real pages.
// Without API_TOKEN it runs in free mode, so it costs nothing.
//
//   node scripts/live-smoke.mjs [--json out.json] [url ...]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const urls = args.length ? args : [
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Model_Context_Protocol',
  'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429',
  'https://registry.npmjs.org/@modelcontextprotocol/sdk/latest',
  'http://169.254.169.254/latest/meta-data/',
];

const entry = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
  stderr: 'inherit',
});
const client = new Client({ name: 'live-smoke', version: '1.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`server ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}: ${tools.length} tools`);
const rows = [];
for (const url of urls) {
  const started = Date.now();
  const r = await client.callTool({ name: 'scrape_as_markdown', arguments: { url, max_chars: 2000 } });
  const text = r.content.map((c) => c.text ?? '').join('\n');
  const body = /_BEGIN=====\n([\s\S]*?)\n=====UNTRUSTED/.exec(text)?.[1] ?? '';
  const note = /\[server\][^\n]*/.exec(text)?.[0] ?? (r.isError ? text.split('\n')[0] : '');
  const row = { url, ok: !r.isError, ms: Date.now() - started, chars: body.length, note, preview: body.replace(/\s+/g, ' ').slice(0, 90) };
  rows.push(row);
  console.log(`${row.ok ? 'OK ' : 'ERR'} ${String(row.ms).padStart(5)}ms ${String(row.chars).padStart(5)} chars  ${url}\n      ${note}`);
}
const stats = (await client.callTool({ name: 'session_stats', arguments: {} })).structuredContent;
console.log('session_stats.free =', JSON.stringify(stats.free), ' billable =', JSON.stringify(stats.billable));
if (jsonOut) {
  const server = client.getServerVersion();
  writeFileSync(jsonOut, JSON.stringify({ recorded_at: new Date().toISOString(), server: { name: server?.name, version: server?.version }, tools: tools.length, rows, stats }, null, 2));
}
await client.close();
