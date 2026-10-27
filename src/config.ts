import { z } from 'zod';
import { DEFAULT_USER_AGENT } from './services/direct.js';

export const VERSION = '1.2.1';
export const PACKAGE_NAME = 'brightdata-mcp-plus';

export interface RateLimit {
  limit: number;
  windowMs: number;
  display: string;
}

export interface Config {
  apiToken: string | undefined;
  apiBaseUrl: string;
  docsBaseUrl: string;
  unlockerZone: string;
  browserZone: string;
  autoCreateZones: boolean;
  fetchStrategy: 'auto' | 'direct' | 'brightdata';
  directTimeoutMs: number;
  directMaxBytes: number;
  directUserAgent: string;
  directAllowPrivate: boolean;
  localRender: boolean;
  chromePath: string | undefined;
  localRenderTimeoutMs: number;
  localRenderOn: string[];
  localRenderIdleMs: number;
  localRenderConcurrency: number;
  groups: string[];
  tools: string[];
  rateLimit: RateLimit | null;
  requestTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  budgetMaxRequests: number;
  maxRecordsPerRun: number;
  pricePer1k: number;
  maxOutputChars: number;
  contentGate: boolean;
  contentGateTimeoutMs: number;
  browserFilteredSnapshot: boolean;
  browserIdleTimeoutMs: number;
  maxBrowserSessions: number;
  browserCdpEndpoint: string | undefined;
  transport: 'stdio' | 'http';
  httpHost: string;
  httpPort: number;
  httpAuthSecret: string | undefined;
  httpSessionIdleMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export function parseRateLimit(value: string | undefined): RateLimit | null {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)([smh])$/.exec(value.trim());
  if (!match) throw new Error(`Invalid RATE_LIMIT "${value}". Use e.g. 100/1h, 50/30m or 10/5s`);
  const [, limit, amount, unit] = match;
  const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return { limit: Number(limit), windowMs: Number(amount) * multiplier, display: value.trim() };
}

const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
};

const intInRange = (name: string, min: number, max: number) =>
  z.coerce.number({ error: (iss) => (iss.code === 'invalid_type' ? `${name} must be a number` : undefined) }).int().min(min).max(max);

