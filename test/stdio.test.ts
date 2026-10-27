import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStub, type Stub } from './helpers/stub.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

let stub: Stub;
before(async () => { stub = await startStub(); });
after(async () => { await stub.close(); });

test('the built CLI serves MCP over stdio with logs only on stderr', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env as Record<string, string>,
      API_TOKEN: 'stdio-secret-token', BRIGHTDATA_API_URL: stub.url, BRIGHTDATA_DOCS_URL: stub.url, LOG_LEVEL: 'debug',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'brightdata-mcp-plus');
  assert.match(client.getInstructions() ?? '', /search_scrapers/);
  const r = await client.callTool({ name: 'scrape_as_markdown', arguments: { url: 'https://stdio.example/x' } });
  assert.equal(r.isError, undefined);
  await client.close();

  const lines = stderr.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `stderr line is JSON: ${line}`);
  assert.ok(lines.some((l) => JSON.parse(l).msg === 'tool ok'));
  assert.ok(!stderr.includes('stdio-secret-token'), 'token never logged');
});
