# PF Fixes

## Finding 1: published `dist` entrypoint was stale

**Reproduced:** Yes.

Before editing, the same mocked Exa request through source and the published runtime produced:

```text
sourceExaCount: 100
publishedDistExaCount: 5
```

**Root cause and fix:** The builder changed TypeScript source and schemas without rebuilding the tracked package/OpenClaw runtime. `npm run build` regenerated `dist/index.js`, `dist/src/search-fusion.js`, and `dist/src/types.d.ts`, including the provider contracts, clamping, `maxResults` type, and public count ceiling.

**Regression test:** Added `test/dist-entrypoint.test.ts`. It verifies that `package.json` main/export and the OpenClaw extension all name `./dist/index.js`, registers that compiled plugin, asserts the public count maximum is 100, and observes Exa delegated counts `[100, 17]` for the native default and `providerConfig.exa.maxResults` override.

**After-fix evidence:**

```text
sourceExaCount: 100
publishedDistExaCount: 100
```

The declared-entrypoint test passed.

## Finding 2: all dropped-result details escaped the global cap

**Reproduced:** Yes.

The 100-Exa plus 20-Tavily unique-candidate probe with `maxMergedResults: 7` produced:

```text
returnedResults: 7
rankingDroppedCount: 113
rankingDroppedArrayLength: 113
providerRunVisibleResults: 7
serializedBytes: 34945
```

**Root cause and fix:** `mergeResults` correctly needed the complete ranked pool, but the public response returned its complete `ranking.dropped` array unconditionally. The exposure layer now keeps `droppedCount` while returning `dropped: []` by default. `includeRawPayloads: true` retains the complete detailed audit records.

**Regression tests:** The deep-pull/global-cap test now asserts `droppedCount === 113` and `dropped` is empty. The existing raw-output max-merged test continues to assert the detailed dropped record when audit output is enabled.

**After-fix evidence:**

```text
returnedResults: 7
rankingDroppedCount: 113
rankingDroppedArrayLength: 0
providerRunVisibleResults: 7
serializedBytes: 14665
```

## Finding 3: duplicate canonical URLs escaped every evidence bound

**Reproduced:** Yes.

A default-output Exa response with 100 items for one canonical URL produced:

```text
returnedResults: 1
mergedVariants: 100
mergedRankings: 100
providerRunVisibleResults: 100
evidenceProviderResults: 100
serializedBytes: 101425
```

**Root cause and fix:** Provider-run visibility used canonical-URL membership, so every duplicate for a surviving URL passed. Merged `variants` and `rankings` also exposed the entire merge group. The exposure layer now selects the first ranked evidence item per contributing provider for each returned merged URL. Provider runs are filtered by the selected internal evidence objects, and the evidence table is built from the bounded visible variants. Full normalized runs and all duplicate evidence remain available with `includeRawPayloads: true`.

**Regression test:** Added a two-provider duplicate test with 100 Exa and 20 Tavily items for the same URL. Default output asserts two variants, two rankings, one visible provider-run item per provider, and two evidence-table entries. Audit output asserts all 120 variants, rankings, provider-run items, and evidence entries remain available.

**After-fix evidence for the reviewer's single-provider shape:**

```text
returnedResults: 1
mergedVariants: 1
mergedRankings: 1
providerRunVisibleResults: 1
evidenceProviderResults: 1
serializedBytes: 3868
```

## Finding 4: `rawCount` excluded discarded transport items

**Reproduced:** Yes.

For three transport results, one without a URL:

```text
transportResults: 3
rawCount: 2
discardedCount: 1
```

**Root cause and fix:** Successful runs assigned `rawCount` from `normalized.results.length`, excluding items retained in `normalized.discardedResults`. It now uses the sum of normalized and discarded items, which equals the number of supported transport result-array items processed.

**Regression test:** The missing-URL provenance test now asserts both `providerRuns[0].rawCount` and `providerDetails[0].rawCount` equal 2 for its two-item response while `discardedCount` remains 1. README and type comments define the same semantics.

**After-fix evidence:**

```text
transportResults: 3
rawCount: 3
discardedCount: 1
```

## Final verification

```text
npm run build
  exit 0

node --test --experimental-test-module-mocks --import tsx test/dist-entrypoint.test.ts test/search-fusion.test.ts
  78 passed, 0 failed

npm test
  197 passed, 0 failed, 0 skipped, 0 todo

npx tsc --noEmit
  exit 0, no diagnostics

pnpm run plugin:check
  PASS, 1 fixture, 0 breakages, 0 issues

pnpm run plugin:check:runtime
  PASS, 1 fixture, 0 breakages, 0 issues

git diff --check
  exit 0, no output
```

`codex-review --mode local --no-yolo` and its normal-mode retry both failed before analysis with `failed to initialize in-process app-server client: Read-only file system`. This is recorded as an environment-blocked check, not a clean review.
