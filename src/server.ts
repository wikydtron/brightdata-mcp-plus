import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { PACKAGE_NAME, VERSION, type Config } from './config.js';
import { BdError, formatError, toBdError } from './errors.js';
import { BrightDataClient } from './http/client.js';
import type { Logger } from './logger.js';
import { INSTRUCTIONS, registerPrompts } from './prompts.js';
import { gateItems } from './security/contentGate.js';
import { wrapUntrusted } from './security/untrusted.js';
import { BrowserManager } from './services/browser.js';
import { DatasetService } from './services/datasets.js';
import { PageFetcher } from './services/pages.js';
import { ScraperCatalog, ScraperRunner } from './services/scrapers.js';
import { Unlocker } from './services/unlocker.js';
import { ensureZones, type ZoneReport } from './services/zones.js';
import { selectTools } from './tools/index.js';
import type { Services, ToolContext, ToolSpec } from './tools/types.js';
import { UsageMeter } from './usage.js';
import { TtlCache } from './util/cache.js';
import { clip, type Redactor } from './util/redact.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface SessionOptions {
  config: Config;
  /** Bright Data token; without one the session runs in free mode (direct fetching only). */
  token: string | undefined;
  logger: Logger;
  redactor: Redactor;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  backoffBaseMs?: number;
  pollMs?: number;
}

export interface Session {
  id: string;
  server: McpServer;
  services: Services;
  tools: string[];
  dispose(): Promise<void>;
}

// One zone check per (API, token), shared by every session that uses it.
const zoneChecks = new Map<string, Promise<ZoneReport>>();

/**
 * Builds a fully isolated MCP server: its own API client, cache, budget,
 * browser sessions and client capabilities. stdio uses one; the HTTP
 * transport creates one per MCP session, so tenants never share state.
 */
export function createSession(opts: SessionOptions): Session {
  const { config, redactor } = opts;
  const token = opts.token ?? '';
  redactor.add(token);
  const freeMode = !token;
  const id = randomUUID().slice(0, 8);
  const logger = opts.logger.child({ session: id });
  const server = new McpServer(
    { name: PACKAGE_NAME, version: VERSION, title: 'Bright Data (plus)' },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  const client = new BrightDataClient({
    baseUrl: config.apiBaseUrl, token, timeoutMs: config.requestTimeoutMs, maxRetries: config.maxRetries,
    concurrency: config.maxConcurrency, redactor, logger,
    clientName: () => server.server.getClientVersion()?.name,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.backoffBaseMs !== undefined ? { backoffBaseMs: opts.backoffBaseMs } : {}),
  });
  const picked = selectTools(config.groups, config.tools);
  if (picked.unknown.length) logger.warn('ignoring unknown GROUPS/TOOLS entries', { unknown: picked.unknown });
  // free mode keeps only tools that work without Bright Data (browser tools need a local CDP endpoint)
  const selected = freeMode
    ? picked.selected.filter((t) => t.free || (t.name.startsWith('scraping_browser_') && !!config.browserCdpEndpoint))
    : picked.selected;
  if (freeMode) logger.info('no API_TOKEN: free mode, direct fetching only', { tools: selected.length });
  const needBrowser = selected.some((t) => t.name.startsWith('scraping_browser_'));

  const zoneKey = `${config.apiBaseUrl}|${createHash('sha256').update(token).digest('hex')}|${config.unlockerZone}|${config.browserZone}|${needBrowser}`;
  const zones = (): Promise<ZoneReport> => {
    if (freeMode) return Promise.resolve({ unlocker: 'missing', browser: 'missing', error: 'API_TOKEN not set (free mode)' });
    let check = zoneChecks.get(zoneKey);
    if (!check) {
      check = ensureZones(client, {
        unlockerZone: config.unlockerZone, browserZone: config.browserZone, autoCreate: config.autoCreateZones,
        needBrowser, timeoutMs: Math.min(15_000, config.requestTimeoutMs), logger,
      });
      zoneChecks.set(zoneKey, check);
      // a failed check is retried by the next session instead of being cached forever
      void check.then((r) => { if (r.error) zoneChecks.delete(zoneKey); });
    }
    return check;
  };

  const meter = new UsageMeter({ budgetMaxRequests: config.budgetMaxRequests, pricePer1k: config.pricePer1k, rateLimit: config.rateLimit });
  const cache = new TtlCache<string>(config.cacheTtlMs, config.cacheMaxEntries);
  const unlocker = new Unlocker(client, config.unlockerZone, cache, meter, zones);
  const services: Services = {
    config, client, meter, cache, logger, redactor, zones, unlocker,
    pages: new PageFetcher({
      strategy: freeMode ? 'direct' : config.fetchStrategy,
      direct: {
        timeoutMs: config.directTimeoutMs, maxBytes: config.directMaxBytes,
        userAgent: config.directUserAgent, allowPrivate: config.directAllowPrivate,
      },
      unlocker: freeMode ? null : unlocker,
      meter, logger, cacheTtlMs: config.cacheTtlMs, cacheMaxEntries: config.cacheMaxEntries,
    }),
    catalog: new ScraperCatalog({ client, docsBaseUrl: config.docsBaseUrl, logger }),
    runner: new ScraperRunner(client, meter, opts.pollMs),
    datasets: new DatasetService(client, meter),
    browser: new BrowserManager({
      client, zone: config.browserZone, cdpEndpoint: config.browserCdpEndpoint, idleTimeoutMs: config.browserIdleTimeoutMs,
      maxSessions: config.maxBrowserSessions, meter, redactor, logger, zonesReady: zones,
    }),
  };

  for (const spec of selected) registerTool(server, spec, services, logger);
  registerPrompts(server);

  return {
    id,
    server,
    services,
    tools: selected.map((t) => t.name),
    async dispose() {
      await services.browser.dispose();
      await server.close().catch(() => undefined);
    },
  };
}

