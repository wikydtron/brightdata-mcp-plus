import { z } from 'zod';
import { BdError, toBdError } from '../errors.js';
import { isDiscover, validateInput, type RunStatus } from '../services/scrapers.js';
import { defineTool, json } from './types.js';

const datasetId = z.string().regex(/^gd_[a-z0-9]+$/i, 'dataset_id looks like gd_xxxxxxxx').describe('dataset_id from search_scrapers');
const method = z.string().min(1).describe('One of the scraper collection_methods, exactly as listed (some names are misspelled on purpose)');
const snapshotId = z.string().min(1).max(100).describe('snapshot_id from run_scraper');
const recordPaging = {
  offset: z.number().int().min(0).optional().default(0).describe('Index of the first record to return'),
  limit: z.number().int().min(1).max(1000).optional().default(50).describe('Maximum records to return'),
};

/** Pages records and trims the page further if it would exceed maxChars. */
export function pageRecords(records: unknown[], offset: number, limit: number, maxChars: number) {
  let page = records.slice(offset, offset + limit);
  let text = JSON.stringify(page);
  while (page.length > 1 && text.length > maxChars) {
    page = page.slice(0, Math.max(1, Math.floor(page.length * (maxChars / text.length) * 0.9)));
    text = JSON.stringify(page);
  }
  const next = offset + page.length;
  return { total_records: records.length, offset, returned: page.length, next_offset: next < records.length ? next : null, records: page };
}

export function describeRun(res: RunStatus, offset: number, limit: number, maxChars: number) {
  if (res.status === 'running') {
    return { ...res, next: 'Still collecting. Poll get_scraper_progress, then call get_scraper_results with this snapshot_id.' };
  }
  return { snapshot_id: res.snapshot_id, status: res.status, ...pageRecords(res.records, offset, limit, maxChars) };
}

const entryShape = { dataset_id: z.string(), name: z.string(), domain: z.string(), collection_methods: z.array(z.string()), score: z.number() };

export const searchScrapers = defineTool({
  name: 'search_scrapers',
  title: 'Search Scrapers',
  description: 'Find a pre-built Bright Data scraper (Web Scraper API, 1,200+ sites) by site, domain or data type, '
    + 'e.g. "amazon reviews", "linkedin.com" or a gd_ id. Results are ranked by relevance. Next: get_scraper_details.',
  input: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional().default(10) },
  output: { query: z.string(), results: z.array(z.object(entryShape)) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  untrusted: false,
  async handler(a, ctx, svc) {
    const results = await svc.catalog.search(a.query, a.limit, ctx.signal);
    const structured = { query: a.query, results };
    return { text: results.length ? json(structured) : `No scraper matched "${a.query}". Try the site's domain or fewer words.`, structured };
  },
});

export const getScraperDetails = defineTool({
  name: 'get_scraper_details',
  title: 'Get Scraper Details',
  description: 'Show a scraper method\'s description, input fields (with required flags), example input and main output '
    + 'fields. Build run_scraper input from sample_input or input_fields.',
  input: { dataset_id: datasetId, method },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  untrusted: false,
  async handler(a, ctx, svc) {
    const details = await svc.catalog.getDetails(a.dataset_id, a.method, ctx.signal);
    return { text: json(details) };
  },
});

export const runScraper = defineTool({
  name: 'run_scraper',
  title: 'Run Scraper',
  description: 'Run a pre-built scraper. input is a list of objects shaped like sample_input, one per URL or query. '
    + 'collect_by_url returns one record per input; discover_by_* returns up to limit_per_input billed records per input. '
    + 'Required fields are checked before anything is billed. Waits up to wait_seconds, then returns the snapshot_id '
    + 'to poll. Large results are paged: use get_scraper_results with offset.',
  input: {
    dataset_id: datasetId,
    method,
    input: z.array(z.record(z.string(), z.any())).min(1).max(1000),
    limit_per_input: z.number().int().min(1).max(1000).optional().default(10).describe('discover_by_* only'),
    wait_seconds: z.number().int().min(0).max(300).optional().default(45),
    validate_input: z.boolean().optional().default(true).describe('Check required fields against the scraper schema first'),
    ...recordPaging,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  untrusted: true,
  async handler(a, ctx, svc) {
    const estimate = isDiscover(a.method) ? a.input.length * a.limit_per_input : a.input.length;
    if (estimate > svc.config.maxRecordsPerRun) {
      throw new BdError('budget', `This run could return up to ${estimate} billed records, above MAX_RECORDS_PER_RUN=${svc.config.maxRecordsPerRun}`, {
        hint: 'Lower limit_per_input or send fewer inputs, or raise MAX_RECORDS_PER_RUN.',
      });
    }
    if (a.validate_input) {
      try {
        const details = await svc.catalog.getDetails(a.dataset_id, a.method, ctx.signal);
        const problems = validateInput(details, a.input);
        if (problems.length) {
          throw new BdError('bad_request', `Input rejected before running (nothing was billed): ${problems.join('; ')}`, {
            hint: details.sample_input ? `Example input: ${JSON.stringify(details.sample_input).slice(0, 500)}` : 'See get_scraper_details.',
          });
        }
      } catch (e) {
        const err = toBdError(e, ctx.signal);
        if (err.kind === 'bad_request' || err.kind === 'not_found' || err.kind === 'cancelled') throw err;
        svc.logger.warn('skipping input validation', { error: err.message });
      }
    }
    const waitMs = a.wait_seconds * 1000;
    const res = await svc.runner.run(
      { datasetId: a.dataset_id, method: a.method, input: a.input, limitPerInput: a.limit_per_input, tool: 'run_scraper', signal: ctx.signal },
      estimate, waitMs,
      (elapsed, total) => ctx.progress(Math.round(elapsed / 1000), Math.round(total / 1000), 'Collecting records'),
    );
    return { text: json(describeRun(res, a.offset, a.limit, svc.config.maxOutputChars)) };
  },
});

export const getScraperProgress = defineTool({
  name: 'get_scraper_progress',
  title: 'Get Scraper Progress',
  description: 'Status of a scraper run: starting, running, ready, failed or canceled.',
  input: { snapshot_id: snapshotId },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  untrusted: false,
  async handler(a, ctx, svc) {
    return { text: json(await svc.runner.progress(a.snapshot_id, 'get_scraper_progress', ctx.signal)) };
  },
});

export const getScraperResults = defineTool({
  name: 'get_scraper_results',
  title: 'Get Scraper Results',
  description: 'Records of a finished run, paged with offset/limit (next_offset tells you where to continue). '
    + 'Returns status "running" if the run is not finished. Finished snapshots are cached, so paging is free.',
  input: { snapshot_id: snapshotId, ...recordPaging },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  untrusted: true,
  async handler(a, ctx, svc) {
    const res = await svc.runner.results(a.snapshot_id, 'get_scraper_results', ctx.signal);
    return { text: json(describeRun(res, a.offset, a.limit, svc.config.maxOutputChars)) };
  },
});

export const refreshScrapers = defineTool({
  name: 'refresh_scrapers',
  title: 'Refresh Scrapers',
  description: 'Reload the scraper catalog now instead of waiting for the daily refresh.',
  input: {},
  output: { scrapers: z.number() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  untrusted: false,
  async handler(_a, ctx, svc) {
    const structured = { scrapers: (await svc.catalog.load(true, ctx.signal)).length };
    return { text: json(structured), structured };
  },
});

export const scraperTools = [searchScrapers, getScraperDetails, runScraper, getScraperProgress, getScraperResults, refreshScrapers];
