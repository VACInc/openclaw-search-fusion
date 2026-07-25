REJECT

1. **High — `src/search-fusion.ts:919` — override mode can return the wrong display/navigation URL.** The merged result takes `representative.item.url`, but `src/result-normalizer.ts:177-197` built that value with the fixed legacy tracking list before the fuzzy-dedupe configuration was available. Consequently, a parameter deliberately made meaningful with `trackingParamMode: "override"` remains in `canonicalUrl` but is silently removed from `url`. This defeats the documented mitigation for sites where `ref` controls routing. I ran an inline one-provider fixture with:

   ```sh
   node --experimental-test-module-mocks --import tsx --input-type=module
   ```

   using `{ trackingParams: [], trackingParamMode: "override" }` and the result URL `https://example.com/story?ref=one`. The observed output was:

   ```json
   {
     "url": "https://example.com/story",
     "canonicalUrl": "https://example.com/story?ref=one",
     "originalUrl": "https://example.com/story?ref=one"
   }
   ```

   The test at `test/search-fusion.test.ts:1219-1270` checks only `canonicalUrl`, so it does not catch the broken returned URL.

2. **High — `src/search-fusion.ts:1044-1049` — override-mode citations can be attributed to the wrong evidence row.** `buildEvidenceTable` applies the configured fuzzy analysis to `answer.citations`, but those strings have already been irreversibly processed by the fixed legacy normalizer at `src/result-normalizer.ts:216-230,248-258`. A meaningful `ref` is therefore gone before override-mode matching runs. I ran an inline three-provider fixture with distinct rows for `/story` and `/story?ref=one`, plus an answer citation to `/story?ref=one`, under `{ trackingParams: [], trackingParamMode: "override" }`. The observed output was:

   ```json
   {
     "answerCitations": [["https://example.com/story"]],
     "evidence": [
       {
         "canonicalUrl": "https://example.com/story?ref=one",
         "support": 0,
         "citationProviders": []
       },
       {
         "canonicalUrl": "https://example.com/story",
         "support": 1,
         "citationProviders": ["gamma"]
       }
     ]
   }
   ```

   This contradicts the summary claim that every merged variant URL resolves to its final row and corrupts user-visible provenance. The evidence test at `test/search-fusion.test.ts:978-1027` covers only default tracking behavior; there is no citation assertion for override mode.

Summary claims I could not verify:

- The historical first plain `npm install` failure with `EROFS` cannot be reconstructed from the final tree. The successful `npm install --cache .npm-cache` claim was independently reproduced: 554 packages added, 555 audited, with 8 moderate, 3 high, and 1 critical vulnerability.
- The historical claim that no live third-party provider API was called cannot be proven after the fact. My reruns used the repository's deterministic fixtures and inspector mocks.

All cited final checks were independently rerun: baseline `main` passed 131/131 tests; the branch passed 168/168 with zero failures/skips; `npx tsc --noEmit`, `npm run build`, both plugin-inspector commands, and `git diff --check main...HEAD` exited 0. The fresh build reproduced the four changed tracked `dist/` files byte-for-byte. Those passing suites do not cover the two failures above.
