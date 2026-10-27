import { remark } from 'remark';
import strip from 'strip-markdown';

export type ContentFormat = 'markdown' | 'text' | 'raw';

// node types strip-markdown has handlers for; it throws on any other name
const KEEP_STRUCTURE = ['link', 'linkReference', 'code', 'inlineCode', 'heading', 'list', 'listItem', 'table', 'tableCell'] as const;
const KEEP_LINKS = ['link', 'linkReference', 'code', 'inlineCode'] as const;

/**
 * Shrinks scraped Markdown to cut tokens:
 * - markdown: keeps headings, lists, tables, links and code; drops images/HTML/emphasis
 * - text: plain text plus links and code (the upstream server's behaviour)
 * - raw: unchanged
 */
export async function minifyMarkdown(md: string, format: ContentFormat): Promise<string> {
  if (format === 'raw' || !md) return md;
  const keep = format === 'markdown' ? KEEP_STRUCTURE : KEEP_LINKS;
  try {
    const out = await remark().use(strip, { keep: [...keep] }).process(md);
    return collapseBlankLines(String(out.value));
  } catch {
    return collapseBlankLines(md);
  }
}

export const collapseBlankLines = (text: string): string =>
  text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export interface Page {
  content: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
}

/**
 * Returns a window of `text` starting at `offset`, cutting at a line break
 * near the limit where possible so the agent can page through long documents
 * instead of flooding its context.
 */
export function paginate(text: string, offset: number, maxChars: number): Page {
  const total = text.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(total, start + maxChars);
  if (end < total) {
    const lineBreak = text.lastIndexOf('\n', end);
    if (lineBreak > start + maxChars * 0.8) end = lineBreak + 1;
  }
  return { content: text.slice(start, end), offset: start, next_offset: end < total ? end : null, total_chars: total };
}

/** Footer the model sees when a result was cut. */
export const pageFooter = (page: Page): string =>
  page.next_offset === null
    ? ''
    : `\n\n[Truncated: showing characters ${page.offset}-${page.next_offset} of ${page.total_chars}. `
      + `Call again with offset=${page.next_offset} to read more.]`;
