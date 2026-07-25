REJECT

1. **HIGH — `src/search-fusion.ts:676` — malformed and numerically absurd `Retry-After` values can bypass the promised bounds and retry too early.** `parseNumericHeader` converts the value with `Number()` and returns `undefined` on overflow; `parseRetryAfter` then sends the same syntactically numeric value to `Date.parse`. Positive and negative 400-digit delta values therefore fall through to the ordinary 2-second 429 fallback instead of clamping to one hour and zero respectively. Separately, the non-HTTP-date string `1/2` is accepted by JavaScript as a date in 2001 and becomes a zero-delay retry instead of the documented malformed-header fallback. This contradicts both the task's explicit negative/absurd handling and PF-SUMMARY's claims that negative waits become zero, waits over one hour clamp to one hour, and malformed values use the existing retry policy. The added tests at `test/search-fusion.test.ts:2157` and `test/search-fusion.test.ts:2193` cover only finite values and one string that `Date.parse` rejects, so they miss these paths.

   Evidence from public `runSearchFusion` probes run with `node --import tsx --input-type=module`:

   ```text
   {"name":"malformed-slash-date","calls":2,"elapsedMs":1,"succeeded":["brave"],"failed":[],"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":0}]}
   {"name":"malformed-control","calls":2,"elapsedMs":2001,"succeeded":["brave"],"failed":[],"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}]}
   {"name":"overflow-positive","calls":2,"elapsedMs":2001,"tookMs":2455,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}],"failed":[]}
   {"name":"overflow-negative","calls":2,"elapsedMs":2002,"tookMs":2003,"retryHistory":[{"attempt":1,"error":"HTTP 429","delayMs":2000}],"failed":[]}
   ```

   With `totalTimeoutMs: 5000`, the positive overflow case should have clamped to `3600000ms` and failed fast as over-budget; it instead called the provider again after two seconds.

2. **MEDIUM — `src/search-fusion.ts:1383` — authoritative 503 responses with a valid retry header can still be rejected by old message heuristics before the new structured status is used.** `canRetry` calls `shouldRetry` first, and that function rejects any message containing `not found`. Only afterward does `resolveRetryTiming` inspect the structured `status: 503` and `Retry-After` metadata. Consequently, a real 503 response whose provider/proxy body says `upstream route not found` never enters cooldown and never retries, despite the task requiring rate-limit-header handling on 503 responses.

   Evidence from a public-path probe using a structured `{ response: { status: 503, headers: { "retry-after-ms": "25" } } }` error:

   ```text
   {"name":"503-message-heuristic","calls":1,"elapsedMs":null,"succeeded":[],"failed":[{"provider":"brave","error":"upstream route not found"}],"retryHistory":[]}
   ```

   The structured status/header should take precedence over the generic body-text heuristic here; the expected behavior is a second call after about 25 ms.

Verified checks:

- `node --test --experimental-test-module-mocks --import tsx test/search-fusion.test.ts`: 53 passed, 0 failed.
- `npm test`: 138 passed, 0 failed, 0 skipped/cancelled.
- `npx tsc --noEmit`: exit 0, no diagnostics.
- `pnpm run plugin:check`: PASS; 1 fixture, 0 breakages, 0 issues.
- `pnpm run plugin:check:runtime`: PASS; 1 fixture, 0 breakages, 0 issues.
- `git diff --check main...HEAD`: exit 0.
- `npx tsc -p tsconfig.build.json --noEmit`: exit 0. An in-memory TypeScript transpilation also matched `dist/src/search-fusion.js` byte-for-byte.
- Additional public-path probes passed for the untested header aliases, duration values, returned error payloads, and choosing the longest of multiple recognized waits.
- No added placeholder/TODO code, secret literal, `eval`, dynamic `Function`, or subprocess call was found in the patch.

Summary claims I could NOT verify:

- The initial `npm install` EROFS failure, the cache-overridden install, its package count/vulnerability count, and the pre-change 131-test baseline are historical claims. Re-running installation or reconstructing `main` would create files other than `PF-REVIEW.md`, which this review explicitly forbids. The current `.npm-cache` and `package-lock.json` are absent, and `npm ls --depth=0` reports no dependency problems.
- I did not run the exact emitting `npm run build`, because it rewrites `dist/` and only `PF-REVIEW.md` may be modified. The no-emit build check and byte-for-byte in-memory transpilation above verify the current source/artifact consistency without modifying it.
- The claim that no live provider was driven into a real 429/503 cannot be independently proven from the committed files. This review likewise made no live provider calls.

Review-tool limitation: `codex review --base main` was attempted but could not initialize its in-process app-server because the environment is read-only (`Read-only file system (os error 30)`); no finding above depends on that unavailable secondary review.
