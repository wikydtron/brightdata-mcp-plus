# Changelog

## 1.2.2

### Fixed
- `search_engine` and `search_engine_batch` (Google) now return Google's related searches. Requests asked Bright Data
  for `data_format: parsed_light`, which keeps only the ranked results, so `related` was always missing. Google
  searches now use the full `brd_json=1` parse; in a live check, 3 of 4 queries came back with 2-8 related searches.

### Added
- Google results include `people_also_ask` (up to 8 questions) when the results page has a "People also ask" box.

## 1.2.1

### Security
- Upgraded `zod` from 3.x to 4.6.7 to fix [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
  (validating oversized constrained collections could exhaust memory). `npm audit --omit=dev` is clean again.

### Fixed
- `list_dataset_fields` declares a field's `type` and `description` as optional in its output schema, so clients that
  check `structuredContent` (the MCP SDK client does) accept fields without a description.

### Changed
- Validation errors use zod 4's wording, e.g. `Invalid input: expected string, received undefined` instead of
  `Required`, and `Too small: expected number to be >=1` for an out-of-range setting. What is accepted or rejected is
  unchanged.
- Advertised input schemas no longer say `additionalProperties: false`. Unknown arguments were always ignored, and
  the schema now says so; nested filter groups in `search_dataset` are inlined instead of using a deep `$ref`.

## 1.2.0

### Added
- **Free local rendering:** pages that are JavaScript-only app shells (`needs_javascript`, `empty`) are rendered in
  your installed Chrome or Edge (headless, via `playwright-core`, no browser download) before anything is sent to
  Bright Data. Live-tested: Spotify, Instagram, YouTube, TikTok, Figma, Duolingo, Excalidraw and others now come back
  with real content for free.
- Rendered pages are classified again, so a bot wall that only appears after JavaScript runs (Reddit's CAPTCHA) still
  goes to Bright Data, with a reason chain such as `needs_javascript > render:captcha`.
- One shared browser process for all sessions, a fresh incognito context per render, images/media/fonts skipped,
  idle shutdown after 2 minutes, bounded concurrency, cancellation.
- In-browser SSRF guard: every request the page makes is checked against private, loopback, link-local and metadata
  ranges (after DNS resolution), and a render that ends on such an address is discarded.
- Host memory now also remembers hosts that need rendering, so later pages skip the doomed direct attempt.
- `session_stats` reports `local_rendering` and `free.local_renders` / `free.fallbacks`; savings include renders.
- `LOCAL_RENDER`, `CHROME_PATH`, `LOCAL_RENDER_TIMEOUT`, `LOCAL_RENDER_ON`, `LOCAL_RENDER_IDLE`,
  `LOCAL_RENDER_CONCURRENCY`.

### Fixed
- Client-side shells whose first `<script>` sits deep in the page (Instagram: ~90 KB in) were classified as content.
- Reddit's "Prove your humanity" page is recognised as a bot wall.

### Changed
- Fallback notes read `free routes were not usable (...)`; `session_stats.free.direct_misses` is replaced by
  `local_renders` and `fallbacks`.

## 1.1.0

### Added
- **Direct-first fetching** (`FETCH_STRATEGY=auto`, the default): `scrape_as_markdown`, `scrape_batch`,
  `scrape_as_html` and `extract` fetch pages directly from your machine for free and fall back to Bright Data Web
  Unlocker only when the site blocks (Cloudflare, DataDome, Imperva, PerimeterX, AWS WAF, CAPTCHAs), needs
  JavaScript, fails or returns a non-text type. Hosts that blocked are remembered for 30 minutes.
- `FETCH_STRATEGY=direct` (never billed) and `FETCH_STRATEGY=brightdata` (always Web Unlocker, the upstream behaviour).
- **Free mode:** with no `API_TOKEN` the server starts with the free tools only, instead of refusing to start.
- **SSRF guard** for direct fetches: private, loopback, link-local and cloud-metadata addresses are refused on every
  redirect hop, by IP and after DNS resolution (`DIRECT_ALLOW_PRIVATE=true` to opt out).
- A trusted `[server]` note after each page result says whether it was fetched for free, billed (and why), or cached.
- `session_stats` reports `fetch_strategy`, free direct fetches, fallbacks and estimated savings.
- `scrape_batch` items carry a `source` field (`direct`, `brightdata` or `cache`).
- `scripts/live-smoke.mjs` (real-site smoke test) and `scripts/render-assets.mjs` (README images).
- `DIRECT_TIMEOUT`, `DIRECT_MAX_BYTES`, `DIRECT_USER_AGENT`, `DIRECT_ALLOW_PRIVATE`, `--fetch` flag.

### Changed
- Node.js 22+ is required (Node 20 is end-of-life).

## 1.0.0

Initial rebuild of `@brightdata/mcp` 4.1.0 in strict TypeScript with the same tool names and environment variables:
one hardened API client (timeouts, jittered retries, `Retry-After`, bounded concurrency, cancellation), response
caching, pagination, spending guards (`BUDGET_MAX_REQUESTS`, `MAX_RECORDS_PER_RUN`, pre-billing input validation),
per-session isolation, a built-in Streamable HTTP transport, structured output for first-party tools, browser session
reaping, `scraping_browser_press_key` and `scraping_browser_close`, a working Docker image, and fixes for the
upstream bugs (batch limits, rate limit and free-tier message coverage, `extract` session selection).
