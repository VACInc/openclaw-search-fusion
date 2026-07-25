# Search Fusion Retry-After and Cooldown Summary

## Outcome

The Retry-After and per-provider cooldown feature is implemented, both adversarial-review
findings were reproduced through the exported `runSearchFusion` path, and both were fixed
at their ownership boundaries with regression coverage.

- Syntactically numeric values remain numeric even when JavaScript represents them as
  infinity, allowing positive overflow to clamp to one hour and negative overflow to
  clamp to zero.
- Retry-After dates are accepted only when they are valid HTTP-date values; strings such
  as `1/2` no longer inherit JavaScript's permissive date parsing.
- Structured 429 status and valid structured 503 rate-limit metadata now take precedence
  over generic message heuristics when deciding whether to retry.
- The production JavaScript artifact was rebuilt from the corrected TypeScript source.

See `PF-FIXES.md` for per-finding reproduction and after-fix probe evidence.

## Complete feature behavior

- Inspects provider errors and returned error payloads for structured status and headers,
  including direct, `response`, and `cause` shapes.
- Parses standard `Retry-After` delta-seconds and HTTP-date values.
- Parses `retry-after-ms`, `x-retry-after-ms`, `x-ms-retry-after-ms`, reset timestamp,
  reset-after, millisecond reset, and OpenAI-style request/token duration headers.
- Clamps negative and past waits to zero and waits over one hour to 3,600,000 ms.
- Uses the existing retry policy for malformed values, including the conservative
  two-second fallback for 429 responses.
- Chooses the longest valid delay when multiple recognized headers are present.
- Maintains per-provider cooldown state within one fusion call and prevents a retry
  sub-query while that provider is cooling.
- Fails a provider immediately with required-wait, header-source, and remaining-budget
  context when its cooldown cannot fit inside `totalTimeoutMs`.
- Preserves provider isolation and partial-result behavior.

## Files changed

- `src/search-fusion.ts`
  - Corrected numeric saturation and strict HTTP-date parsing.
  - Made authoritative rate-limit metadata part of the retryability decision.
  - Contains the original Retry-After parsing, cooldown, and deadline integration.
- `test/search-fusion.test.ts`
  - Added public-path regressions for non-HTTP date strings, positive and negative
    400-digit numeric values, and structured 503 metadata paired with a normally
    non-retriable message.
  - Asserts malformed 503 metadata still falls back to the existing message heuristic.
  - Retains the original feature coverage for all header groups, error shapes, deadlines,
    returned payloads, and cooldown gating.
- `dist/src/search-fusion.js`
  - Regenerated with `npm run build`.
- `PF-SUMMARY.md`
  - Updated final implementation and verification report.
- `PF-FIXES.md`
  - Added finding-by-finding reproduction, fix, and proof.

## Reproduction and focused verification

- Pre-fix public-path probe:
  - `Retry-After: 1/2`: retried after 0 ms instead of the 2,000 ms malformed-value
    fallback.
  - 400-digit positive delta: retried after 2,000 ms instead of clamping to 3,600,000 ms
    and failing over budget.
  - 400-digit negative delta: retried after 2,000 ms instead of clamping to 0 ms.
  - Structured 503 plus `retry-after-ms: 25` and message `upstream route not found`:
    one call and no retry.
- Post-fix equivalent public-path probe:
  - `1/2`: two calls, 2,002 ms between attempts, retry history delay 2,000 ms.
  - Positive overflow: one call, no retry, clear 3,600,000 ms over-budget failure.
  - Negative overflow: two calls, 1 ms between attempts, retry history delay 0 ms.
  - Structured 503: two calls, 27 ms between attempts, retry history delay 25 ms.
- `node --test --experimental-test-module-mocks --import tsx test/search-fusion.test.ts`
  - Passed: 55 tests, 0 failed.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics after the focused changes.

## Final verification

- `npm_config_cache=node_modules/.cache/npm npm install --package-lock=false`
  - Passed: dependencies were already up to date; audited 555 packages.
  - npm reported 12 existing dependency findings: 8 moderate, 3 high, 1 critical.
- `npm run build`
  - Passed and regenerated `dist/src/search-fusion.js`.
- `npm test`
  - Passed after installation: 140 tests, 0 failed, 0 skipped, 0 cancelled.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics.
- `pnpm run plugin:check`
  - `Status: PASS`; fixtures 1, breakages 0, issues 0.
- `pnpm run plugin:check:runtime`
  - `Status: PASS`; fixtures 1, breakages 0, issues 0.
- `git diff --check`
  - Passed with exit code 0 and no whitespace errors.

## Known gaps and risks

- No live provider was intentionally driven into a real 429/503 response. Deterministic
  mocks exercise the real exported fusion function without consuming quota.
- The test runner emits existing Node warnings for experimental module mocking and the
  deprecated `namedExports` mock option.
- npm reports 12 findings in the existing dependency graph. No dependency versions or
  package metadata changed in this work.
- The `codex review --uncommitted` closeout could not initialize because the worktree-local
  `.codex` state directory is read-only. Its exact failure was
  `failed to initialize in-process app-server client: Read-only file system (os error 30)`.
  The original adversarial findings were instead validated with direct probes, focused
  tests, the full suite, TypeScript, both inspector gates, and manual diff inspection.
