# Search Fusion Retry-After and Cooldown Summary

## What was built

- Added structured HTTP failure inspection for provider errors and returned error payloads. Status and headers are recognized on direct errors and nested `response` / `cause` shapes.
- Added rate-limit wait parsing for:
  - standard `Retry-After` delta-seconds and HTTP-date values;
  - `retry-after-ms`, `x-retry-after-ms`, and Azure-style `x-ms-retry-after-ms`;
  - `x-ratelimit-reset`, `x-rate-limit-reset`, `ratelimit-reset`, and reset-after variants;
  - millisecond reset variants;
  - OpenAI-style request/token reset duration values such as `250ms`, `1.5s`, or composite durations.
- Added safe wait normalization:
  - negative and past values become zero;
  - malformed values fall back to the existing retry policy;
  - waits longer than one hour clamp to one hour;
  - when multiple recognized headers are present, the longest valid wait wins.
- Integrated provider-request cooldowns into each fusion call. A provider retry cannot issue another delegated search while that provider remains in cooldown.
- Integrated cooldown waits with `totalTimeoutMs`. A wait that cannot fit in the remaining budget fails that provider immediately with the required wait, header source, and remaining-budget context.
- Preserved the existing 2-second conservative fallback for textual or headerless 429 failures.
- Preserved provider isolation and partial-result behavior.

## Files added or changed

- `src/search-fusion.ts`
  - Retry-After and provider reset-header parsing.
  - Structured HTTP error metadata extraction.
  - Per-call provider cooldown state.
  - Deadline-aware rate-limit retry decisions and clear fail-fast errors.
- `test/search-fusion.test.ts`
  - Added seven integration-style unit tests using mocked 429/503 provider responses.
  - Covers all requested header forms, common error shapes, malformed/bounded values, deadline interaction, returned error payloads, and cooldown gating.
- `dist/src/search-fusion.js`
  - Regenerated production JavaScript from the updated TypeScript source.
- `PF-SUMMARY.md`
  - This handoff report.

## Verification

### Dependency installation and pre-change baseline

- `npm install`
  - Initial attempt did not install: npm tried to use the read-only host cache under `/home/vac/.npm` and returned `EROFS`.
- `npm_config_cache=.npm-cache npm install`
  - Passed.
  - Added 554 packages and audited 555 packages.
  - npm reported 12 dependency vulnerabilities: 8 moderate, 3 high, and 1 critical.
  - The generated cache and untracked `package-lock.json` were removed after verification; the repository uses `pnpm-lock.yaml`.
- `npm test` before source edits
  - Passed: 131 tests, 0 failures.

### Focused implementation checks

- `node --test --experimental-test-module-mocks --import tsx test/search-fusion.test.ts`
  - Passed after the final retry-loop implementation: 53 tests, 0 failures.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics.

### Final repository checks

- `npm test`
  - Passed: 138 tests, 0 failures, 0 skipped, 0 cancelled.
- `npx tsc --noEmit`
  - Passed with exit code 0 and no diagnostics.
- `pnpm run plugin:check`
  - `Status: PASS`
  - Fixtures: 1; breakages: 0; issues: 0.
- `pnpm run plugin:check:runtime`
  - `Status: PASS`
  - Fixtures: 1; breakages: 0; issues: 0.
- `npm run build`
  - Passed and regenerated `dist/src/search-fusion.js`.
- `git diff --check`
  - Passed with exit code 0 and no whitespace errors.

## Known gaps and risks

- No live provider was intentionally driven into a real 429/503 response. Coverage uses deterministic mocked provider responses and errors so the suite does not consume quotas or depend on external services.
- The test runner emits existing Node warnings that module mocking is experimental and that the test suite uses the deprecated `namedExports` mock option.
- `npm install` reported vulnerabilities in the existing dependency graph. This feature does not change dependency versions or package metadata.
- Cooldown state is intentionally scoped to one `runSearchFusion` call. It does not persist across separate user calls or processes.

## Suggested follow-ups

- Add a non-destructive provider-adapter contract fixture if OpenClaw standardizes a single status/header error shape; the current implementation intentionally supports several common shapes.
- Address the separately reported dependency vulnerabilities through the normal dependency-upgrade process, with the full plugin-inspector and runtime checks.
