# PF Summary: Provider-native result counts

## What was built

- Added a documented provider result-count contract table in `src/search-fusion.ts`.
  - Exa defaults to 100 and its adapter maps generic `count` to native `numResults`.
  - Tavily defaults to 20 and maps `count` to native `max_results`.
  - Parallel defaults to 40 and maps `count` to `advanced_settings.max_results`.
  - Parallel Free allows up to 40, but the OpenClaw adapter applies that count only as a client-side slice of the free MCP's fixed response.
  - Every other known OpenClaw catalog provider has an explicit 10-result generic-adapter ceiling.
  - Unknown third-party adapters retain the previous default of 5 and the previous generic ceiling of 10.
- Added `providerConfig.<id>.maxResults`.
  - It defaults to the known provider's native/generic adapter maximum.
  - It can lower but cannot raise the verified native maximum.
  - Per-call `count`, legacy `providerConfig.<id>.count`, and shared `countPerProvider` are all clamped to that ceiling.
  - Non-finite and fractional direct inputs are normalized defensively.
- Raised the public request/config schema range to 100 so Exa's supported maximum is expressible; provider-specific clamping still prevents invalid downstream requests.
- Preserved the fusion-level `maxMergedResults` cap while using the deeper internal candidate pool for normalization, dedupe, and ranking.
- Prevented default model-visible provider-run bloat: `providerRuns[].results` contains only evidence for URLs surviving the merged cap. `rawCount` reports the full pull, and `includeRawPayloads: true` intentionally restores complete normalized provider runs and raw responses for audits.
- Updated configuration and tool documentation.
- Added transport-mock coverage for native defaults, native/configured clamping, free/keyless provider behavior, unknown adapters, payload argument names, default overrides, the global cap, and raw-output opt-in behavior.

## Files added or changed

- Added `PF-SUMMARY.md` — this handoff.
- Changed `README.md` — provider count table, configuration examples, clamping semantics, free-tier notes, and bounded-output behavior.
- Changed `index.ts` — public `count` tool schema now accepts 1-100 and documents provider clamping.
- Changed `openclaw.plugin.json` — exposes `providerConfig.<id>.maxResults`; raises count schema ceilings to 100 with updated descriptions.
- Changed `src/search-fusion.ts` — provider contract table, count resolution/clamping, native defaults, conservative unknown-provider handling, and bounded default provider-run evidence.
- Changed `src/types.ts` — adds the typed `maxResults` provider configuration.
- Changed `test/index.test.ts` — verifies the public tool count ceiling.
- Changed `test/manifest.test.ts` — verifies manifest count/maxResults schemas.
- Changed `test/search-fusion.test.ts` — adds provider-count, payload, free-tier, override, global-cap, and output-bounding tests.

`npm install` also populated ignored `node_modules/`. Inspector reports were generated under ignored `reports/`. The npm-generated `package-lock.json` was removed because this repository's canonical lockfile is `pnpm-lock.yaml`.

## Verification and observed results

1. Dependency install:

   ```text
   npm install --cache .npm-cache
   ```

   Observed: exit 0; 554 packages added, 555 audited. npm reported 12 dependency audit findings (8 moderate, 3 high, 1 critical). No automatic dependency mutation was attempted.

   The first plain `npm install` attempt failed before installation because the host npm cache under `/home/vac/.npm` was read-only. Re-running with a worktree-local cache succeeded.

2. Baseline before source edits:

   ```text
   npm test
   ```

   Observed: exit 0; 131 tests, 131 passed, 0 failed.

3. Final full test suite:

   ```text
   npm test
   ```

   Observed: exit 0; 137 tests, 137 passed, 0 failed, 0 skipped, 0 todo.

4. TypeScript:

   ```text
   npx tsc --noEmit
   ```

   Observed: exit 0; no diagnostics.

5. Static plugin inspector:

   ```text
   pnpm run plugin:check
   ```

   Observed: exit 0; `Status: PASS`, 1 fixture, 0 breakages, 0 issues.

6. Runtime plugin inspector:

   ```text
   pnpm run plugin:check:runtime
   ```

   Observed: exit 0; `Status: PASS`, 1 fixture, 0 breakages, 0 issues.

7. Diff hygiene:

   ```text
   git diff --check
   ```

   Observed: exit 0; no whitespace errors.

## Adapter evidence used

- Installed OpenClaw 2026.5.6 adapters confirmed:
  - Tavily generic `count` -> `max_results`, capped at 20.
  - Exa generic `count` -> `numResults`, capped at 100.
  - Firecrawl generic adapter contract capped at 10.
- Catalog-matched OpenClaw/plugin package source at 2026.7.2-beta.4 confirmed:
  - Parallel generic `count` -> paid `advanced_settings.max_results`, capped at 40.
  - Parallel Free uses the same 1-40 generic contract but slices the free MCP response client-side instead of asking the free service for a larger response.
  - Firecrawl paid and free generic providers both cap `count` at 10; the separate Firecrawl-specific tool's larger range is not used by Search Fusion.
- Search Fusion transport tests assert that the broker passes only the generic adapter-facing `count`, not provider-native fields. Native field translation remains owned by the OpenClaw adapters.

## Known gaps and risks

- No live paid-provider API calls were made. The provider-native mappings were verified from the installed/catalog-matched OpenClaw adapter source, and broker behavior was verified with mocked runtime transport as requested.
- Provider limits are dependency contracts and can drift in future OpenClaw/provider-plugin releases. The documented table and tests must be updated when adapters change.
- `includeRawPayloads: true` deliberately opts into larger output by returning complete provider runs and raw responses.
- npm reported 12 audit findings in the installed development dependency tree. They were not changed because dependency remediation was outside this feature and `npm audit fix` could introduce unrelated updates.

## Suggested follow-ups

- Run a credentialed staging smoke test for Exa, Tavily, and paid Parallel before release if those credentials are available.
- Re-audit the count table when updating the OpenClaw/plugin build target.
- Triage the npm audit report in a separate dependency-maintenance change.
