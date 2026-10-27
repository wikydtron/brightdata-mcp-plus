import { BdError } from '../errors.js';
import { clip } from '../util/redact.js';

export type Engine = 'google' | 'bing' | 'yandex';
export type TimeRange = 'day' | 'week' | 'month' | 'year';

export interface SearchParams {
  engine: Engine;
  query: string;
  page: number;
  geo?: string | undefined;
  language?: string | undefined;
  timeRange?: TimeRange | undefined;
}

const GOOGLE_TBS: Record<TimeRange, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };
const BING_FILTER: Partial<Record<TimeRange, string>> = { day: 'ex1:"ez1"', week: 'ex1:"ez2"', month: 'ex1:"ez3"' };

export function buildSearchUrl(p: SearchParams): string {
  const q = encodeURIComponent(p.query);
  const page = Math.max(0, p.page);
  if (p.engine === 'yandex') {
    return `https://yandex.com/search/?text=${q}&p=${page}${p.language ? `&lang=${encodeURIComponent(p.language)}` : ''}`;
  }
  if (p.engine === 'bing') {
    let url = `https://www.bing.com/search?q=${q}&first=${page * 10 + 1}`;
    if (p.geo) url += `&cc=${encodeURIComponent(p.geo)}`;
    if (p.language) url += `&setlang=${encodeURIComponent(p.language)}`;
    const filter = p.timeRange ? BING_FILTER[p.timeRange] : undefined;
    if (filter) url += `&filters=${encodeURIComponent(filter)}`;
    return url;
  }
  let url = `https://www.google.com/search?q=${q}&start=${page * 10}`;
  if (p.geo) url += `&gl=${encodeURIComponent(p.geo)}`;
  if (p.language) url += `&hl=${encodeURIComponent(p.language)}`;
  if (p.timeRange) url += `&tbs=${encodeURIComponent(GOOGLE_TBS[p.timeRange])}`;
  return `${url}&brd_json=1`;
}

export interface OrganicResult {
  rank: number;
  title: string;
  link: string;
  description: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Reduces Bright Data's parsed Google SERP JSON to compact organic results. */
export function parseGoogleSerp(body: string, page: number): { organic: OrganicResult[]; related: string[]; questions: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    throw new BdError('upstream', `Unexpected non-JSON search response: ${clip(body.trim(), 300)}`, { cause });
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const organic = (Array.isArray(obj.organic) ? obj.organic : [])
    .map((entry, i): OrganicResult | null => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const link = str(e.link) || str(e.url);
      const title = str(e.title);
      if (!link || !title) return null;
      const rank = typeof e.rank === 'number' ? e.rank : page * 10 + i + 1;
      return { rank, title, link, description: str(e.description) || str(e.snippet) };
    })
    .filter((r): r is OrganicResult => r !== null);
  const related = (Array.isArray(obj.related) ? obj.related : [])
    .map((r) => (typeof r === 'string' ? r : str((r as Record<string, unknown> | null)?.text)))
    .filter(Boolean)
    .slice(0, 8);
  const questions = (Array.isArray(obj.people_also_ask) ? obj.people_also_ask : [])
    .map((q) => (typeof q === 'string' ? q.trim() : str((q as Record<string, unknown> | null)?.question)))
    .filter(Boolean)
    .slice(0, 8);
  return { organic, related, questions };
}
