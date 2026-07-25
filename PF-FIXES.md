# PF Fixes: fuzzy URL dedupe review

## Finding 1: override mode returned the wrong display/navigation URL

- Reproduced: yes.
- Probe: an inline one-provider fixture run with
  `node --experimental-test-module-mocks --import tsx --input-type=module`,
  `trackingParams: []`, and `trackingParamMode: "override"`.
- Before-fix evidence:

  ```json
  {
    "url": "https://example.com/story",
    "canonicalUrl": "https://example.com/story?ref=one",
    "originalUrl": "https://example.com/story?ref=one"
  }
  ```

- Root cause: `normalizeProviderPayload` called the legacy `analyzeUrl` policy before Search Fusion's fuzzy-dedupe configuration reached the result. That permanently removed `ref` from `NormalizedSearchResult.url`, even though override mode correctly treated it as meaningful for `canonicalUrl`.
- Fix: the resolved tracking policy now flows from `runSearchFusion` through `runProvider` and `normalizeProviderPayload` into real result normalization. Presentation normalization keeps established default/extend behavior, but override mode narrows the legacy stripping set so a parameter omitted from the replacement tracking list cannot be lost.
- Regression tests:
  - `normalizeProviderPayload preserves configured meaningful parameters in results and citations`
  - `runSearchFusion preserves override-mode display and navigation URLs`
  - The existing extend/override integration test now also asserts the returned display URLs, protecting the established rule that fuzzy-only tracking patterns affect identity without rewriting navigation URLs.
- After-fix evidence:

  ```json
  {
    "url": "https://example.com/story?ref=one",
    "canonicalUrl": "https://example.com/story?ref=one",
    "originalUrl": "https://example.com/story?ref=one"
  }
  ```

## Finding 2: override-mode citations supported the wrong evidence row

- Reproduced: yes.
- Probe: an inline three-provider fixture with distinct `/story` and `/story?ref=one` result rows plus a `gamma` answer citation to `/story?ref=one`, using the same empty override policy.
- Before-fix evidence:

  ```json
  {
    "answerCitations": [
      [
        "https://example.com/story"
      ]
    ],
    "evidence": [
      {
        "canonicalUrl": "https://example.com/story?ref=one",
        "support": 0,
        "citationProviders": []
      },
      {
        "canonicalUrl": "https://example.com/story",
        "support": 1,
        "citationProviders": [
          "gamma"
        ]
      }
    ]
  }
  ```

- Root cause: `buildCitationDetails` also called the fixed legacy normalizer before `buildEvidenceTable` applied configured fuzzy analysis. By then, the citation's meaningful `ref` value was irrecoverable.
- Fix: the same active tracking policy now reaches `extractProviderAnswer` and `buildCitationDetails`. Answer citations therefore remain lossless with respect to configured meaningful parameters before evidence aliases are resolved.
- Regression tests:
  - The direct normalizer regression covers answer citation strings through the real normalization path.
  - `runSearchFusion attributes override-mode citations to the matching evidence row` uses distinct rows and asserts both correct support and the absence of support on the wrong row.
  - The closeout manual review also ran an object-citation override probe successfully.
- After-fix evidence:

  ```json
  {
    "answerCitations": [
      [
        "https://example.com/story?ref=one"
      ]
    ],
    "evidence": [
      {
        "canonicalUrl": "https://example.com/story?ref=one",
        "support": 1,
        "citationProviders": [
          "gamma"
        ]
      },
      {
        "canonicalUrl": "https://example.com/story",
        "support": 0,
        "citationProviders": []
      }
    ]
  }
  ```

## Verification

- Initial focused run after the first implementation attempt: 66/68 passed. Two existing display-URL expectations failed because that attempt applied all fuzzy-only tracking patterns to navigation URLs. The implementation was narrowed at the root policy boundary; no test expectation was weakened.
- Final focused command:
  `node --test --experimental-test-module-mocks --import tsx test/result-normalizer.test.ts test/search-fusion.test.ts`
  - Exit 0; 68 passed, 0 failed.
- `npm install --cache .npm-cache`
  - Exit 0; dependencies up to date, 555 audited.
  - Reported 12 existing dependency vulnerabilities: 8 moderate, 3 high, 1 critical.
- `npm test`
  - Exit 0; 171 passed, 0 failed, 0 skipped.
- `npx tsc --noEmit`
  - Exit 0; no diagnostics.
- `npm run build`
  - Exit 0; regenerated the tracked runtime and declaration files.
- `pnpm run plugin:check`
  - Exit 0; `Status: PASS`, 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`
  - Exit 0; `Status: PASS`, 1 fixture, 0 breakages, 0 issues.
- `git diff --check` and `git diff --check main`
  - Exit 0; no whitespace errors.

`codex review --uncommitted` was attempted twice. Both attempts exited 1 before analysis with the same account usage-limit error and a retry date of August 1, 2026. A read-only manual closeout found no actionable findings and successfully reran the focused tests, object-citation probe, type check, and whitespace check. The automated review is therefore documented as blocked, not clean.

The reviewer's historical install-failure and no-live-provider-call notes are not code findings and cannot be proven retrospectively from the final tree. The fix-agent reruns used deterministic provider fixtures and plugin-inspector mocks; no live provider proof was attempted.
