import { PACKAGE_NAME, VERSION } from '../config.js';
import { BdError, classifyHttpError, toBdError } from '../errors.js';
import type { Logger } from '../logger.js';
import { Semaphore, sleep, withTimeout } from '../util/async.js';
import { clip, type Redactor } from '../util/redact.js';

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Path relative to the API base URL, or an absolute URL. */
  path: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: 'json' | 'text';
  timeoutMs?: number;
  /**
   * Safe to repeat after the server may have processed it. Non-idempotent
   * requests (job triggers) are only retried when the server explicitly
   * rejected them (429), so a retry can never start a second billed job.
   */
  idempotent?: boolean;
  /** Send the Bearer token (false for public docs endpoints). */
  auth?: boolean;
  signal?: AbortSignal;
  /** Tool name, sent as x-mcp-tool and used in error messages. */
  tool?: string;
  /** Human-readable description for error messages. */
  what?: string;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  redactor: Redactor;
  logger: Logger;
  clientName?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** Base delay for exponential backoff; overridable for tests. */
  backoffBaseMs?: number;
}

const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The single gateway to the Bright Data API: auth and telemetry headers,
 * timeouts, cancellation, bounded concurrency, retries with jittered
 * exponential backoff (honouring Retry-After), and typed, redacted errors.
 */
export class BrightDataClient {
  readonly semaphore: Semaphore;
  upstreamCalls = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.semaphore = new Semaphore(opts.concurrency);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get token(): string {
    return this.opts.token;
  }

  async request<T = unknown>(req: RequestOptions): Promise<ApiResponse<T>> {
    const method = req.method ?? 'GET';
    const idempotent = req.idempotent ?? method !== 'POST';
    const url = this.buildUrl(req.path, req.query);
    const what = req.what ?? `${method} ${new URL(url).pathname}`;
    const maxRetries = this.opts.maxRetries;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.semaphore.run(() => this.once<T>(req, method, url, what), req.signal);
      } catch (e) {
        const err = toBdError(e, req.signal);
        const retryable = err.retryable && (idempotent || err.kind === 'rate_limited');
        if (!retryable || attempt >= maxRetries) throw err;
        const delay = this.backoff(attempt, err.retryAfterMs);
        this.opts.logger.warn('retrying upstream request', {
          what, attempt: attempt + 1, delayMs: delay, kind: err.kind, status: err.status,
        });
        await sleep(delay, req.signal);
      }
    }
  }

  private async once<T>(req: RequestOptions, method: string, url: string, what: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'user-agent': `${PACKAGE_NAME}/${VERSION}`,
      accept: req.responseType === 'text' ? '*/*' : 'application/json',
      ...req.headers,
    };
    if (req.auth !== false) headers.authorization = `Bearer ${this.opts.token}`;
    const clientName = this.opts.clientName?.();
    if (clientName && req.auth !== false) headers['x-mcp-client-name'] = clientName;
    if (req.tool && req.auth !== false) headers['x-mcp-tool'] = req.tool;
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    this.upstreamCalls++;
    const started = Date.now();
    const signal = withTimeout(req.timeoutMs ?? this.opts.timeoutMs, req.signal);
    const res = await this.fetchImpl(url, { method, headers, body, signal });
    const text = await res.text();
    this.opts.logger.debug('upstream response', { what, status: res.status, ms: Date.now() - started, bytes: text.length });
    if (!res.ok) {
      throw classifyHttpError(res.status, res.headers, clip(this.opts.redactor.redact(text.trim()), 600), what);
    }
    if (req.responseType === 'text') return { status: res.status, headers: res.headers, data: text as T };
    if (!text) return { status: res.status, headers: res.headers, data: undefined as T };
    try {
      return { status: res.status, headers: res.headers, data: JSON.parse(text) as T };
    } catch (cause) {
      throw new BdError('upstream', `${what} returned invalid JSON: ${clip(text, 200)}`, { status: res.status, cause });
    }
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(/^https?:\/\//.test(path) ? path : `${this.opts.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    const base = this.opts.backoffBaseMs ?? 500;
    const exp = Math.min(MAX_BACKOFF_MS, base * 2 ** attempt);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }
}
