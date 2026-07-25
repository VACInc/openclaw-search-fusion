# PF Summary: Provider-native result counts

## Outcome

The provider-native count feature now ships through the declared package/OpenClaw entrypoint and keeps default model-visible output bounded.

- Known providers default to their verified adapter ceilings: Exa 100, Parallel 40, Parallel Free 40, Tavily 20, and other catalog providers 10.
- Unknown adapters retain the historical default of 5 and conservative ceiling of 10.
- `providerConfig.<id>.maxResults` can lower but cannot raise a provider's verified ceiling.
- Per-call `count`, legacy per-provider `count`, and shared `countPerProvider` are clamped to the resolved ceiling.
- `maxMergedResults` still bounds merged results after the deeper pool is normalized, deduplicated, and ranked.
- Default output retains aggregate `ranking.droppedCount` but omits detailed dropped records.
- Default merged variants, rankings, provider-run results, and evidence-table provider evidence retain one item per contributing provider per returned merged URL.
- `includeRawPayloads: true` restores complete normalized provider runs, duplicate merged evidence, dropped-result details, and raw responses for audit use.
- `rawCount` now counts every transport result item in supported arrays, including items discarded for a missing URL.
- Tracked `dist` JavaScript and declarations were rebuilt.

## Review findings resolved

All four findings in `PF-REVIEW.md` reproduced before changes and pass equivalent probes after the fixes.

1. The source/published Exa default changed from `100 / 5` before the rebuild to `100 / 100`.
2. A 120-candidate, 7-result probe still reports `droppedCount: 113`, while default `ranking.dropped.length` changed from 113 to 0 and serialized output fell from 34,945 to 14,665 bytes.
3. A 100-item duplicate-URL probe changed merged variants, merged rankings, provider-run visible results, and evidence-table provider evidence from 100 each to 1 each; serialized output fell from 101,425 to 3,868 bytes.
4. A three-item transport response containing one missing-URL item now reports `rawCount: 3` and `discardedCount: 1`, instead of `rawCount: 2`.

Detailed per-finding evidence is in `PF-FIXES.md`.

## Files added or changed

- `src/search-fusion.ts` — provider count contracts and clamping, corrected raw counts, bounded default evidence, and audit-only dropped details.
- `src/types.ts` — `maxResults` config and clarified output semantics.
- `index.ts` — public count ceiling and audit-output description.
- `openclaw.plugin.json` — count/maxResults schema and audit-output description.
- `README.md` — provider count table, clamping, raw-count semantics, and bounded/audit output behavior.
- `test/search-fusion.test.ts` — native-count, clamping, global-cap, dropped-detail, duplicate-evidence, audit opt-in, and raw-count regression coverage.
- `test/index.test.ts` — public tool count schema coverage.
- `test/manifest.test.ts` — manifest count/maxResults schema coverage.
- `test/dist-entrypoint.test.ts` — executes the declared `dist/index.js` entrypoint and verifies Exa's 100 default plus a 17-result config override.
- `dist/index.js`, `dist/src/search-fusion.js`, `dist/src/types.d.ts` — rebuilt published runtime and declarations.
- `PF-SUMMARY.md` — final implementation and verification handoff.
- `PF-FIXES.md` — reviewer-finding reproduction and resolution record.

## Verification run

- `npm run build` — exit 0; tracked `dist` regenerated.
- `node --test --experimental-test-module-mocks --import tsx test/dist-entrypoint.test.ts test/search-fusion.test.ts` — exit 0; 78 passed, 0 failed.
- `npm test` — exit 0; 197 passed, 0 failed, 0 skipped, 0 todo.
- `npx tsc --noEmit` — exit 0; no diagnostics.
- `pnpm run plugin:check` — exit 0; PASS, 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime` — exit 0; PASS, 1 fixture, 0 breakages, 0 issues.
- `git diff --check` — exit 0; no output.
- Reviewer-equivalent mocked transport probes — exit 0 with the corrected values listed above.

The `codex-review` closeout helper was attempted in both `--no-yolo` and normal modes. Both exited 1 before reviewing code because the managed environment could not initialize Codex app-server/PATH-alias state on a read-only filesystem. No clean automated-review result is claimed.

## Known gaps and risks

- No live paid-provider requests were made. Adapter request mappings are source-verified and broker behavior is transport-mock verified.
- Provider ceilings can drift with future OpenClaw/provider adapter releases and must be rechecked when those dependencies change.
- `includeRawPayloads: true` deliberately opts into potentially large audit output.
- The final Codex advisory review was environment-blocked as described above; mandatory tests, inspectors, probes, and manual diff hygiene all passed.

## Suggested follow-ups

- Run credentialed staging smoke tests for Exa, Tavily, and paid Parallel before release if credentials are available.
- Recheck the provider count contract table when updating OpenClaw or provider plugins.
- Rerun `codex review --uncommitted` in an environment where Codex state is writable if an additional automated review is required.
