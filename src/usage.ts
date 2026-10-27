import { BdError } from './errors.js';
import type { RateLimit } from './config.js';

export type Billable = 'unlocker_requests' | 'scraper_records' | 'dataset_records' | 'browser_navigations';

interface ToolStats {
  calls: number;
  errors: number;
  cacheHits: number;
  latencies: number[];
}

const LATENCY_WINDOW = 200;

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

/**
 * Per-session accounting: tool latency/error stats, billable units, a local
 * spending guard and a sliding-window rate limiter. Bright Data remains the
 * source of truth for billing; these numbers are estimates.
 */
export class UsageMeter {
  private readonly tools = new Map<string, ToolStats>();
  private readonly billable: Record<Billable, number> = {
    unlocker_requests: 0, scraper_records: 0, dataset_records: 0, browser_navigations: 0,
  };
  private reserved = 0;
  private callTimes: number[] = [];
  private directFetches = 0;
  private directMisses = 0;
  readonly startedAt = Date.now();

  constructor(private readonly opts: {
    budgetMaxRequests: number;
    pricePer1k: number;
    rateLimit: RateLimit | null;
    now?: () => number;
  }) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Throws when RATE_LIMIT would be exceeded; applies to every tool. */
  checkRateLimit(): void {
    const rl = this.opts.rateLimit;
    if (!rl) return;
    const now = this.now;
    this.callTimes = this.callTimes.filter((t) => t > now - rl.windowMs);
    if (this.callTimes.length >= rl.limit) {
      const retryIn = Math.ceil((this.callTimes[0]! + rl.windowMs - now) / 1000);
      throw new BdError('rate_limited', `Local rate limit ${rl.display} reached; retry in ~${retryIn}s`, {
        hint: 'This limit is set by RATE_LIMIT in the server config.',
      });
    }
    this.callTimes.push(now);
  }

  /**
   * Reserves billable units before an upstream call so parallel calls cannot
   * overshoot the budget together. Release unused units with `settle`.
   */
  reserve(units: number): void {
    const max = this.opts.budgetMaxRequests;
    if (max > 0 && this.totalBillable() + this.reserved + units > max) {
      throw new BdError('budget', `This call needs up to ${units} billable unit(s), but only `
        + `${Math.max(0, max - this.totalBillable() - this.reserved)} of BUDGET_MAX_REQUESTS=${max} remain this session.`);
    }
    this.reserved += units;
  }

  settle(reservedUnits: number, kind: Billable, actualUnits: number): void {
    this.reserved = Math.max(0, this.reserved - reservedUnits);
    this.billable[kind] += actualUnits;
  }

  record(tool: string, ms: number, ok: boolean, cacheHit = false): void {
    let s = this.tools.get(tool);
    if (!s) {
      s = { calls: 0, errors: 0, cacheHits: 0, latencies: [] };
      this.tools.set(tool, s);
    }
    s.calls++;
    if (!ok) s.errors++;
    if (cacheHit) s.cacheHits++;
    s.latencies.push(ms);
    if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
  }

  /** A free direct fetch that worked (true) or had to be abandoned (false). */
  recordDirect(ok: boolean): void {
    if (ok) this.directFetches++;
    else this.directMisses++;
  }

  totalBillable(): number {
    return this.billable.unlocker_requests + this.billable.scraper_records + this.billable.dataset_records;
  }

  snapshot() {
    const billableResults = this.totalBillable();
    return {
      uptime_s: Math.round((this.now - this.startedAt) / 1000),
      billable: { ...this.billable },
      estimated_cost_usd: Number(((billableResults / 1000) * this.opts.pricePer1k).toFixed(4)),
      free: {
        direct_fetches: this.directFetches,
        direct_misses: this.directMisses,
        estimated_savings_usd: Number(((this.directFetches / 1000) * this.opts.pricePer1k).toFixed(4)),
      },
      budget: this.opts.budgetMaxRequests > 0
        ? { max: this.opts.budgetMaxRequests, used: billableResults, remaining: Math.max(0, this.opts.budgetMaxRequests - billableResults) }
        : null,
      tools: Object.fromEntries([...this.tools].map(([name, s]) => [name, {
        calls: s.calls,
        errors: s.errors,
        cache_hits: s.cacheHits,
        p50_ms: percentile(s.latencies, 50),
        p95_ms: percentile(s.latencies, 95),
      }])),
    };
  }
}
