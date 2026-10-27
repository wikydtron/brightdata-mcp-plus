import type { Redactor } from './util/redact.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Structured JSON-lines logger. Always writes to stderr: stdout belongs to the
 * stdio MCP transport. Every line passes through the redactor.
 */
export function createLogger(
  level: Level | 'silent',
  redactor: Redactor,
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    sink(redactor.redact(entry));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(level, redactor, { ...base, ...fields }, sink),
  };
}
