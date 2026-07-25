# PF Summary: provider rank-score calibration

## What was built

- Added per-provider relevance-score calibration before fusion ranking.
  - Default with no new config: `minmax` over each provider's current result set.
  - Explicit `rank`: `1 / rawRank`.
  - Explicit `fixed`: validated piecewise-linear `{ input, output }` curve with endpoint clamping.
  - A curve without an explicit strategy also selects `fixed`.
- Added set-wide rank fallback for singleton sets, constant native scores, or any missing, non-finite, or negative native score. Falling back as a complete set avoids mixing native and synthetic score scales.
- Kept calibrated relevance in `[0,1]`, then applied existing source-type/trust quality adjustments and the existing optional provider weight. A configured weight above `1` can intentionally produce a merge input above `1`.
- Added deterministic merged-result ordering by final calibrated/adjusted score, selected-provider priority, and original rank. Complete ties retain insertion order.
- Exposed provider priority in ranking explanations and updated top-level ranking sort metadata.
- Added `providerConfig.<id>.scoreCalibration` to TypeScript types, the OpenClaw plugin config schema, and README configuration/reference material.
- Added fixed-curve preflight validation before provider execution so invalid calibration config does not call a provider or consume retries.
- Added table-driven and integration coverage for minmax, rank, fixed interpolation/clamping, implicit fixed selection, singleton/equal/missing/NaN/negative inputs, invalid curves, provider-scale fairness, weights, and stable ties.
- Rebuilt tracked `dist/` package artifacts.

## Files added

- `test/score-calibration.test.ts` — table-driven strategy, interpolation, fallback, range, and invalid-config tests.
- `PF-SUMMARY.md` — this handoff.

## Files changed

- `README.md` — documents the default, all strategies, curve format, degenerate fallback, score/weight ordering, tie order, and evidence semantics.
- `openclaw.plugin.json` — adds the per-provider `scoreCalibration` schema.
- `src/types.ts` — adds calibration config/curve types and provider-priority ranking metadata.
- `src/result-normalizer.ts` — adds calibration, curve validation/interpolation, rank fallback, and reusable post-calibration quality scoring.
- `src/search-fusion.ts` — applies calibration before weights/merge, validates config before calls, and adds stable provider-priority tie handling.
- `test/manifest.test.ts` — verifies the new plugin config schema.
- `test/search-fusion.test.ts` — adds cross-provider fairness, stable ordering, and invalid-config integration tests; updates expected calibrated scores and ranking metadata.
- `dist/src/types.d.ts` — rebuilt type declarations.
- `dist/src/result-normalizer.d.ts`
- `dist/src/result-normalizer.js`
- `dist/src/search-fusion.js`

## Verification and observed results

Dependency installation:

- `npm install`
  - Initial attempt stopped before installation with `EROFS` because npm selected `/home/vac/.npm` as its cache, outside the writable worktree.
- `NPM_CONFIG_CACHE="$PWD/.npm-cache" npm install`
  - Succeeded: 554 packages added, 555 audited.
  - npm reported 12 dependency-tree vulnerabilities: 8 moderate, 3 high, 1 critical.
  - The temporary local npm cache and npm-generated `package-lock.json` were removed afterward; this repository remains pnpm-lockfile managed.

Required pre-change baseline:

- `npm test`
  - Passed: 131 tests, 0 failures, 0 skipped.

Focused implementation verification:

- `node --test --experimental-test-module-mocks --import tsx test/score-calibration.test.ts test/manifest.test.ts test/result-normalizer.test.ts test/search-fusion.test.ts`
  - Passed: 65 tests, 0 failures.

Final verification after the packaging refactor:

- `npm run build`
  - Passed; tracked `dist/` artifacts rebuilt successfully.
- `npm test`
  - Passed: 137 tests, 0 failures, 0 skipped.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics.
- `pnpm run plugin:check`
  - `Status: PASS`; 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`
  - `Status: PASS`; 1 fixture, 0 breakages, 0 issues.
- `git diff --check`
  - Passed with no whitespace errors.

## Known gaps and risks

- Verification used synthetic provider distributions and the repository's mocked runtime. No paid or live provider calls were made, so empirical fixed-curve points still need to come from representative provider datasets.
- Default minmax calibration is intentionally query/result-set relative; fixed curves are the option for stable provider-specific absolute calibration.
- Provider weights are deliberately post-calibration. Values above `1` can move the weighted score above `[0,1]`, as documented.
- The npm install audit reported 12 vulnerabilities in the installed dependency tree. Dependency remediation was outside this ranking feature and no dependency versions were changed.
- Package/plugin versions remain `0.2.2`; a 0.3.x release/version/changelog update was not performed because the task requested the backlog feature implementation, not release publication.

## Suggested follow-ups

- Collect labeled score distributions from real providers and publish recommended fixed curves for providers whose native scores are stable enough to calibrate globally.
- Add offline ranking-quality metrics such as NDCG or pairwise preference accuracy over captured provider fixtures.
- Handle the version/changelog/publish step as a separate 0.3.x release task.
