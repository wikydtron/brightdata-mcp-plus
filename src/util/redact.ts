const URL_CREDENTIALS = /((?:wss?|https?):\/\/)[^/@\s]+@/gi;
const BEARER = /(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;

export const redactUrlCredentials = (text: string): string =>
  text.replace(URL_CREDENTIALS, '$1[REDACTED]@');

/**
 * Removes known secrets (API tokens, zone passwords) and credential-shaped
 * substrings from any text before it is logged or returned to a client.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  redact(value: unknown): string {
    let text = typeof value === 'string' ? value : safeStringify(value);
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return redactUrlCredentials(text).replace(BEARER, '$1[REDACTED]');
  }
}

export function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