function registerTool(server: McpServer, spec: ToolSpec, svc: Services, logger: Logger): void {
  const handler = async (args: Record<string, unknown>, extra: Extra) => {
    const started = Date.now();
    try {
      svc.meter.checkRateLimit();
      const ctx = makeContext(server, spec.name, svc, extra, logger);
      const result = await spec.handler(args as never, ctx, svc);
      const ms = Date.now() - started;
      if ('content' in result) {
        svc.meter.record(spec.name, ms, true);
        logger.info('tool ok', { tool: spec.name, ms });
        return { content: result.content };
      }
      svc.meter.record(spec.name, ms, true, result.cacheHit);
      logger.info('tool ok', { tool: spec.name, ms, cacheHit: !!result.cacheHit, chars: result.text.length });
      const body = spec.untrusted ? wrapUntrusted(result.text) : result.text;
      return {
        content: [{ type: 'text' as const, text: result.note ? `${body}\n\n${result.note}` : body }],
        ...(result.structured ? { structuredContent: result.structured } : {}),
      };
    } catch (e) {
      const err = toBdError(e, extra.signal);
      const ms = Date.now() - started;
      svc.meter.record(spec.name, ms, false);
      logger.warn('tool failed', { tool: spec.name, ms, kind: err.kind, status: err.status, code: err.code, error: err.message });
      let text = clip(svc.redactor.redact(formatError(err)), 2_000);
      // HTTP error bodies can echo the target site, so they are untrusted too
      if (spec.untrusted && err.status !== undefined) text = wrapUntrusted(text);
      return { isError: true, content: [{ type: 'text' as const, text }] };
    }
  };
  server.registerTool(spec.name, {
    title: spec.title,
    description: spec.description,
    inputSchema: spec.input,
    ...(spec.output ? { outputSchema: spec.output } : {}),
    annotations: { title: spec.title, ...spec.annotations },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, handler as any);
}

function makeContext(server: McpServer, tool: string, svc: Services, extra: Extra, logger: Logger): ToolContext {
  const progressToken = extra._meta?.progressToken;
  let last = -1;
  const ctx: ToolContext = {
    signal: extra.signal,
    progress(progress, total, message) {
      if (progressToken === undefined || progress <= last) return;
      last = progress;
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) },
      }).catch(() => undefined);
    },
    async gate(items, textOf) {
      if (!svc.config.contentGate) return { items, withheld: 0 };
      const canAsk = !!server.server.getClientCapabilities()?.elicitation;
      const ask = canAsk ? async (message: string) => {
        // keep the client's tool-call timeout alive while a human decides
        const ticker = setInterval(() => ctx.progress(last + 1, undefined, 'Waiting for the user to approve returning this content'), 5_000);
        try {
          const r = await server.server.elicitInput({
            message,
            requestedSchema: {
              type: 'object',
              properties: { return_content: { type: 'boolean', title: 'Return this content to the assistant' } },
              required: ['return_content'],
            },
          }, { timeout: svc.config.contentGateTimeoutMs, signal: extra.signal });
          return r.action === 'accept' && r.content?.return_content === true;
        } finally {
          clearInterval(ticker);
        }
      } : null;
      const result = await gateItems(tool, items, textOf, ask);
      if (result.withheld) logger.warn('content gate withheld items', { tool, withheld: result.withheld, asked: canAsk });
      return result;
    },
    async sample({ system, prompt, maxTokens }) {
      if (!server.server.getClientCapabilities()?.sampling) {
        throw new BdError('config', 'This client does not support MCP sampling, which extract needs', {
          hint: 'Use scrape_as_markdown and extract the data yourself.',
        });
      }
      const r = await server.server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
        systemPrompt: system,
        maxTokens,
      }, { signal: extra.signal, timeout: svc.config.requestTimeoutMs });
      const blocks = (Array.isArray(r.content) ? r.content : [r.content]) as Array<{ type: string; text?: string }>;
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (!text) throw new BdError('upstream', 'The client model returned no text');
      return text;
    },
  };
  return ctx;
}
