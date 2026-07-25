REJECT

1. **HIGH — `src/search-fusion.ts:702-727`, `test/search-fusion.test.ts:1271-1330` — original rank is applied before provider priority, contrary to the required tie order.** `computeMergedScoreBreakdown` adds `bestRankBonus` to the primary score before `compareMergedCandidates` can apply `providerPriority`. Therefore two results with identical calibrated scores but different original ranks no longer have equal primary scores: the lower-priority provider's rank-1 result beats the higher-priority provider's rank-2 result. I ran an integration probe with both providers fixed to calibrated scores `[0.5, 0.5]`, request priority `["brave", "gemini"]`, and `sourceTierMode: "off"`. The observed output was:

   ```text
   provider scores: [["brave",[0.5,0.5]],["gemini",[0.5,0.5]]]
   merged order: [["brave-1",0,1,0.85],["gemini-1",1,1,0.85],["brave-2",0,2,0.81],["gemini-2",1,2,0.81]]
   ```

   The specified order—calibrated score, then provider priority, then original rank—requires both Brave results to precede both Gemini results in this case. The new stable-tie test does not catch this because it places its two items in separate `results` and `web.results` arrays; normalization assigns both `rawRank: 1`, so the test never exercises priority versus differing original ranks. This also makes the documented `README.md:272` sort order materially misleading.

2. **HIGH — `src/result-normalizer.ts:259-297`, `test/score-calibration.test.ts:48-60` — configured fixed calibration is discarded for singleton and constant-score result sets.** The singleton and constant checks execute before the fixed-curve branch. A fixed curve is absolute and remains well-defined when a provider returns one result or several equal native scores, but the implementation replaces it with rank scores and can inflate a low-confidence singleton to `1`. I ran `calibrateProviderScores` with an identity fixed curve and observed:

   ```text
   fixed singleton { scores: [ 1 ], strategy: 'rank', fallback: 'single-result' }
   fixed constant { scores: [ 1, 0.5 ], strategy: 'rank', fallback: 'constant-scores' }
   ```

   The configured curve maps native score `0.1` to `0.1`; neither observed result honors it. This defeats the fixed strategy's provider-specific absolute calibration in common degenerate sets and can reintroduce the exact cross-provider inflation the feature is intended to remove. The table test covers singleton/equal fallback only with default minmax configuration, not with `strategy: "fixed"`.

3. **MEDIUM — `openclaw.plugin.json:198-238`, `test/manifest.test.ts:60-78` — the plugin config schema accepts `strategy: "fixed"` without the required curve.** The runtime later rejects this configuration on every search, so an invalid fixed calibration passes the existing config surface and fails only during use. I compiled the checked-in schema with Ajv, validated the config, and then ran a broker request:

   ```text
   schema accepts fixed without curve: true null
   search calls: 0 provider failure: {
     provider: 'brave',
     error: 'Fixed score calibration requires at least two curve points.'
   }
   ```

   The runtime preflight prevents a provider call, but it does not make the accepted plugin configuration usable. The manifest test checks the enum and `minItems` only; it does not assert the conditional requirement that selecting `fixed` requires `curve`.

Summary claims I could not verify:

- The historical plain `npm install` EROFS failure, cache-based install result, and exact vulnerability counts cannot be reproduced from the final tree because the temporary cache and generated lockfile were removed; rerunning installation would also violate this review's write restrictions.
- The pre-change `npm test` pass cannot be rerun without checking out or materializing `main`. `main` does contain 131 static test declarations, but that does not prove the reported historical pass.
- The focused command's claimed count is not reproducible: the exact command currently passes **66**, not 65, tests.
- I did not execute the exact `npm run build` command because it writes tracked `dist/` files. I instead captured TypeScript's build emit in memory: 0 diagnostics, 20 outputs, and 0 byte mismatches against the checked-in `dist/` artifacts.

Current-tree verification did reproduce the substantive green checks: `npm test` passed 137/137, `npx tsc --noEmit` exited 0, both plugin-inspector commands reported `Status: PASS` with 0 breakages/issues, and `git diff --check main...HEAD` exited 0. The additional `codex review --base main` closeout could not initialize because its app-server client attempted a write on the read-only filesystem.
