import test from "node:test";
import assert from "node:assert/strict";
import { createAuditRecord } from "../audit/record.js";
import type { FusionSearchPayload } from "../src/types.js";

function failedRunCaveat(error: string): string | undefined {
  const payload = {
    query: "q",
    provider: "search-fusion",
    tookMs: 1,
    count: 0,
    configuredProviders: ["brave"],
    providersQueried: ["brave"],
    providersSucceeded: [],
    providersFailed: [{ provider: "brave", error }],
    providerDetails: [],
    providerRuns: [
      {
        provider: "brave",
        ok: false,
        tookMs: 1,
        rawCount: 0,
        discardedCount: 0,
        attempts: 1,
        configured: true,
        error,
        results: [],
        discardedResults: [],
        retryHistory: [],
      },
    ],
    discardedResults: [],
    answers: [],
    results: [],
    ranking: { strategy: "merged-score-v1", sortOrder: [], consideredCount: 0, returnedCount: 0, droppedCount: 0, dropped: [] },
    evidenceTable: { version: 1, columns: [], rowCount: 0, rows: [] },
    output: { includeRawPayloads: false, includeDiscarded: false, maxSnippetLength: 500, maxAnswerLength: 2000 },
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
  } satisfies FusionSearchPayload;
  return createAuditRecord({ payload, request: { query: "q" } }).providerSummaries[0]?.caveats.find(
    (caveat) => caveat.severity === "error",
  )?.code;
}

test("auth caveats require a standalone 401 or 403 status code", () => {
  for (const error of [
    "HTTP 503 (request 4031)",
    "Provider brave timed out after 14010ms",
    "upstream returned 500 after 403 ms",
    "502 bad gateway, trace id 94013",
    "status 1.401",
  ]) {
    assert.equal(failedRunCaveat(error), "provider-run-failed", error);
  }
});

test("standalone auth status codes and auth wording are still classified as auth errors", () => {
  for (const error of [
    "Exa API error (401): invalid key",
    "HTTP 403",
    "status=401.",
    "Unauthorized",
    "Forbidden",
    "Invalid API key",
    "missing credential",
    "missing_exa_api_key: web_search (exa) needs an Exa API key.",
  ]) {
    assert.equal(failedRunCaveat(error), "provider-auth-error", error);
  }
});
