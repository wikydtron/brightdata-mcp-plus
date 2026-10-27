export type ErrorKind =
  | 'usage_limit'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'cancelled'
  | 'budget'
  | 'config'
  | 'blocked'
  | 'internal';

export const USAGE_LIMIT_CODE = 'client_10100';

const HINTS: Partial<Record<ErrorKind, string>> = {
  usage_limit:
    'Your Bright Data account has used its free monthly requests. Check usage and plan at '
    + 'https://brightdata.com/cp or https://docs.brightdata.com/general/account/billing-and-pricing/free-tier',
  auth: 'Check API_TOKEN. It must be a valid Bright Data API key (admin permissions are needed to auto-create zones).',
  rate_limited: 'Bright Data is rate limiting this account. Wait a moment and retry with fewer parallel calls.',
  timeout: 'The upstream request timed out. Retry, or raise BASE_TIMEOUT.',
  network: 'Could not reach the Bright Data API. Check network connectivity and proxies.',
  budget: 'A local spending guard stopped this call. Raise BUDGET_MAX_REQUESTS / MAX_RECORDS_PER_RUN to allow it.',
};

export class BdError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly hint: string | undefined;
  readonly step: string | undefined;

  constructor(kind: ErrorKind, message: string, opts: {
    status?: number;
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    hint?: string;
    step?: string;
    cause?: unknown;
  } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'BdError';
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.hint = opts.hint ?? HINTS[kind];
    this.step = opts.step;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Maps an HTTP error response from the Bright Data API to a typed error. */
export function classifyHttpError(status: number, headers: Headers, body: string, what: string): BdError {
  const code = headers.get('x-brd-err-code') ?? undefined;
  const detail = headers.get('x-brd-err-msg') ?? body;
  const message = `${what} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`;
  const common = { status, ...(code ? { code } : {}) };
  if (code === USAGE_LIMIT_CODE) return new BdError('usage_limit', message, common);
  if (status === 401 || status === 403) return new BdError('auth', message, common);
  if (status === 404) return new BdError('not_found', message, common);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
    return new BdError('rate_limited', message, {
      ...common, retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 408) return new BdError('timeout', message, { ...common, retryable: true });
  if (status >= 500) return new BdError('upstream', message, { ...common, retryable: true });
  if (status === 422 && /zone/i.test(body)) {
    return new BdError('config', message, {
      ...common,
      hint: 'The configured zone does not exist. Set AUTO_CREATE_ZONES=true or create the zone in the control panel.',
    });
  }
  return new BdError('bad_request', message, common);
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

/** Normalises anything thrown into a BdError. */
export function toBdError(e: unknown, signal?: AbortSignal): BdError {
  if (e instanceof BdError) return e;
  if (signal?.aborted) return new BdError('cancelled', 'The request was cancelled', { cause: e });
  if (e instanceof Error && e.name === 'TimeoutError') return new BdError('timeout', 'The request timed out', { retryable: true, cause: e });
  if (isAbortError(e)) return new BdError('cancelled', 'The request was cancelled', { cause: e });
  if (e instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(`${e.message} ${String(e.cause ?? '')}`)) {
    return new BdError('network', `Network error: ${String((e.cause as Error | undefined)?.message ?? e.message)}`, { retryable: true, cause: e });
  }
  return new BdError('internal', e instanceof Error ? e.message : String(e), { cause: e });
}

/** Text shown to the model: kind, message and an actionable hint. */
export function formatError(err: BdError): string {
  const lines = [`[${err.kind}] ${err.message}`];
  if (err.step) lines.push(`Failed step: ${err.step}`);
  if (err.hint) lines.push(`Hint: ${err.hint}`);
  return lines.join('\n');
}
