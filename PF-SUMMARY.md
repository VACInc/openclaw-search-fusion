# PF Summary: provider rank-score calibration

## Final implementation

- Calibrates every provider's native relevance scores before cross-provider
  fusion:
  - default `minmax` within the provider result set
  - explicit `rank` using `1 / rawRank`
  - explicit or curve-implied `fixed` piecewise-linear calibration
- Keeps fixed calibration absolute for finite singleton and constant-score
  result sets. Those sets no longer fall through to rank calibration.
- Uses complete-set rank fallback when a native-score strategy encounters a
  missing, non-finite, or negative score. Default minmax also uses rank fallback
  for singleton and constant-score sets.
- Applies deterministic final ordering by merged score, selected-provider
  priority, original rank, and stable insertion order. Original rank is no
  longer folded into the numeric score before provider priority is evaluated.
- Retains `scoreBreakdown.bestRankBonus` as a backward-compatible payload field
  with value `0`; `bestRank` remains available in the explicit tie-breaker
  metadata.
- Requires a curve at the plugin-schema boundary whenever
  `strategy: "fixed"` is selected. Runtime curve validation remains a second
  line of defense.
- Applies existing source-type/trust adjustments and optional provider weights
  after calibration.
- Documents the default, fixed-calibration degeneracies, schema requirement,
  and deterministic ordering.
- Rebuilt the tracked package artifacts in `dist/`.

## Review findings resolved

All three findings in `PF-REVIEW.md` reproduced before code changes and have
root-cause fixes plus regression coverage. Detailed before/after evidence is in
`PF-FIXES.md`.

## Files added

- `test/score-calibration.test.ts` — table-driven calibration, degeneracy,
  interpolation, range, and invalid-config coverage.
- `PF-SUMMARY.md` — final implementation and verification handoff.
- `PF-FIXES.md` — per-finding reproduction, fix, evidence, and test report.

## Files changed

- `README.md`
- `openclaw.plugin.json`
- `src/types.ts`
- `src/result-normalizer.ts`
- `src/search-fusion.ts`
- `test/manifest.test.ts`
- `test/search-fusion.test.ts`
- `dist/src/types.d.ts`
- `dist/src/result-normalizer.d.ts`
- `dist/src/result-normalizer.js`
- `dist/src/search-fusion.js`
- `PF-SUMMARY.md`

## Verification and observed results

Focused fix verification:

- `node --test --experimental-test-module-mocks --import tsx test/score-calibration.test.ts test/manifest.test.ts test/result-normalizer.test.ts test/search-fusion.test.ts`
  - First fix iteration: 67 passed, 1 failed. The failure was an existing exact
    score assertion that still included the removed `0.31` rank bonus.
  - After correcting that expected contract value: 68 passed, 0 failed.

Required full verification:

- `npm run build`
  - Passed; TypeScript build completed and tracked `dist/` artifacts were
    rebuilt.
- `npm test`
  - Passed: 139 tests, 0 failures, 0 skipped.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics.
- `pnpm run plugin:check`
  - `Status: PASS`; 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`
  - `Status: PASS`; 1 fixture, 0 breakages, 0 issues.
- `git diff --check`
  - Passed with no whitespace errors.

Post-build packaged-code probes:

- Fixed identity calibration returned `{ scores: [0.1], strategy: "fixed" }`
  for a singleton and `{ scores: [0.1, 0.1], strategy: "fixed" }` for equal
  native scores.
- Four equal-score merged results ordered as Brave ranks 1 and 2, then Gemini
  ranks 1 and 2, all at score `0.5`.
- OpenClaw's `validateJsonSchemaValue` rejected fixed calibration without a
  curve at `providerConfig.brave.scoreCalibration.curve`.

Closeout review:

- `codex review --uncommitted`
  - Could not initialize. Exact error:
    `failed to initialize in-process app-server client: Read-only file system
    (os error 30)`.
  - No clean Codex-review result is claimed.

## Known gaps and risks

- No live or paid provider calls were made. Ranking behavior was verified with
  deterministic synthetic distributions and the repository's mocked runtime.
- Fixed-curve points still need to be derived from representative provider
  datasets.
- The dependency installation and pre-change baseline reported by the builder
  were not re-run during this fix pass; dependencies were already present in
  the worktree. This report makes no new claim about historical install output
  or vulnerability counts.
- The package/plugin version remains `0.2.2`; release versioning and publishing
  are outside this task.

## Suggested follow-ups

- Collect labeled native-score distributions and publish recommended fixed
  curves for providers with stable score semantics.
- Add offline ranking-quality metrics such as NDCG or pairwise preference
  accuracy over captured, redacted provider fixtures.
- Run the Codex closeout review in an environment where its app-server state
  directory is writable.
