import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, unwrap } from './helpers/harness.js';
import { startStub, type Stub } from './helpers/stub.js';

let stub: Stub;
before(async () => { stub = await startStub(); });
after(async () => { await stub.close(); });

test('lists every tool with annotations; first-party tools declare output schemas', async () => {
  const h = await connect(stub);
  const { tools } = await h.client.listTools();
  assert.equal(tools.length, 34);
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} has annotations`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
  }
  assert.ok(tools.find((t) => t.name === 'search_scrapers')?.outputSchema);
  assert.ok(tools.find((t) => t.name === 'session_stats')?.outputSchema);
  assert.equal(tools.find((t) => t.name === 'scrape_as_markdown')?.outputSchema, undefined);
  const prompts = await h.client.listPrompts();
  assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ['diagnose_scraping_approach', 'web_scraping_strategy']);
  await h.close();
});

test('search_engine returns compact ranked JSON wrapped as untrusted content', async () => {
  const h = await connect(stub);
  const r = await h.call('search_engine', { query: 'mcp servers', geo_location: 'us', time_range: 'month' });
  assert.equal(r.isError, undefined);
  const data = JSON.parse(unwrap(h.text(r)));
  assert.deepEqual(data.results.map((x: { link: string }) => x.link), ['https://a.example', 'https://b.example']);
  assert.equal(data.next_cursor, '1');
  assert.deepEqual(data.related, ['related one']);
  assert.deepEqual(data.people_also_ask, ['What is a question?']);
  const sent = stub.calls.filter((c) => c.path === '/request').at(-1)!.body as { url: string; data_format?: string };
  assert.ok(sent.url.includes('gl=us') && sent.url.includes('tbs=qdr%3Am') && sent.url.endsWith('brd_json=1'));
  // the full brd_json parse: parsed_light would drop related searches and "People also ask"
  assert.equal(sent.data_format, undefined);
  const bing = await h.call('search_engine', { query: 'x', engine: 'bing' });
  assert.ok(JSON.parse(unwrap(h.text(bing))).markdown.includes('[Result](https://r.example)'));
  await h.close();
});

test('scrape_as_markdown minifies, caches repeats and refetches with fresh', async () => {
  const h = await connect(stub);
  const url = 'https://site.example/page-cache';
  const first = unwrap(h.text(await h.call('scrape_as_markdown', { url })));
  assert.ok(first.includes('# Title for'));
  assert.ok(!first.includes('**bold**'));
  assert.ok(!first.includes('img.example'));
  await h.call('scrape_as_markdown', { url });
  assert.equal(stub.unlockCalls('page-cache'), 1, 'second call served from cache');
  await h.call('scrape_as_markdown', { url, fresh: true });
  assert.equal(stub.unlockCalls('page-cache'), 2);
  await h.close();
});

test('long pages are paginated and later pages come from cache', async () => {
  const h = await connect(stub, { MAX_OUTPUT_CHARS: '5000' });
  const url = 'https://site.example/long';
  const p1 = h.text(await h.call('scrape_as_markdown', { url, format: 'raw' }));
  const next = Number(/offset=(\d+)/.exec(p1)?.[1]);
  assert.ok(next > 4000 && next <= 5000);
  const p2 = unwrap(h.text(await h.call('scrape_as_markdown', { url, format: 'raw', offset: next })));
  assert.ok(p2.startsWith('Line '));
  assert.equal(stub.unlockCalls('site.example/long'), 1);
  await h.close();
});

test('scrape_batch handles 10 URLs with bounded concurrency and per-item errors', async () => {
  const h = await connect(stub, { MAX_CONCURRENCY: '3' });
  stub.resetInflight();
  const urls = [...Array.from({ length: 9 }, (_, i) => `https://batch.example/p${i}`), 'https://batch.example/bad'];
  const progress: unknown[] = [];
  const r = await h.call('scrape_batch', { urls }, { onprogress: (p) => progress.push(p) });
  const items = JSON.parse(unwrap(h.text(r))) as Array<{ url: string; ok: boolean; error?: string }>;
  assert.equal(items.length, 10);
  assert.deepEqual(items.map((i) => i.url), urls, 'order preserved');
  assert.equal(items.filter((i) => i.ok).length, 9);
  assert.match(items[9]!.error!, /bad_request/);
  assert.ok(stub.maxInflight <= 3, `max in flight ${stub.maxInflight}`);
  assert.ok(progress.length >= 5, 'progress notifications sent');
  await h.close();
});

