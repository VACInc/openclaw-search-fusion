REJECT

1. [HIGH] `dist/src/search-fusion.js:7` — The declared package/runtime entrypoint was not rebuilt, so this checkout does not actually ship the provider-native count behavior. `package.json:6-12` and `package.json:23-25` route both package consumers and OpenClaw to `dist/index.js`, but `git diff --name-only main...HEAD -- dist` produced no output. The committed dist still has `DEFAULT_COUNT_PER_PROVIDER = 5` and clamps every provider to 10 at `dist/src/search-fusion.js:381`; its public schema still caps `count` at 10 at `dist/index.js:27-30`. I ran the same mocked Exa request through source and dist with `node --import tsx --input-type=module`; the copied result was:

   ```text
   entrypointBehavior: {
     sourceExaCount: 100,
     publishedDistExaCount: 5
   }
   ```

   The source tests and static manifest can therefore pass while a fresh checkout/direct OpenClaw load continues to execute the old behavior and ignores `providerConfig.<id>.maxResults`. Regenerate and include the tracked `dist` JS/declarations, then test the declared entrypoint.

2. [HIGH] `src/search-fusion.ts:999` — The deeper pulls are still emitted wholesale through `ranking.dropped`, contradicting the task's requirement that they feed ranking without output bloat. This maps every candidate beyond `maxMergedResults` into a model-visible object; only `results` is capped. A no-file transport probe using `node --import tsx --input-type=module` returned 100 unique Exa results plus 20 unique Tavily results with `maxMergedResults: 7` and default output flags. Its copied output was:

   ```text
   uniqueCandidates: {
     returnedResults: 7,
     rankingDroppedCount: 113,
     rankingDroppedArrayLength: 113,
     providerRunVisibleResults: 7,
     serializedBytes: 35677
   }
   ```

   The new test at `test/search-fusion.test.ts:1577` checks only `droppedCount`; it never checks or bounds `ranking.dropped.length`. Keep the aggregate count, but omit or separately cap detailed dropped records in default output.

3. [HIGH] `src/search-fusion.ts:1473` — The new provider-run filter is URL membership, not a size bound, and merged `variants`/`rankings` are also unbounded. Multiple pulled entries that canonicalize to one surviving URL all pass the filter, while `mergeResults` retains every variant. A default-output mocked Exa response containing 100 entries for one canonical URL produced:

   ```text
   duplicateCanonicalUrl: {
     returnedResults: 1,
     mergedVariants: 100,
     mergedRankings: 100,
     providerRunVisibleResults: 100,
     serializedBytes: 73181
   }
   ```

   This is directly relevant to a dedupe broker: exact duplicate URLs and distinct tracking URLs that canonicalize together are accepted transport states. The existing new test uses only unique URLs, so its assertion that provider-run result count equals 7 does not exercise this path. Bound or deduplicate per-URL evidence in every default model-visible surface; preserve complete evidence only behind the audit opt-in.

4. [MEDIUM] `README.md:163` — The new documentation and summary claim that `rawCount` reports the complete pull, but the implementation counts only normalized URL-bearing results (`src/search-fusion.ts:1199`). A mocked transport response with three result objects, one lacking a URL, produced:

   ```text
   rawCountSemantics: {
     transportResults: 3,
     rawCount: 2,
     discardedCount: 1
   }
   ```

   Either report the actual transport result count or document `rawCount` as the normalized mergeable-result count. The current wording is unsafe for the audit consumers explicitly mentioned in the README.

Verification rerun:

- `npm test` — exit 0; 137 tests, 137 passed, 0 failed, 0 skipped, 0 todo.
- `npx tsc --noEmit` — exit 0; no diagnostics.
- `pnpm run plugin:check` — exit 0; PASS, 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime` — exit 0; PASS, 1 fixture, 0 breakages, 0 issues. Its report says it captured `dist/index.js`, but it does not assert the count schema or runtime count behavior, so it missed finding 1.
- `git diff --check` and `git diff --check main...HEAD` — exit 0; no output.
- Added-line scan for placeholders/TODOs, literal API keys, eval, and unsafe subprocess additions — no matches.
- The Exa/Tavily mappings were confirmed from installed OpenClaw 2026.5.6 source. The Parallel 40-result schema, paid `advanced_settings.max_results` mapping, and free-MCP client-side slice were confirmed from the official OpenClaw `v2026.7.2-beta.4` source.

Summary claims I could not verify:

- The pre-edit `npm test` result of 131/131 was not rerun because the completed checkout contains the patch and only `PF-REVIEW.md` may be changed. `git grep` confirms that `main` contains 131 test declarations, but that does not prove the historical run passed.
- The exact `npm install --cache .npm-cache` transcript (554 added / 555 audited and the stated audit severity counts), and the preceding read-only-cache failure, could not be reproduced without allowing dependency/lock/cache writes. The current installed top-level dependency tree is complete according to `npm ls --depth=0`.
- No live paid-provider calls were made, matching the summary's disclosed gap; native HTTP behavior is source-verified rather than credentialed end-to-end verified.
