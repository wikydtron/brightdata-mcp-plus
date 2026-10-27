import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { BdError } from '../errors.js';

/*
 * Free direct fetching from this machine, used before paying for Bright Data.
 * Guarded against SSRF: every hop of every redirect is resolved and refused if
 * it points at a private, loopback or link-local address, so a prompt-injected
 * URL cannot reach the user's router, cloud metadata or local services.
 */

const PRIVATE = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return PRIVATE.check(mapped, 'ipv4');
    return PRIVATE.check(address, 'ipv6');
  }
  return true;
}

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/141.0.0.0 Safari/537.36';

export interface DirectResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

export interface DirectOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  allowPrivate: boolean;
  maxRedirects?: number;
}

/** Fetches a URL from this machine with redirect, size, timeout and SSRF limits. */
export async function directFetch(url: string, opts: DirectOptions, signal?: AbortSignal): Promise<DirectResponse> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = new URL(url);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new BdError('bad_request', `Unsupported protocol ${current.protocol}`);
    }
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) throw privateError(host);
    const res = await once(current, opts, combined).catch((e: unknown) => {
      if (e instanceof BdError) throw e;
      if (signal?.aborted) throw new BdError('cancelled', 'The request was cancelled');
      if (timeout.aborted) throw new BdError('timeout', `Direct fetch timed out after ${opts.timeoutMs} ms`, { retryable: true });
      throw new BdError('network', `Direct fetch failed: ${(e as Error).message}`, { retryable: true });
    });
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      current = new URL(location, current);
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '');
    const body = await readBody(res, opts.maxBytes, contentType, combined);
    return { status: res.statusCode ?? 0, url: current.toString(), contentType, body };
  }
  throw new BdError('upstream', 'Too many redirects');
}

const privateError = (target: string) => new BdError('bad_request', `Refusing to fetch ${target}: it resolves to a private or local network address`, {
  hint: 'Set DIRECT_ALLOW_PRIVATE=true to allow fetching local/LAN addresses.',
});

function once(url: URL, opts: DirectOptions, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lookup = (hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, '');
        const list = addresses as LookupAddress[];
        const blocked = !opts.allowPrivate && list.find((a) => isPrivateAddress(a.address));
        if (blocked) return cb(privateError(`${hostname} (${blocked.address})`), '');
        if ((options as { all?: boolean }).all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    };
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      lookup: lookup as never,
      signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function readBody(res: IncomingMessage, maxBytes: number, contentType: string, signal: AbortSignal): Promise<string> {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  const stream = encoding === 'gzip' || encoding === 'x-gzip' ? res.pipe(createGunzip())
    : encoding === 'deflate' ? res.pipe(createInflate())
      : encoding === 'br' ? res.pipe(createBrotliDecompress())
        : res;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        res.destroy();
        throw new BdError('blocked', `Response larger than DIRECT_MAX_BYTES (${maxBytes})`, { code: 'too_large' });
      }
      chunks.push(chunk as Buffer);
    }
  } catch (e) {
    if (e instanceof BdError) throw e;
    if (signal.aborted) throw new BdError('timeout', 'Direct fetch was interrupted');
    throw new BdError('network', `Could not read response: ${(e as Error).message}`);
  }
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(Buffer.concat(chunks));
  } catch {
    return Buffer.concat(chunks).toString('utf8');
  }
}

const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;

// Signatures of bot walls. Strong ones always count; weak ones only on short
// pages, so a real article that merely embeds a reCAPTCHA form is kept.
const STRONG_BLOCKS: Array<[RegExp, string]> = [
  [/<title>\s*just a moment\.\.\.\s*<\/title>|cf-browser-verification|\/cdn-cgi\/challenge-platform|cf_chl_opt/i, 'cloudflare_challenge'],
  [/attention required! \| cloudflare/i, 'cloudflare_block'],
  [/captcha-delivery\.com|datadome/i, 'datadome'],
  [/_incapsula_resource|request unsuccessful\. incapsula/i, 'imperva'],
  [/px-captcha|perimeterx|human-challenge/i, 'perimeterx'],
  [/aws-waf-token|awswaf/i, 'aws_waf'],
  [/our systems have detected unusual traffic from your computer network/i, 'google_unusual_traffic'],
];
const WEAK_BLOCKS: Array<[RegExp, string]> = [
  [/g-recaptcha|hcaptcha\.com|recaptcha\/api\.js|turnstile/i, 'captcha'],
  [/<title>[^<]*access denied[^<]*<\/title>|pardon our interruption|are you a robot|verify you are (a )?human|robot or human\?|prove your humanity/i, 'bot_wall'],
];

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Decides whether a direct response is real content or a block/JS shell. */
export function classifyDirect(res: DirectResponse, text: string): Verdict {
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 503) {
    const sig = STRONG_BLOCKS.find(([re]) => re.test(res.body.slice(0, 50_000)));
    return { ok: false, reason: sig ? sig[1] : `http_${res.status}` };
  }
  if (res.status >= 400) return { ok: false, reason: `http_${res.status}` };
  if (res.contentType && !TEXT_TYPES.test(res.contentType)) return { ok: false, reason: 'unsupported_content_type' };
  if (!res.body.trim()) return { ok: false, reason: 'empty' };
  const head = res.body.slice(0, 50_000);
  const strong = STRONG_BLOCKS.find(([re]) => re.test(head));
  if (strong) return { ok: false, reason: strong[1] };
  const visible = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (visible.length < 3_000) {
    const weak = WEAK_BLOCKS.find(([re]) => re.test(head));
    if (weak) return { ok: false, reason: weak[1] };
  }
  // client-side shells: scripts can start deep in the page (Instagram: ~90 KB in), so scan all of it
  const isHtml = /html/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(head);
  if (isHtml && visible.length < 200) return { ok: false, reason: /<script/i.test(res.body) ? 'needs_javascript' : 'empty' };
  return { ok: true };
}

const IGNORE = ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head', 'canvas', 'object', 'embed'];

/** HTML to Markdown, with relative links made absolute against the final URL. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const md = NodeHtmlMarkdown.translate(html, { ignore: IGNORE, maxConsecutiveNewlines: 2 });
  return md.replace(/\]\((?!https?:|mailto:|tel:|#)([^)\s]+)/g, (whole, href: string) => {
    try {
      return `](${new URL(href, baseUrl).toString()}`;
    } catch {
      return whole;
    }
  });
}

/** Converts a direct response to Markdown according to its content type. */
export function toMarkdown(res: DirectResponse): string {
  if (/html|xml/i.test(res.contentType) || /^\s*</.test(res.body)) {
    return /html/i.test(res.contentType) || /<html|<body|<div|<p[\s>]/i.test(res.body.slice(0, 5_000))
      ? htmlToMarkdown(res.body, res.url)
      : res.body;
  }
  if (/json/i.test(res.contentType)) {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(res.body), null, 2)}\n\`\`\``;
    } catch {
      return res.body;
    }
  }
  return res.body;
}
