import type { BrightDataClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { UsageMeter } from '../usage.js';
import { BdError, toBdError } from '../errors.js';
import { TtlCache } from '../util/cache.js';
import { sleep } from '../util/async.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING = new Set(['starting', 'running', 'building', 'collecting', 'digesting']);
const DISCOVER = 'discover_by_';

export interface CatalogEntry {
  dataset_id: string;
  name: string;
  domain: string;
  collection_methods: string[];
}

export interface ScoredEntry extends CatalogEntry {
  score: number;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'on', 'in', 'from', 'by', 'and', 'data', 'scraper', 'scrape', 'get', 'api']);

const norm = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_.]+/).flatMap((t) => t.split('.')).filter((t) => t && !STOPWORDS.has(t)).map(norm);
}

/**
 * Relevance score for a catalog entry: exact dataset_id wins outright; domain
 * hits outrank name hits; whole-word matches outrank prefixes and substrings;
 * entries matching every query word get a bonus.
 */
export function scoreEntry(entry: CatalogEntry, query: string): number {
  const raw = query.trim().toLowerCase();
  if (raw.startsWith('gd_')) return entry.dataset_id.toLowerCase() === raw ? 1000 : entry.dataset_id.toLowerCase().includes(raw) ? 500 : 0;
  const words = tokenize(raw);
  if (!words.length) return 0;
  const domain = entry.domain.toLowerCase().replace(/^www\./, '');
  const domainTokens = new Set(tokenize(domain));
  const nameTokens = tokenize(entry.name);
  const nameText = entry.name.toLowerCase();
  let score = 0;
  let matched = 0;
  for (const w of words) {
    let s = 0;
    if (domain === w || domainTokens.has(w)) s = 6;
    else if (nameTokens.includes(w)) s = 4;
    else if (nameTokens.some((t) => t.startsWith(w) || w.startsWith(t) && t.length >= 4)) s = 2;
    else if (nameText.includes(w) || domain.includes(w)) s = 1;
    if (s) matched++;
    score += s;
  }
  if (matched === words.length && words.length > 1) score += 3;
  if (raw.includes('.') && domain === raw.replace(/^www\./, '')) score += 10;
  return score;
}

export interface MethodDetails {
  dataset_id: string;
  name: string;
  domain: string;
  description: string | null;
  method: string;
  source: 'api' | 'docs';
  input_fields: Array<{ name: string; type?: string | undefined; required: boolean; description?: string | undefined }>;
  output_fields: Array<{ name: string; description?: string | undefined }>;
  sample_input: unknown[] | null;
  notes: string[];
}

type RawMethod = {
  input_schema?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
  output_fields?: Array<{ name: string; description?: string }>;
  sample_input?: unknown[];
};

/** Bright Data's public scraper catalog with daily refresh and stale-on-error. */
export class ScraperCatalog {
  private entries: CatalogEntry[] | null = null;
  private loadedAt = 0;
  private loading: Promise<CatalogEntry[]> | null = null;
  private readonly details = new TtlCache<{ source: 'api' | 'docs'; methods: Record<string, RawMethod>; description: string | null }>(DAY_MS, 500);

  constructor(private readonly opts: { client: BrightDataClient; docsBaseUrl: string; logger: Logger; ttlMs?: number }) {}

