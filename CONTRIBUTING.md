# Contributing

1. `npm install` (builds via the `prepare` script), then `npm test`. All tests run offline against a fake Bright Data
   API and local test pages. The `browser` and `render` tests drive a real headless Chrome or Edge if one is installed
   and are skipped otherwise (CI runners have Chrome, so they always run there).
2. Keep tool names and environment variables compatible with `@brightdata/mcp` unless there's a strong reason.
3. Every request to Bright Data goes through `BrightDataClient` (`src/http/client.ts`); every page fetch goes through
   `PageFetcher` (`src/services/pages.ts`), which owns the route order: direct fetch, then local render
   (`src/services/render.ts`), then Bright Data. Don't call `fetch` or launch a browser directly from tools.
4. Tools that return web content must set `untrusted: true`. Tools that work without a token set `free: true`.
5. Add a test for every behaviour change; for anything billed, test that guards stop it *before* the upstream call.
   New bot-wall signatures in `classifyDirect` need a test that a normal page containing similar words still passes.
6. If you change a README image, edit `assets/src/*.html` and run `npm run render:assets`. The demo image is built
   from a real run: `node scripts/live-smoke.mjs --json assets/src/live-run.json` first.
