# Contributing

1. `npm install` (builds via the `prepare` script), then `npm test`. All tests run offline against a fake Bright Data
   API; the browser test uses a local Chrome or Edge if one is installed and is skipped otherwise.
2. Keep tool names and environment variables compatible with `@brightdata/mcp` unless there's a strong reason.
3. Every request to Bright Data goes through `BrightDataClient` (`src/http/client.ts`); every page fetch goes through
   `PageFetcher` (`src/services/pages.ts`). Don't call `fetch` directly from tools.
4. Tools that return web content must set `untrusted: true`. Tools that work without a token set `free: true`.
5. Add a test for every behaviour change; for anything billed, test that guards stop it *before* the upstream call.
6. If you change a README image, edit `assets/src/*.html` and run `npm run render:assets`.
