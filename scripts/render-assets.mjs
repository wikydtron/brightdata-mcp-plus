#!/usr/bin/env node
// Renders the README images from assets/src/*.html with headless Chrome/Edge.
// The demo image is built from a real run recorded by scripts/live-smoke.mjs.
//
//   node scripts/live-smoke.mjs --json assets/src/live-run.json   (optional: refresh the data)
//   node scripts/render-assets.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'assets', 'src');
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!chrome) throw new Error('No Chrome/Edge found; set CHROME_PATH');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function demoHtml(run) {
  const rows = run.rows.map((r) => {
    const host = r.url.replace(/^https?:\/\//, '');
    let mark = '<span class="ok">✔</span>';
    let note = '<span class="ok">fetched directly · free</span>';
    if (!r.ok) {
      const reason = /\(([^)]+)\)\s*$/.exec(r.note)?.[1] ?? '';
      if (/private or local/.test(r.note)) {
        mark = '<span class="err">⛔</span>';
        note = '<span class="err">refused: cloud-metadata address (SSRF)</span>';
      } else {
        mark = '<span class="warn">↪</span>';
        note = `<span class="warn">blocked: ${esc(reason)} → Bright Data</span>`;
      }
    }
    const chars = r.ok ? `${r.chars.toLocaleString('en-US')} ch` : '';
    return `<div class="row">${mark}<span class="ms">${r.ms} ms</span><span class="ch">${chars}</span><span class="url">${esc(host.slice(0, 54))}</span>${note}</div>`;
  }).join('\n');
  const f = run.stats.free;
  const billed = Object.values(run.stats.billable).reduce((a, b) => a + b, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:600px;overflow:hidden;background:#0b1020}
  body{font-family:"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
  .win{width:1200px;border-radius:14px;background:#0d1117;border:1px solid #30363d;box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden}
  .bar{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#161b22;border-bottom:1px solid #30363d}
  .dot{width:12px;height:12px;border-radius:50%}.t{margin-left:12px;color:#8b949e;font-size:13px}
  .body{padding:22px 26px 24px;font:14.5px/1.75 "Cascadia Code",Consolas,monospace;color:#c9d1d9}
  .p{color:#2dd4bf}.dim{color:#8b949e}.ok{color:#34d399}.warn{color:#fbbf24}.err{color:#f87171}
  .row{display:grid;grid-template-columns:26px 74px 86px 500px 1fr;white-space:nowrap}
  .ms,.ch{color:#8b949e;text-align:right;padding-right:16px}.url{color:#e6edf3;overflow:hidden;text-overflow:ellipsis;padding-right:16px}
  .sum{margin-top:14px;padding-top:12px;border-top:1px dashed #30363d}
  </style></head><body><div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">live run on real websites · free mode (no API token) · with a token, blocked sites fall back to Bright Data</span></div>
  <div class="body">
  <div><span class="p">$</span> node scripts/live-smoke.mjs</div>
  <div class="dim">server ${esc(run.server.name)} ${esc(run.server.version)} · ${run.tools} tools · tool: scrape_as_markdown</div>
  ${rows}
  <div class="sum"><span class="p">session_stats</span> → direct_fetches <span class="ok">${f.direct_fetches}</span> · fallbacks <span class="warn">${f.direct_misses}</span> · billed requests <span class="ok">${billed}</span> · cost <span class="ok">$0.00</span></div>
  </div></div></body></html>`;
}

const run = JSON.parse(readFileSync(join(src, 'live-run.json'), 'utf8'));
writeFileSync(join(src, 'demo.html'), demoHtml(run));

const jobs = [['banner', 1280, 420], ['architecture', 1280, 1010], ['fetch-flow', 1280, 610], ['demo', 1280, 600]];
const profile = mkdtempSync(join(tmpdir(), 'render-assets-'));
try {
  for (const [name, w, h] of jobs) {
    const out = join(root, 'assets', `${name}.png`);
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`,
      '--force-device-scale-factor=2', `--window-size=${w},${h}`, '--virtual-time-budget=1500', `--screenshot=${out}`,
      pathToFileURL(join(src, `${name}.html`)).href], { stdio: 'ignore', timeout: 60_000 });
    console.log(`rendered assets/${name}.png`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
