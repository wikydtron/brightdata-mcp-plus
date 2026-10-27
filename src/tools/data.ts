import { z } from 'zod';
import { askAssistant } from '../services/assistant.js';
import { datasetIdSchema, filterSchema, FILTER_OPERATORS, SEARCHABLE_DATASETS } from '../services/datasets.js';
import { describeRun } from './scrapers.js';
import { defineTool, json, type ToolSpec } from './types.js';

const DATASETS_DESC = `Supported dataset_id values:\n${Object.entries(SEARCHABLE_DATASETS).map(([id, name]) => `- ${id}: ${name}`).join('\n')}`;

export const listDatasetFields = defineTool({
  name: 'list_dataset_fields',
  title: 'List Dataset Fields',
  description: `List the filterable fields (name, type, description) of a searchable dataset. Call before search_dataset.\n${DATASETS_DESC}`,
  input: { dataset_id: datasetIdSchema },
  output: { dataset_id: z.string(), fields: z.array(z.object({ name: z.string(), type: z.any().optional(), description: z.any().optional() })) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  untrusted: false,
  async handler(a, ctx, svc) {
    const structured = { dataset_id: a.dataset_id, fields: await svc.datasets.fields(a.dataset_id, ctx.signal) };
    return { text: json(structured), structured };
  },
});

export const searchDataset = defineTool({
  name: 'search_dataset',
  title: 'Search Dataset',
  description: 'Find many records in a Bright Data dataset by filter (fast, synchronous, no snapshot). A filter is a '
    + 'leaf {name, operator, value} or a group {operator: "and"|"or", filters: [...]}, nested up to 3 levels. '
    + `Leaf operators: ${FILTER_OPERATORS.join(', ')}. Use search_after from a result to get the next page.\n${DATASETS_DESC}`,
  input: {
    dataset_id: datasetIdSchema,
    filter: filterSchema,
    size: z.number().int().min(1).max(10).optional().default(10),
    sort: z.union([z.enum(['default', 'random']), z.array(z.record(z.string(), z.enum(['asc', 'desc'])))]).optional(),
    search_after: z.array(z.any()).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  untrusted: true,
  async handler(a, ctx, svc) {
    const result = await svc.datasets.search(a.dataset_id, {
      filter: a.filter, size: a.size, ...(a.sort ? { sort: a.sort } : {}), ...(a.search_after ? { search_after: a.search_after } : {}),
    }, ctx.signal);
    return { text: json(result) };
  },
});

const aiInsights = (id: string, datasetId: string, label: string, fixed: Record<string, unknown>): ToolSpec => defineTool({
  name: id,
  title: `${label} AI Insights`,
  description: `Send a prompt to ${label} and get its answer (Markdown, with citations where available). Useful for `
    + 'GEO / brand-visibility checks and LLM-as-a-judge. If the answer takes longer than wait_seconds, returns a '
    + 'snapshot_id for get_scraper_results instead of failing.',
  input: {
    prompt: z.string().min(1).max(8000),
    wait_seconds: z.number().int().min(10).max(600).optional().default(600),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  untrusted: true,
  async handler(a, ctx, svc) {
    const res = await svc.runner.run({
      datasetId, input: [{ prompt: a.prompt, ...fixed }], tool: id, signal: ctx.signal,
      extraQuery: { custom_output_fields: 'answer_text_markdown' },
    }, 1, (a.wait_seconds as number) * 1000, (elapsed, total) => ctx.progress(Math.round(elapsed / 1000), Math.round(total / 1000), `Waiting for ${label}`));
    return { text: json(describeRun(res, 0, 10, svc.config.maxOutputChars)) };
  },
});

export const chatgptInsights = aiInsights('chatgpt_ai_insights', 'gd_m7aof0k82r803d5bjm', 'ChatGPT',
  { url: 'https://chatgpt.com/', country: '', web_search: false, additional_prompt: '' });
export const perplexityInsights = aiInsights('perplexity_ai_insights', 'gd_m7dhdot1vw9a7gc1n', 'Perplexity',
  { url: 'https://www.perplexity.ai', index: '', country: '' });

export const askBrightdataAssistant = defineTool({
  name: 'ask_brightdata_assistant',
  title: 'Ask Bright Data Assistant',
  description: 'Ask Bright Data\'s support assistant about products, APIs, zones, errors, pricing or account setup. '
    + 'Pass the returned dialog_id to ask a follow-up in the same thread.',
  input: {
    question: z.string().min(1).max(20_480),
    dialog_id: z.string().length(24).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  untrusted: false,
  async handler(a, ctx, svc) {
    const result = await askAssistant(svc.client, {
      question: a.question, dialogId: a.dialog_id, signal: ctx.signal,
      onProgress: (elapsed, total) => ctx.progress(Math.round(elapsed / 1000), Math.round(total / 1000), 'Waiting for the assistant'),
    });
    return { text: json(result) };
  },
});

export const sessionStats = defineTool({
  name: 'session_stats',
  title: 'Session Stats',
  description: 'Usage this session: calls, errors, latency (p50/p95) and cache hits per tool, billable units, '
    + 'estimated cost, free direct fetches and savings, remaining budget, zone status and open browser sessions.',
  input: {},
  output: {
    uptime_s: z.number(),
    fetch_strategy: z.string(),
    billable: z.record(z.string(), z.number()),
    estimated_cost_usd: z.number(),
    free: z.object({ direct_fetches: z.number(), local_renders: z.number(), fallbacks: z.number(), estimated_savings_usd: z.number() }),
    local_rendering: z.string(),
    budget: z.object({ max: z.number(), used: z.number(), remaining: z.number() }).nullable(),
    tools: z.record(z.string(), z.object({ calls: z.number(), errors: z.number(), cache_hits: z.number(), p50_ms: z.number(), p95_ms: z.number() })),
    cache: z.object({ entries: z.number(), hits: z.number(), misses: z.number() }),
    upstream_calls: z.number(),
    open_browser_sessions: z.number(),
    zones: z.record(z.string(), z.any()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  untrusted: false,
  free: true,
  async handler(_a, _ctx, svc) {
    const caches = [svc.cache, svc.pages.cache];
    const structured = {
      ...svc.meter.snapshot(),
      fetch_strategy: svc.pages.strategy,
      local_rendering: !svc.config.localRender ? 'off' : svc.pages.renderingEnabled ? 'on' : 'unavailable (no Chrome/Edge found)',
      cache: {
        entries: caches.reduce((n, c) => n + c.size, 0),
        hits: caches.reduce((n, c) => n + c.hits, 0),
        misses: caches.reduce((n, c) => n + c.misses, 0),
      },
      upstream_calls: svc.client.upstreamCalls,
      open_browser_sessions: svc.browser.openSessions,
      zones: { ...(await svc.zones()) },
    };
    return { text: json(structured), structured };
  },
});

export const dataTools = [listDatasetFields, searchDataset, chatgptInsights, perplexityInsights, askBrightdataAssistant, sessionStats];
