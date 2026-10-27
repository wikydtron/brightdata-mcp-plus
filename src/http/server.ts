import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { VERSION, type Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createSession, type Session } from '../server.js';
import type { Redactor } from '../util/redact.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Entry {
  transport: StreamableHTTPServerTransport;
  session: Session;
  lastSeen: number;
}

export interface HttpHandle {
  url: string;
  sessions: () => number;
  close(): Promise<void>;
}

const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const rpcError = (message: string, code = -32000) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function tokenFrom(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || undefined;
  const header = req.headers['x-brightdata-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return url.searchParams.get('token')?.trim() || undefined;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Streamable HTTP transport. Each MCP session gets its own isolated server
 * (token, cache, budget, browser). The Bright Data token comes from the
 * Authorization header (preferred), x-brightdata-token, ?token= (compatible
 * with the hosted URL format) or the server's API_TOKEN.
 */
export async function startHttpServer(config: Config, logger: Logger, redactor: Redactor,
  extra: { fetchImpl?: typeof fetch } = {}): Promise<HttpHandle> {
  const loopback = isLoopback(config.httpHost);
  if (!loopback && config.apiToken && !config.httpAuthSecret) {
    throw new Error('Refusing to serve a shared API_TOKEN on a non-loopback interface without HTTP_AUTH_SECRET');
  }
  const sessions = new Map<string, Entry>();
  const allowedHosts: string[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok', version: VERSION, sessions: sessions.size });
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
    if (config.httpAuthSecret) {
      const given = req.headers['x-mcp-auth'];
      if (typeof given !== 'string' || !safeEqual(given, config.httpAuthSecret)) return sendJson(res, 401, rpcError('Unauthorized'));
    }

    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const entry = sessions.get(sid);
      if (!entry) return sendJson(res, 404, rpcError('Session not found', -32001));
      entry.lastSeen = Date.now();
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      await entry.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') return sendJson(res, 400, rpcError('Missing mcp-session-id header'));
    const body = await readJson(req);
    if (!isInitializeRequest(body)) return sendJson(res, 400, rpcError('The first request of a session must be initialize'));

    const token = tokenFrom(req, url) ?? config.apiToken;
    if (!token) return sendJson(res, 401, rpcError('Provide a Bright Data API token: Authorization: Bearer <token>'));
    if (url.searchParams.has('token')) logger.warn('API token passed in the URL; prefer the Authorization header (URLs end up in logs)');
    redactor.add(token);
    const list = (key: string) => url.searchParams.get(key)?.split(',').map((s) => s.trim()).filter(Boolean);
    const session = createSession({
      config: { ...config, groups: list('groups') ?? config.groups, tools: list('tools') ?? config.tools },
      token, logger, redactor, ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
    });
    void session.services.zones();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, session, lastSeen: Date.now() });
        logger.info('http session opened', { mcpSession: id, tools: session.tools.length });
      },
      ...(loopback ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) logger.info('http session closed', { mcpSession: id });
      void session.dispose();
    };
    await session.server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) logger.error('http handler failed', { error: e instanceof Error ? e.message : String(e) });
      sendJson(res, status, rpcError(status === 500 ? 'Internal server error' : (e as Error).message));
    });
  });

  const reaper = setInterval(() => {
    const cutoff = Date.now() - config.httpSessionIdleMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        logger.info('closing idle http session', { mcpSession: id });
        void entry.transport.close();
      }
    }
  }, Math.min(60_000, config.httpSessionIdleMs));
  reaper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`);
  const url = `http://${config.httpHost.includes(':') ? `[${config.httpHost}]` : config.httpHost}:${port}/mcp`;
  logger.info('http transport listening', { url, version: VERSION });

  return {
    url,
    sessions: () => sessions.size,
    async close() {
      clearInterval(reaper);
      await Promise.all([...sessions.values()].map((e) => e.transport.close().catch(() => undefined)));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
