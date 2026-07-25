# PF Fix Report

## Finding 1: original rank preceded provider priority

**Reproduced:** Yes.

Before the fix, an integration probe configured both Brave and Gemini with a
fixed curve that mapped both native scores to `0.5`, used provider order
`["brave", "gemini"]`, and supplied two results per provider in one real
`results` array. The merged output was:

```text
[["brave-1",0,1,0.85],["gemini-1",1,1,0.85],["brave-2",0,2,0.81],["gemini-2",1,2,0.81]]
```

This reproduced the finding: `bestRankBonus` changed the primary score before
the comparator evaluated provider priority.

**Fix:** Removed original rank from numeric score construction. The
backward-compatible `bestRankBonus` payload field is now `0`, while
`compareMergedCandidates` applies provider priority before `bestRank` and then
stable insertion order. README and type documentation now state this
explicitly.

**After-fix evidence:** The same source probe and a separate post-build
`dist/src/search-fusion.js` probe returned:

```text
[["brave-1",0,1,0.5],["brave-2",0,2,0.5],["gemini-1",1,1,0.5],["gemini-2",1,2,0.5]]
```

**Regression test added:**

- `runSearchFusion applies provider priority before original rank for calibrated ties`
  creates two same-array results for each of two providers, asserts the complete
  four-result order, and asserts that no rank bonus is embedded in the score.

## Finding 2: fixed calibration was discarded for singleton and constant sets

**Reproduced:** Yes.

Before the fix, an identity fixed curve produced:

```text
fixed singleton { scores: [ 1 ], strategy: 'rank', fallback: 'single-result' }
fixed constant { scores: [ 1, 0.5 ], strategy: 'rank', fallback: 'constant-scores' }
```

**Fix:** Moved the fixed-curve application ahead of the minmax-only singleton
and constant-score fallback checks. Native-score validation still happens
first, so missing, non-finite, or negative sets retain the documented complete
rank fallback.

**After-fix evidence:** Both source and rebuilt-package probes produced:

```text
fixed singleton { scores: [ 0.1 ], strategy: 'fixed' }
fixed constant { scores: [ 0.1, 0.1 ], strategy: 'fixed' }
```

**Regression cases added to the table-driven calibration test:**

- `fixed curve calibrates a singleton absolutely`
- `fixed curve calibrates equal scores absolutely`

## Finding 3: manifest accepted fixed calibration without a curve

**Reproduced:** Yes.

Before the fix, Ajv accepted this real manifest configuration:

```json
{
  "providerConfig": {
    "brave": {
      "scoreCalibration": {
        "strategy": "fixed"
      }
    }
  }
}
```

The probe printed `schema accepts fixed without curve: true`; a broker request
then made zero provider calls and failed at runtime with
`Fixed score calibration requires at least two curve points.`

**Fix:** Added a JSON Schema `if`/`then` requirement under
`scoreCalibration`: when `strategy` is explicitly `fixed`, `curve` is
required. Curve-without-strategy remains supported and continues to imply
fixed calibration.

**After-fix evidence:** OpenClaw's real
`openclaw/plugin-sdk/config-schema` validator returned `ok: false` with:

```text
providerConfig.brave.scoreCalibration.curve: must have required property 'curve'
```

The same validator accepted fixed calibration with a valid two-point curve.

**Regression test added:**

- `manifest requires a curve when fixed calibration is selected` compiles and
  evaluates the checked-in manifest through OpenClaw's actual JSON Schema
  validator, rejecting the invalid config and accepting the valid one.

## Verification

- Focused calibration/manifest/normalizer/fusion suite: 68 passed, 0 failed.
- `npm run build`: passed.
- `npm test`: 139 passed, 0 failed, 0 skipped.
- `npx tsc --noEmit`: passed.
- `pnpm run plugin:check`: PASS, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`: PASS, 0 breakages, 0 issues.
- `git diff --check`: passed.
- `codex review --uncommitted`: attempted but blocked by the read-only
  app-server state filesystem; no clean review result is claimed.
