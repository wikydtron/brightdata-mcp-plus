import type { z } from 'zod';
import type { Config } from '../config.js';
import type { BrightDataClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { UsageMeter } from '../usage.js';
import type { Redactor } from '../util/redact.js';
import type { TtlCache } from '../util/cache.js';
import type { Unlocker } from '../services/unlocker.js';
import type { ScraperCatalog, ScraperRunner } from '../services/scrapers.js';
import type { DatasetService } from '../services/datasets.js';
import type { BrowserManager } from '../services/browser.js';
import type { ZoneReport } from '../services/zones.js';
import type { PageFetcher } from '../services/pages.js';

export interface Services {
  config: Config;
  client: BrightDataClient;
  meter: UsageMeter;
  cache: TtlCache<string>;
  unlocker: Unlocker;
  pages: PageFetcher;
  catalog: ScraperCatalog;
  runner: ScraperRunner;
  datasets: DatasetService;
  browser: BrowserManager;
  logger: Logger;
  redactor: Redactor;
  zones: () => Promise<ZoneReport>;
}

export interface ToolContext {
  signal: AbortSignal;
  /** Sends notifications/progress when the client asked for it. */
  progress(progress: number, total?: number, message?: string): void;
  /**
   * Applies the content gate: items whose text looks like MCP-config
   * instructions come back as null unless the user approves them.
   */
  gate<T>(items: T[], textOf: (item: T) => string): Promise<{ items: (T | null)[]; withheld: number }>;
  /** Asks the client's own model (MCP sampling). */
  sample(opts: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult =
  | {
    text: string;
    structured?: Record<string, unknown>;
    cacheHit?: boolean;
    /** Trusted server note appended outside the untrusted wrapper. */
    note?: string;
  }
  | { content: ContentBlock[] };

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Declared only for tools whose result is first-party (non-web) data. */
  output?: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Results carry attacker-controllable web content and get wrapped. */
  untrusted: boolean;
  /** Works without a Bright Data token (free mode). */
  free?: boolean;
  handler(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext, svc: Services): Promise<ToolResult>;
}

export const defineTool = <S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> => spec;

export const json = (value: unknown): string => JSON.stringify(value);