test('content gate withholds injected config instructions unless the user approves', async () => {
  const url = 'https://evil.example/inject';
  const h = await connect(stub);
  const denied = h.text(await h.call('scrape_as_markdown', { url }));
  assert.ok(denied.includes('page content was not returned'));
  assert.ok(!denied.includes('evil-mcp'));
  await h.close();

  const prompts: string[] = [];
  const h2 = await connect(stub, {}, { elicit: (m) => { prompts.push(m); return { action: 'accept', content: { return_content: true } }; } });
  const allowed = unwrap(h2.text(await h2.call('scrape_as_markdown', { url })));
  assert.ok(allowed.includes('evil-mcp'));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes('mcpServers'));
  await h2.close();
});

test('run_scraper validates input before billing, polls, reports progress and pages records', async () => {
  const h = await connect(stub);
  const triggers = () => stub.count('/datasets/v3/trigger');
  const before = triggers();
  const bad = await h.call('run_scraper', { dataset_id: 'gd_test1', method: 'collect_by_url', input: [{ urll: 'typo' }] });
  assert.equal(bad.isError, true);
  assert.match(h.text(bad), /missing required field\(s\): url/);
  assert.equal(triggers(), before, 'nothing triggered');

  const progress: unknown[] = [];
  const ok = await h.call('run_scraper', {
    dataset_id: 'gd_test1', method: 'discover_by_keyword', input: [{ keyword: 'a' }, { keyword: 'b' }], limit_per_input: 5, limit: 4,
  }, { onprogress: (p) => progress.push(p) });
  const run = JSON.parse(unwrap(h.text(ok)));
  assert.equal(run.status, 'ready');
  assert.equal(run.total_records, 10);
  assert.equal(run.returned, 4);
  assert.equal(run.next_offset, 4);
  assert.equal(run.records[0].empty, undefined, 'nulls stripped');
  const trig = stub.calls.filter((c) => c.path === '/datasets/v3/trigger').at(-1)!;
  assert.equal(trig.query.get('type'), 'discover_new');
  assert.equal(trig.query.get('discover_by'), 'keyword');
  assert.equal(trig.headers['x-mcp-dataset-id'], 'gd_test1');
  assert.ok(progress.length >= 1);

  const snapshotCalls = stub.count(`/datasets/v3/snapshot/${run.snapshot_id}`);
  const page2 = JSON.parse(unwrap(h.text(await h.call('get_scraper_results', { snapshot_id: run.snapshot_id, offset: 4, limit: 100 }))));
  assert.equal(page2.returned, 6);
  assert.equal(page2.next_offset, null);
  assert.equal(stub.count(`/datasets/v3/snapshot/${run.snapshot_id}`), snapshotCalls, 'paging served from cache');

  const stats = (await h.call('session_stats')).structuredContent as { billable: Record<string, number> };
  assert.equal(stats.billable.scraper_records, 10);
  await h.close();
});

test('spending guards stop oversized runs and over-budget sessions before any request', async () => {
  const h = await connect(stub, { MAX_RECORDS_PER_RUN: '20', BUDGET_MAX_REQUESTS: '2' });
  const triggersBefore = stub.count('/datasets/v3/trigger');
  const big = await h.call('run_scraper', { dataset_id: 'gd_test1', method: 'discover_by_keyword', input: [{ keyword: 'a' }, { keyword: 'b' }, { keyword: 'c' }], limit_per_input: 10 });
  assert.equal(big.isError, true);
  assert.match(h.text(big), /\[budget\].*30 billed records/);
  assert.equal(stub.count('/datasets/v3/trigger'), triggersBefore);

  await h.call('scrape_as_markdown', { url: 'https://budget.example/1' });
  await h.call('scrape_as_markdown', { url: 'https://budget.example/2' });
  const third = await h.call('scrape_as_markdown', { url: 'https://budget.example/3' });
  assert.equal(third.isError, true);
  assert.match(h.text(third), /BUDGET_MAX_REQUESTS=2/);
  assert.equal(stub.unlockCalls('budget.example/3'), 0);
  const cached = await h.call('scrape_as_markdown', { url: 'https://budget.example/1' });
  assert.equal(cached.isError, undefined, 'cached pages stay free after the budget is spent');
  await h.close();
});

