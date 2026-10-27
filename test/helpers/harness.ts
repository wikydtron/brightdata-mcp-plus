import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema, ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createSession, type Session } from '../../src/server.js';
import { Redactor } from '../../src/util/redact.js';
import type { Stub } from './stub.js';

export interface Harness {
  client: Client;
  session: Session;
  call(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal; onprogress?: (p: unknown) => void }): Promise<CallToolResult>;
  text(result: CallToolResult): string;
  close(): Promise<void>;
}

/** Connects a real MCP client to a server session that talks to the stub API. */
export async function connect(stub: Stub, env: Record<string, string> = {}, caps: {
  elicit?: (message: string) => { action: 'accept' | 'decline'; content?: Record<string, unknown> };
  sample?: (prompt: string) => string;
} = {}): Promise<Harness> {
  const redactor = new Redactor();
  const config = loadConfig({
    API_TOKEN: 'e2e-token', BRIGHTDATA_API_URL: stub.url, BRIGHTDATA_DOCS_URL: stub.url, LOG_LEVEL: 'silent',
    FETCH_STRATEGY: 'brightdata', LOCAL_RENDER: 'off', ...env,
  });
  const session = createSession({ config, token: config.apiToken, logger: createLogger('silent', redactor), redactor, backoffBaseMs: 5, pollMs: 20 });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' }, {
    capabilities: { ...(caps.elicit ? { elicitation: {} } : {}), ...(caps.sample ? { sampling: {} } : {}) },
  });
  if (caps.elicit) {
    const elicit = caps.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message));
  }
  if (caps.sample) {
    const sample = caps.sample;
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      const first = req.params.messages[0]?.content as { type: string; text?: string };
      return { role: 'assistant', model: 'fake', content: { type: 'text', text: sample(first.text ?? '') } };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([session.server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    session,
    call: (name, args = {}, opts = {}) => client.callTool({ name, arguments: args }, undefined, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onprogress ? { onprogress: opts.onprogress } : {}),
    }) as Promise<CallToolResult>,
    text: (r) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n'),
    close: async () => { await client.close(); await session.dispose(); },
  };
}

/** Extracts the payload between untrusted markers. */
export function unwrap(text: string): string {
  const m = /=====UNTRUSTED_[0-9a-f]+_BEGIN=====\n([\s\S]*)\n=====UNTRUSTED_[0-9a-f]+_END=====/.exec(text);
  if (!m) throw new Error(`not wrapped: ${text.slice(0, 200)}`);
  return m[1]!;
}