  async load(force = false, signal?: AbortSignal): Promise<CatalogEntry[]> {
    const ttl = this.opts.ttlMs ?? DAY_MS;
    if (this.entries && !force && Date.now() - this.loadedAt < ttl) return this.entries;
    this.loading ??= (async () => {
      try {
        const res = await this.opts.client.request<{ scrapers?: unknown[] }>({
          path: `${this.opts.docsBaseUrl}/scrapers.json`, auth: false, what: 'Loading scraper catalog',
          ...(signal ? { signal } : {}),
        });
        if (!Array.isArray(res.data?.scrapers)) throw new BdError('upstream', 'scrapers.json has no scrapers list');
        this.entries = res.data.scrapers.map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return {
            dataset_id: String(o.dataset_id ?? ''),
            name: String(o.name ?? '').trim(),
            domain: String(o.domain ?? ''),
            collection_methods: Array.isArray(o.collection_methods) ? o.collection_methods.map(String) : [],
          };
        }).filter((e) => e.dataset_id);
        this.loadedAt = Date.now();
        return this.entries;
      } catch (e) {
        if (this.entries && !force) {
          this.opts.logger.warn('catalog refresh failed; serving stale copy', { error: toBdError(e).message });
          return this.entries;
        }
        throw e;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<ScoredEntry[]> {
    const list = await this.load(false, signal);
    return list
      .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async getDetails(datasetId: string, method: string, signal?: AbortSignal): Promise<MethodDetails> {
    const entry = (await this.load(false, signal)).find((s) => s.dataset_id === datasetId);
    if (!entry) throw new BdError('not_found', `Unknown dataset_id ${datasetId}`, { hint: 'Find valid ids with search_scrapers.' });
    const [info] = await this.details.getOrLoad(datasetId, () => this.fetchMethods(datasetId, signal));
    const raw = info.methods[method];
    if (!raw) {
      throw new BdError('bad_request', `${entry.name} has no method "${method}"`, {
        hint: `Available methods: ${Object.keys(info.methods).join(', ') || entry.collection_methods.join(', ')}`,
      });
    }
    const input_fields = (raw.input_schema ?? []).map((f) => ({ name: f.name, type: f.type, required: !!f.required, description: f.description }));
    const sample_input = info.source === 'api' && raw.sample_input?.length ? raw.sample_input : null;
    const notes: string[] = [];
    if (!sample_input) notes.push(info.source === 'api' ? 'No example input for this method.' : 'Example input unavailable: details API failed.');
    if (!input_fields.length) notes.push('This method has no documented input fields.');
    else if (!input_fields.some((f) => f.required)) notes.push('This method has no required input fields.');
    if (method.startsWith(DISCOVER)) notes.push('discover_by_* methods bill every returned record; set limit_per_input deliberately.');
    return {
      dataset_id: datasetId, name: entry.name, domain: entry.domain, description: info.description, method,
      source: info.source, input_fields,
      output_fields: (raw.output_fields ?? []).map((f) => ({ name: f.name, description: f.description })),
      sample_input, notes,
    };
  }

  private async fetchMethods(id: string, signal?: AbortSignal) {
    try {
      const res = await this.opts.client.request<unknown>({
        path: '/datasets/v3/scrapers', query: { dataset_id: id }, what: 'Loading scraper details', ...(signal ? { signal } : {}),
      });
      const ds = ([] as unknown[]).concat(res.data ?? []).find((d) => (d as { id?: string })?.id === id) as
        { scrapers?: Record<string, RawMethod>; description?: string } | undefined;
      if (!ds?.scrapers) throw new BdError('upstream', 'scraper not returned by API');
      return { source: 'api' as const, methods: ds.scrapers, description: ds.description ?? null };
    } catch (e) {
      if (toBdError(e).kind === 'cancelled') throw e;
      this.opts.logger.warn('scraper details API failed; using docs', { dataset_id: id, error: toBdError(e).message });
    }
    const res = await this.opts.client.request<{ collection_methods?: Record<string, RawMethod> }>({
      path: `${this.opts.docsBaseUrl}/scrapers/${encodeURIComponent(id)}.json`, auth: false, what: 'Loading scraper docs',
      ...(signal ? { signal } : {}),
    });
    return { source: 'docs' as const, methods: res.data?.collection_methods ?? {}, description: null };
  }
}

export type RunStatus =
  | { snapshot_id: string; status: 'running'; elapsed_s: number }
  | { snapshot_id: string; status: 'ready'; records: unknown[] };

const stripNulls = (data: unknown): unknown => JSON.parse(JSON.stringify(data, (_k, v: unknown) => (v == null ? undefined : v)));

export interface TriggerRequest {
  datasetId: string;
  method?: string | undefined;
  input: Array<Record<string, unknown>>;
  limitPerInput?: number | undefined;
  extraQuery?: Record<string, string> | undefined;
  tool: string;
  signal?: AbortSignal | undefined;
}

/**
 * Web Scraper API jobs: trigger (never retried after it may have started a
 * job), poll with cancellation and progress, and cache finished snapshots so
 * paging through results does not refetch them.
 */
export class ScraperRunner {
  private readonly snapshots = new TtlCache<unknown[]>(60 * 60 * 1000, 25);
  private readonly reservations = new Map<string, number>();

  constructor(private readonly client: BrightDataClient, private readonly meter: UsageMeter, private readonly pollMs = 2000) {}

  async trigger(req: TriggerRequest, estimatedRecords: number): Promise<string> {
    this.meter.reserve(estimatedRecords);
    const method = req.method ?? '';
    const discover = method.startsWith(DISCOVER)
      ? { type: 'discover_new', discover_by: method.slice(DISCOVER.length), limit_per_input: req.limitPerInput ?? 10 }
      : {};
    try {
      const res = await this.client.request<{ snapshot_id?: string }>({
        method: 'POST',
        path: '/datasets/v3/trigger',
        query: { dataset_id: req.datasetId, include_errors: true, ...discover, ...req.extraQuery },
        body: req.input,
        idempotent: false,
        tool: req.tool,
        headers: { 'x-mcp-dataset-id': req.datasetId, ...(method ? { 'x-mcp-method': method } : {}) },
        what: 'Triggering collection',
        ...(req.signal ? { signal: req.signal } : {}),
      });
      const id = res.data?.snapshot_id;
      if (!id) throw new BdError('upstream', 'Trigger returned no snapshot_id', { step: 'trigger' });
      this.reservations.set(id, estimatedRecords);
      return id;
    } catch (e) {
      this.meter.settle(estimatedRecords, 'scraper_records', 0);
      const err = toBdError(e, req.signal);
      throw err.step ? err : new BdError(err.kind, err.message, { ...err, step: 'trigger', cause: e });
    }
  }

  async progress(snapshotId: string, tool: string, signal?: AbortSignal): Promise<unknown> {
    const res = await this.client.request({
      path: `/datasets/v3/progress/${encodeURIComponent(snapshotId)}`, tool, what: 'Checking progress', ...(signal ? { signal } : {}),
    });
    return res.data;
  }

  async results(snapshotId: string, tool: string, signal?: AbortSignal, startedAt = Date.now()): Promise<RunStatus> {
    const cached = this.snapshots.get(snapshotId);
    if (cached) return { snapshot_id: snapshotId, status: 'ready', records: cached };
    const res = await this.client.request<unknown>({
      path: `/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}`, query: { format: 'json' }, tool,
      what: 'Fetching results', ...(signal ? { signal } : {}),
    });
    const status = (res.data as { status?: string } | undefined)?.status;
    if (res.status === 202 || (status && PENDING.has(status))) {
      return { snapshot_id: snapshotId, status: 'running', elapsed_s: Math.round((Date.now() - startedAt) / 1000) };
    }
    if (status === 'failed') throw new BdError('upstream', `Data collection failed (snapshot ${snapshotId})`, { step: 'results' });
    const records = ([] as unknown[]).concat(stripNulls(res.data) ?? []);
    this.snapshots.set(snapshotId, records);
    const reserved = this.reservations.get(snapshotId);
    if (reserved !== undefined) {
      this.reservations.delete(snapshotId);
      this.meter.settle(reserved, 'scraper_records', records.length);
    }
    return { snapshot_id: snapshotId, status: 'ready', records };
  }

  /** Triggers and waits up to waitMs, reporting progress; returns running status on timeout. */
  async run(req: TriggerRequest, estimatedRecords: number, waitMs: number,
    onProgress?: (elapsedMs: number, waitMs: number) => void): Promise<RunStatus> {
    const started = Date.now();
    const id = await this.trigger(req, estimatedRecords);
    for (;;) {
      const res = await this.results(id, req.tool, req.signal, started);
      const elapsed = Date.now() - started;
      if (res.status === 'ready' || elapsed + this.pollMs > waitMs) return res;
      onProgress?.(elapsed, waitMs);
      await sleep(this.pollMs, req.signal);
    }
  }
}

export function validateInput(details: MethodDetails, input: Array<Record<string, unknown>>): string[] {
  const required = details.input_fields.filter((f) => f.required).map((f) => f.name);
  const problems: string[] = [];
  input.forEach((row, i) => {
    const missing = required.filter((name) => row[name] === undefined || row[name] === null || row[name] === '');
    if (missing.length) problems.push(`input[${i}] is missing required field(s): ${missing.join(', ')}`);
  });
  return problems;
}

export const isDiscover = (method: string): boolean => method.startsWith(DISCOVER);