test('the free-tier exhaustion message reaches every tool family, including scrapers', async () => {
  const h = await connect(stub);
  const scrape = h.text(await h.call('scrape_as_markdown', { url: 'https://x.example/quota' }));
  assert.match(scrape, /\[usage_limit\]/);
  assert.match(scrape, /free monthly requests/);
  const run = await h.call('run_scraper', { dataset_id: 'gd_quota', method: 'collect_by_url', input: [{ url: 'https://q.example' }], validate_input: false });
  assert.match(h.text(run), /\[usage_limit\]/);
  assert.match(h.text(run), /Failed step: trigger/);
  await h.close();
});

test('local RATE_LIMIT applies to every tool', async () => {
  const h = await connect(stub, { RATE_LIMIT: '2/1m' });
  await h.call('session_stats');
  await h.call('search_scrapers', { query: 'amazon' });
  const third = await h.call('session_stats');
  assert.equal(third.isError, true);
  assert.match(h.text(third), /Local rate limit 2\/1m/);
  await h.close();
});

test('cancelling a tool call aborts the upstream request', async () => {
  const h = await connect(stub);
  const before = stub.aborted;
  const ac = new AbortController();
  const pending = h.call('scrape_as_markdown', { url: 'https://slow.example/slow/e2e' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(pending);
  for (let i = 0; i < 50 && stub.aborted === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(stub.aborted, before + 1, 'stub saw the upstream connection close early');
  await h.close();
});

test('scraper catalog search, details, datasets, assistant and stats', async () => {
  const h = await connect(stub);
  // like real clients, list first so the SDK client checks structuredContent against each outputSchema
  await h.client.listTools();
  const found = await h.call('search_scrapers', { query: 'amazon reviews' });
  const sc = found.structuredContent as { results: Array<{ dataset_id: string }> };
  assert.equal(sc.results[0]!.dataset_id, 'gd_test2');
  const details = JSON.parse(h.text(await h.call('get_scraper_details', { dataset_id: 'gd_test1', method: 'collect_by_url' })));
  assert.equal(details.input_fields[0].required, true);
  assert.deepEqual(details.sample_input, [{ url: 'https://shop.example/p/1' }]);
  const missing = await h.call('get_scraper_details', { dataset_id: 'gd_test1', method: 'nope' });
  assert.match(h.text(missing), /Available methods: collect_by_url, discover_by_keyword/);

  const fields = (await h.call('list_dataset_fields', { dataset_id: 'gd_l1viktl72bvl7bjuj0' })).structuredContent as { fields: Array<{ name: string }> };
  assert.deepEqual(fields.fields.map((f) => f.name), ['name', 'headline']);
  const search = JSON.parse(unwrap(h.text(await h.call('search_dataset', {
    dataset_id: 'gd_l1viktl72bvl7bjuj0', filter: { operator: 'and', filters: [{ name: 'name', operator: '=', value: 'Ada' }, { name: 'x', operator: 'is_null' }] },
  }))));
  assert.equal(search.total_hits, 1);
  const badFilter = await h.call('search_dataset', { dataset_id: 'gd_l1viktl72bvl7bjuj0', filter: { name: 'n', operator: '=' } });
  assert.equal(badFilter.isError, true);

  const answer = JSON.parse(h.text(await h.call('ask_brightdata_assistant', { question: 'How do zones work?' })));
  assert.equal(answer.answer, 'Use a zone.');

  const stats = (await h.call('session_stats')).structuredContent as Record<string, unknown>;
  assert.ok((stats.tools as Record<string, unknown>).search_scrapers);
  assert.deepEqual(stats.zones, { unlocker: 'exists', browser: 'created' });
  await h.close();
});

test('extract uses the client model via sampling and returns parsed JSON', async () => {
  let seen = '';
  const h = await connect(stub, {}, { sample: (prompt) => { seen = prompt; return '```json\n{"title":"Hello"}\n```'; } });
  const r = await h.call('extract', { url: 'https://site.example/extract', extraction_prompt: 'Get the title', schema: { type: 'object' } });
  assert.deepEqual(JSON.parse(unwrap(h.text(r))), { title: 'Hello' });
  assert.ok(seen.includes('Get the title') && seen.includes('JSON Schema') && seen.includes('# Title for'));
  await h.close();

  const noSampling = await connect(stub);
  const err = await noSampling.call('extract', { url: 'https://site.example/extract' });
  assert.match(noSampling.text(err), /does not support MCP sampling/);
  await noSampling.close();
});

test('GROUPS limits the registered tools', async () => {
  const h = await connect(stub, { GROUPS: 'geo' });
  const names = (await h.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['ask_brightdata_assistant', 'chatgpt_ai_insights', 'perplexity_ai_insights', 'scrape_as_markdown', 'search_engine']);
  await h.close();
});
