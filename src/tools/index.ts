import { browserTools } from './browser.js';
import { dataTools } from './data.js';
import { scraperTools } from './scrapers.js';
import type { ToolSpec } from './types.js';
import { webTools } from './web.js';

export const ALL_TOOLS: ToolSpec[] = [...webTools, ...scraperTools, ...dataTools, ...browserTools] as ToolSpec[];

const names = (list: ToolSpec[]) => list.map((t) => t.name);
const BASE = ['search_engine', 'scrape_as_markdown', 'ask_brightdata_assistant'];
const SCRAPERS = [...BASE, ...names(scraperTools as ToolSpec[])];
const DATASET_SEARCH = ['list_dataset_fields', 'search_dataset'];
const AI = ['chatgpt_ai_insights', 'perplexity_ai_insights'];

/** Group ids are compatible with the upstream server's GROUPS setting. */
export const GROUPS: Record<string, string[]> = {
  ecommerce: SCRAPERS,
  social: [...SCRAPERS, ...DATASET_SEARCH],
  business: [...SCRAPERS, ...DATASET_SEARCH],
  finance: SCRAPERS,
  research: SCRAPERS,
  app_stores: SCRAPERS,
  travel: SCRAPERS,
  code: SCRAPERS,
  scrapers: SCRAPERS,
  browser: [...BASE, ...names(browserTools as ToolSpec[])],
  advanced_scraping: [...BASE, 'search_engine_batch', 'scrape_batch', 'scrape_as_html', 'extract', 'session_stats'],
  geo: [...BASE, ...AI],
  datasets: [...BASE, ...DATASET_SEARCH],
  custom: BASE,
};

/** Maps legacy names (web_data_*) to current tools. */
export function resolveToolName(name: string): string[] {
  const short = name.replace(/^web_data_/, '');
  if (short === name) return [name];
  return AI.includes(short) ? [short] : names(scraperTools as ToolSpec[]);
}

/**
 * Which tools to register: everything by default, otherwise the union of the
 * selected groups and individually named tools. Unknown names are reported.
 */
export function selectTools(groups: string[], tools: string[]): { selected: ToolSpec[]; unknown: string[] } {
  if (!groups.length && !tools.length) return { selected: ALL_TOOLS, unknown: [] };
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const g of groups) {
    const members = GROUPS[g];
    if (members) members.forEach((t) => wanted.add(t));
    else unknown.push(`group:${g}`);
  }
  const known = new Set(ALL_TOOLS.map((t) => t.name));
  for (const t of tools) {
    const resolved = resolveToolName(t).filter((n) => known.has(n));
    if (resolved.length) resolved.forEach((n) => wanted.add(n));
    else unknown.push(`tool:${t}`);
  }
  return { selected: ALL_TOOLS.filter((t) => wanted.has(t.name)), unknown };
}
