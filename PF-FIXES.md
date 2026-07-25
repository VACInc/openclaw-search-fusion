# Adversarial Review Fixes

## Finding 1: malformed and overflowing Retry-After values

### Reproduced?

Yes. Before editing, equivalent probes were run through the public
`runSearchFusion` export:

```text
{"name":"malformed-slash-date","calls":2,"elapsedMs":1,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":0}]}
{"name":"overflow-positive","calls":2,"elapsedMs":2001,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}],"succeeded":["brave"]}
{"name":"overflow-negative","calls":2,"elapsedMs":2002,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}],"succeeded":["brave"]}
```

This confirmed all three reported paths:

- `1/2` was accepted by JavaScript as a date and became a zero-delay retry.
- A 400-digit positive delta overflowed to infinity, was discarded as non-finite, and
  fell back to the generic 2,000 ms 429 policy.
- A 400-digit negative delta followed the same fallback instead of clamping to zero.

### Root cause and fix

`parseNumericHeader` conflated invalid numeric syntax with valid numeric syntax whose
magnitude exceeded JavaScript's finite number range. `parseRetryAfter` then passed those
valid numeric strings to permissive `Date.parse`.

The fix keeps syntactically numeric infinities so the shared delay clamp can saturate them:
positive infinity becomes 3,600,000 ms and negative infinity becomes 0 ms. The delay clamp
now rejects only `NaN`.

Retry-After date parsing now recognizes and validates the three HTTP-date grammars
(IMF-fixdate, RFC 850, and asctime), including calendar fields and weekday consistency.
Non-HTTP strings and impossible dates remain malformed and use the existing retry policy.
The same strict date boundary is used by reset headers that accept HTTP dates.

### Regression tests

- Added `runSearchFusion distinguishes malformed Retry-After dates from overflowing
  numeric deltas`.
  - Asserts `1/2` uses the 2,000 ms 429 fallback.
  - Asserts a negative 400-digit delta produces a 0 ms retry delay.
- Extended `runSearchFusion clamps absurd rate-limit waits to one hour`.
  - Asserts both an ordinary oversized delta and a 400-digit positive delta clamp to
    3,600,000 ms and fail before issuing a second provider call.

### After-fix evidence

```text
{"name":"malformed-slash-date","calls":2,"elapsedMs":2002,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}]}
{"name":"overflow-positive","calls":1,"elapsedMs":null,"failed":[{"provider":"brave","error":"Rate-limit wait of 3600000ms from retry-after exceeds the remaining total timeout budget of 4786ms."}],"retryHistory":[]}
{"name":"overflow-negative","calls":2,"elapsedMs":1,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":0}],"succeeded":["brave"]}
```

## Finding 2: structured 503 metadata loses to message heuristics

### Reproduced?

Yes. Before editing, a structured response with status 503,
`retry-after-ms: 25`, and message `upstream route not found` produced:

```text
{"name":"503-message-heuristic","calls":1,"elapsedMs":null,"succeeded":[],"failed":[{"provider":"brave","error":"upstream route not found"}],"retryHistory":[]}
```

### Root cause and fix

The provider loop called the generic message-based `shouldRetry` predicate before
resolving structured response status and rate-limit headers. The generic `not found`
rule therefore vetoed a valid 503 retry instruction.

The loop now resolves retry timing first. A structured 429, or a structured 503 carrying
a rate-limit header, is considered authoritative retry evidence and can bypass generic
body-message heuristics. Abort, deadline, and maximum-attempt guards remain mandatory and
unchanged.

### Regression test

- Added `runSearchFusion prioritizes structured 503 retry metadata over message
  heuristics`.
  - Uses the exported fusion function and a mocked structured 503 error.
  - Asserts two provider calls, a 25 ms retry-history delay, and successful recovery.
  - Asserts a malformed 503 delay does not override the existing non-retriable
    `not found` message rule.

### After-fix evidence

```text
{"name":"503-message-heuristic","calls":2,"elapsedMs":27,"succeeded":["brave"],"failed":[],"retryHistory":[{"attempt":1,"error":"upstream route not found","delayMs":25}]}
```

## Stand-in assessment

The reviewer did not identify a stand-in implementation. The production code was already
present in `src/search-fusion.ts`; all new regressions and both reproduction probes call
the real exported `runSearchFusion` function. `dist/src/search-fusion.js` was regenerated
from that source.

## Verification

- Focused test file: 55 passed, 0 failed.
- Full `npm test`: 140 passed, 0 failed, 0 skipped/cancelled.
- `npx tsc --noEmit`: exit 0, no diagnostics.
- `npm run build`: exit 0.
- `pnpm run plugin:check`: PASS, 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`: PASS, 1 fixture, 0 breakages, 0 issues.
- `git diff --check`: exit 0.
