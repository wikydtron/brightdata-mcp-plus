# Changelog

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
