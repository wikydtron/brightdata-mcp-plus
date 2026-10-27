import { z } from 'zod';
import type { BrightDataClient } from '../http/client.js';
import type { UsageMeter } from '../usage.js';
import { TtlCache } from '../util/cache.js';

export const SEARCHABLE_DATASETS = {
  gd_l1viktl72bvl7bjuj0: 'LinkedIn people profiles',
  gd_me5ppxjr2ge6icjuh0: 'LinkedIn people profiles (contact-enriched)',
  gd_l1vikfnt1wgvvqz95w: 'LinkedIn company information',
} as const;

export const datasetIdSchema = z.enum(Object.keys(SEARCHABLE_DATASETS) as [keyof typeof SEARCHABLE_DATASETS, ...Array<keyof typeof SEARCHABLE_DATASETS>]);

export const FILTER_OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'not_in', 'includes', 'not_includes',
  'array_includes', 'not_array_includes', 'is_null', 'is_not_null'] as const;

const NULLARY = new Set(['is_null', 'is_not_null']);

const leafSchema = z.object({
  name: z.string().describe('Field name from list_dataset_fields'),
  operator: z.enum(FILTER_OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional()
    .describe('Value to compare against. Omit for is_null / is_not_null.'),
}).superRefine((leaf, ctx) => {
  if (!NULLARY.has(leaf.operator) && leaf.value === undefined) {
    ctx.addIssue({ code: 'custom', message: `operator "${leaf.operator}" requires a value` });
  }
});

type FilterNode = z.infer<typeof leafSchema> | { operator: 'and' | 'or'; filters: FilterNode[] };

const MAX_DEPTH = 3;
function nodeSchema(depth: number): z.ZodType<FilterNode> {
  if (depth <= 1) return leafSchema;
  return z.union([z.object({ operator: z.enum(['and', 'or']), filters: z.array(nodeSchema(depth - 1)).min(1) }), leafSchema]);
}
export const filterSchema = nodeSchema(MAX_DEPTH + 1);

export interface DatasetField {
  name: string;
  type: unknown;
  description: unknown;
}

export class DatasetService {
  private readonly metadata = new TtlCache<DatasetField[]>(60 * 60 * 1000, 20);

  constructor(private readonly client: BrightDataClient, private readonly meter: UsageMeter) {}

  async fields(datasetId: string, signal?: AbortSignal): Promise<DatasetField[]> {
    const [fields] = await this.metadata.getOrLoad(datasetId, async () => {
      const res = await this.client.request<{ fields?: Record<string, { type?: unknown; description?: unknown; active?: boolean }> }>({
        path: `/datasets/${datasetId}/metadata`, tool: 'list_dataset_fields', what: 'Loading dataset fields', ...(signal ? { signal } : {}),
      });
      return Object.entries(res.data?.fields ?? {})
        .filter(([, meta]) => meta && typeof meta === 'object' && meta.active !== false)
        .map(([name, meta]) => ({ name, type: meta.type, description: meta.description }));
    });
    return fields;
  }

  async search(datasetId: string, body: { filter: FilterNode; size: number; sort?: unknown; search_after?: unknown[] }, signal?: AbortSignal) {
    this.meter.reserve(body.size);
    let billed = 0;
    try {
      const res = await this.client.request<{ hits?: unknown[]; total_hits?: number; took?: number; search_after?: unknown[] }>({
        method: 'POST', path: `/datasets/search/${datasetId}`, body: { mode: 'sync', ...body }, idempotent: true,
        tool: 'search_dataset', what: 'Searching dataset', ...(signal ? { signal } : {}),
      });
      const hits = res.data?.hits ?? [];
      billed = hits.length;
      return { hits, total_hits: res.data?.total_hits ?? null, took: res.data?.took ?? null, search_after: res.data?.search_after ?? null };
    } finally {
      this.meter.settle(body.size, 'dataset_records', billed);
    }
  }
}
