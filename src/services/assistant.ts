import type { BrightDataClient } from '../http/client.js';
import { BdError } from '../errors.js';
import { sleep } from '../util/async.js';

interface DialogMessage {
  type?: string;
  message?: unknown;
}

/** Bright Data's support assistant ("Sophie"): post a question, poll for the reply. */
export async function askAssistant(client: BrightDataClient, opts: {
  question: string;
  dialogId?: string | undefined;
  signal?: AbortSignal | undefined;
  pollMs?: number;
  maxWaitMs?: number;
  onProgress?: (elapsedMs: number, totalMs: number) => void;
}): Promise<{ answer: string; dialog_id: string }> {
  const pollMs = opts.pollMs ?? 1500;
  const maxWaitMs = opts.maxWaitMs ?? 45_000;
  const sig = opts.signal ? { signal: opts.signal } : {};
  const post = await client.request<{ dialog_id?: string }>({
    method: 'POST', path: '/sophie/dialog', idempotent: false, tool: 'ask_brightdata_assistant', what: 'Asking the assistant',
    body: opts.dialogId ? { message: opts.question, dialog_id: opts.dialogId } : { message: opts.question }, ...sig,
  });
  const dialogId = post.data?.dialog_id;
  if (!dialogId) throw new BdError('upstream', 'The assistant returned no dialog_id');
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await sleep(pollMs, opts.signal);
    opts.onProgress?.(Date.now() - started, maxWaitMs);
    const res = await client.request<DialogMessage[]>({
      path: `/sophie/dialog/${encodeURIComponent(dialogId)}`, tool: 'ask_brightdata_assistant', what: 'Reading the reply', ...sig,
    });
    const messages = Array.isArray(res.data) ? res.data : [];
    const lastHuman = messages.findLastIndex((m) => m?.type === 'human');
    if (lastHuman >= 0 && messages[lastHuman]!.message === opts.question) {
      const reply = messages.slice(lastHuman + 1).find((m) => m?.type === 'ai' && typeof m.message === 'string');
      if (reply) return { answer: reply.message as string, dialog_id: dialogId };
    }
  }
  throw new BdError('timeout', `The assistant did not answer within ${Math.round(maxWaitMs / 1000)}s`, {
    hint: `Call again with dialog_id=${dialogId} and the same question to fetch the reply later.`,
  });
}
