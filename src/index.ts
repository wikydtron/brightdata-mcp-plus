#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, VERSION, type Config } from './config.js';
import { BrightDataClient } from './http/client.js';
import { startHttpServer } from './http/server.js';
import { createLogger, type Logger } from './logger.js';
import { createSession } from './server.js';
import { disposeSharedRenderer } from './services/render.js';
import { ensureZones } from './services/zones.js';
import { ALL_TOOLS, GROUPS } from './tools/index.js';
import { Redactor } from './util/redact.js';

const HELP = `brightdata-mcp-plus ${VERSION}

Usage: brightdata-mcp-plus [options]

  --transport stdio|http   Transport (default stdio; env MCP_TRANSPORT)
  --host <host>            HTTP bind address (default 127.0.0.1; env HOST)
  --port <port>            HTTP port (default 3000; env PORT)
  --groups a,b             Tool groups (env GROUPS): ${Object.keys(GROUPS).join(', ')}
  --tools a,b              Individual tools (env TOOLS)
  --fetch auto|direct|brightdata
                           Page fetching (env FETCH_STRATEGY, default auto: free direct
                           fetch first, Bright Data only when blocked)
  --check                  Verify the API token and zones, then exit
  --list-tools             Print the available tools, then exit
  --version | --help

Without API_TOKEN the server runs in free mode (direct fetching tools only).

Key environment variables: API_TOKEN, FETCH_STRATEGY, WEB_UNLOCKER_ZONE, BROWSER_ZONE,
BUDGET_MAX_REQUESTS, MAX_RECORDS_PER_RUN, RATE_LIMIT, CACHE_TTL, MAX_OUTPUT_CHARS, LOG_LEVEL.
See README.md for the full list.`;

async function check(config: Config, logger: Logger, redactor: Redactor): Promise<number> {
  if (!config.apiToken) {
    process.stderr.write('API_TOKEN is not set\n');
    return 1;
  }
  const client = new BrightDataClient({
    baseUrl: config.apiBaseUrl, token: config.apiToken, timeoutMs: 15_000, maxRetries: 1, concurrency: 2, redactor, logger,
  });
  const report = await ensureZones(client, {
    unlockerZone: config.unlockerZone, browserZone: config.browserZone, autoCreate: false,
    needBrowser: true, timeoutMs: 15_000, logger,
  });
  const ok = !report.error;
  process.stdout.write(`${JSON.stringify({ ok, api: config.apiBaseUrl, zones: {
    [config.unlockerZone]: report.unlocker, [config.browserZone]: report.browser,
  }, ...(report.error ? { error: redactor.redact(report.error) } : {}) }, null, 2)}\n`);
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(`${HELP}\n`);
  if (argv.includes('--version')) return void process.stdout.write(`${VERSION}\n`);
  if (argv.includes('--list-tools')) {
    for (const t of ALL_TOOLS) process.stdout.write(`${t.name.padEnd(36)} ${t.title}\n`);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(process.env, argv);
  } catch (e) {
    process.stderr.write(`Invalid configuration: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const redactor = new Redactor();
  redactor.add(config.apiToken);
  redactor.add(config.httpAuthSecret);
  const logger = createLogger(config.logLevel, redactor);
  process.on('unhandledRejection', (e) => logger.error('unhandled rejection', { error: e instanceof Error ? e.message : String(e) }));

  if (argv.includes('--check')) process.exit(await check(config, logger, redactor));

  if (config.transport === 'http') {
    const http = await startHttpServer(config, logger, redactor);
    const stop = async (signal: string) => {
      logger.info('shutting down', { signal });
      await http.close();
      await disposeSharedRenderer();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
    return;
  }

  if (!config.apiToken) {
    logger.warn('API_TOKEN is not set: running in free mode (direct fetching only, no search/scrapers). '
      + 'Get a token at https://brightdata.com/cp/setting/users');
  }
  const session = createSession({ config, token: config.apiToken, logger, redactor });
  void session.services.zones();
  await session.server.connect(new StdioServerTransport());
  logger.info('server started', { transport: 'stdio', version: VERSION, tools: session.tools.length });

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    await session.dispose();
    await disposeSharedRenderer();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.stdin.once('end', () => void stop('stdin closed'));
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