/** Parses `--flag value` and `--flag=value` style arguments. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i++;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

/**
 * Builds the config from environment variables (names are compatible with the
 * upstream @brightdata/mcp server) and CLI flags, validating every value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): Config {
  const args = parseArgs(argv);
  const arg = (name: string): string | undefined => {
    const v = args[name];
    return typeof v === 'string' ? v : undefined;
  };
  const seconds = (name: string, fallback: number, min: number, max: number, value?: string) =>
    intInRange(name, min, max).parse(value ?? fallback) * 1000;

  const transport = z.enum(['stdio', 'http']).parse(arg('transport') ?? env.MCP_TRANSPORT ?? 'stdio');
  return {
    apiToken: env.API_TOKEN?.trim() || undefined,
    // sessions without a token always use "direct" (free mode), whatever this says
    fetchStrategy: z.enum(['auto', 'direct', 'brightdata']).parse((arg('fetch') ?? env.FETCH_STRATEGY ?? 'auto').toLowerCase()),
    directTimeoutMs: seconds('DIRECT_TIMEOUT', 15, 1, 600, env.DIRECT_TIMEOUT),
    directMaxBytes: intInRange('DIRECT_MAX_BYTES', 10_000, 100_000_000).parse(env.DIRECT_MAX_BYTES ?? 10_000_000),
    directUserAgent: env.DIRECT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    directAllowPrivate: bool(env.DIRECT_ALLOW_PRIVATE, false),
    localRender: bool(env.LOCAL_RENDER, true),
    chromePath: env.CHROME_PATH?.trim() || undefined,
    localRenderTimeoutMs: seconds('LOCAL_RENDER_TIMEOUT', 25, 3, 300, env.LOCAL_RENDER_TIMEOUT),
    localRenderOn: list(env.LOCAL_RENDER_ON ?? 'needs_javascript,empty'),
    localRenderIdleMs: seconds('LOCAL_RENDER_IDLE', 120, 5, 86_400, env.LOCAL_RENDER_IDLE),
    localRenderConcurrency: intInRange('LOCAL_RENDER_CONCURRENCY', 1, 16).parse(env.LOCAL_RENDER_CONCURRENCY ?? 2),
    apiBaseUrl: (env.BRIGHTDATA_API_URL ?? 'https://api.brightdata.com').replace(/\/+$/, ''),
    docsBaseUrl: (env.BRIGHTDATA_DOCS_URL ?? 'https://docs.brightdata.com').replace(/\/+$/, ''),
    unlockerZone: env.WEB_UNLOCKER_ZONE?.trim() || 'mcp_unlocker',
    browserZone: env.BROWSER_ZONE?.trim() || 'mcp_browser',
    autoCreateZones: bool(env.AUTO_CREATE_ZONES, true),
    groups: list(arg('groups') ?? env.GROUPS).map((g) => g.toLowerCase()),
    tools: list(arg('tools') ?? env.TOOLS),
    rateLimit: parseRateLimit(env.RATE_LIMIT),
    requestTimeoutMs: seconds('BASE_TIMEOUT', 90, 1, 3600, env.BASE_TIMEOUT),
    maxRetries: intInRange('BASE_MAX_RETRIES', 0, 5).parse(env.BASE_MAX_RETRIES ?? 2),
    maxConcurrency: intInRange('MAX_CONCURRENCY', 1, 50).parse(env.MAX_CONCURRENCY ?? 5),
    cacheTtlMs: seconds('CACHE_TTL', 300, 0, 86_400, env.CACHE_TTL),
    cacheMaxEntries: intInRange('CACHE_MAX_ENTRIES', 1, 100_000).parse(env.CACHE_MAX_ENTRIES ?? 200),
    budgetMaxRequests: intInRange('BUDGET_MAX_REQUESTS', 0, 10_000_000).parse(env.BUDGET_MAX_REQUESTS ?? 0),
    maxRecordsPerRun: intInRange('MAX_RECORDS_PER_RUN', 1, 1_000_000).parse(env.MAX_RECORDS_PER_RUN ?? 200),
    pricePer1k: z.coerce.number().min(0).parse(env.PRICE_PER_1K ?? 1.5),
    maxOutputChars: intInRange('MAX_OUTPUT_CHARS', 1_000, 5_000_000).parse(env.MAX_OUTPUT_CHARS ?? 60_000),
    contentGate: env.CONTENT_GATE !== 'off',
    contentGateTimeoutMs: seconds('CONTENT_GATE_TIMEOUT', 120, 5, 3600, env.CONTENT_GATE_TIMEOUT),
    browserFilteredSnapshot: env.BROWSER_FILTERED_SNAPSHOT === 'on',
    browserIdleTimeoutMs: seconds('BROWSER_IDLE_TIMEOUT', 300, 10, 86_400, env.BROWSER_IDLE_TIMEOUT),
    maxBrowserSessions: intInRange('MAX_BROWSER_SESSIONS', 1, 50).parse(env.MAX_BROWSER_SESSIONS ?? 3),
    browserCdpEndpoint: env.BROWSER_CDP_ENDPOINT?.trim() || undefined,
    transport,
    httpHost: arg('host') ?? env.HOST ?? '127.0.0.1',
    httpPort: intInRange('PORT', 0, 65_535).parse(arg('port') ?? env.PORT ?? 3000),
    httpAuthSecret: env.HTTP_AUTH_SECRET?.trim() || undefined,
    httpSessionIdleMs: seconds('HTTP_SESSION_IDLE_TIMEOUT', 1800, 30, 86_400, env.HTTP_SESSION_IDLE_TIMEOUT),
    logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).parse(
      (env.LOG_LEVEL ?? 'info').toLowerCase()),
  };
}
