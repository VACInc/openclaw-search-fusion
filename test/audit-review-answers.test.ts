import test from "node:test";
import assert from "node:assert/strict";
import { createAuditRecord } from "../audit/record.js";
import { renderAuditReview } from "../audit/review.js";
import { extractProviderAnswer } from "../src/result-normalizer.js";
import type { FusionSearchPayload } from "../src/types.js";

function reviewWithAnswer(content: string): string {
  const answer = extractProviderAnswer({ content }, "gemini");
  assert.ok(answer);
  const payload = {
    query: "q",
    provider: "search-fusion",
    tookMs: 1,
    count: 0,
    configuredProviders: ["gemini"],
    providersQueried: ["gemini"],
    providersSucceeded: ["gemini"],
    providersFailed: [],
    providerDetails: [],
    providerRuns: [],
    discardedResults: [],
    answers: [answer],
    results: [],
    ranking: { strategy: "merged-score-v1", sortOrder: [], consideredCount: 0, returnedCount: 0, droppedCount: 0, dropped: [] },
    evidenceTable: { version: 1, columns: [], rowCount: 0, rows: [] },
    output: { includeRawPayloads: false, includeDiscarded: false, maxSnippetLength: 500 },
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
  } satisfies FusionSearchPayload;
  return renderAuditReview(createAuditRecord({ payload, request: { query: "q" } }));
}

test("truncated answer summaries end with exactly one ellipsis in the review", () => {
  const review = reviewWithAnswer("word ".repeat(200));
  const summaryLine = review.split("\n").find((line) => line.startsWith("  word"));
  assert.ok(summaryLine);
  assert.match(summaryLine, /word…$/);
  assert.doesNotMatch(summaryLine, /……/);
});

test("short answer summaries are rendered without an ellipsis", () => {
  const review = reviewWithAnswer("A complete short answer.");
  assert.match(review, /\n {2}A complete short answer\.\n/);
  assert.doesNotMatch(review, /…/);
});

test("hand-built records flagged as truncated without an ellipsis still get one", () => {
  const payload = {
    query: "q",
    provider: "search-fusion",
    tookMs: 1,
    count: 0,
    configuredProviders: [],
    providersQueried: ["kimi"],
    providersSucceeded: ["kimi"],
    providersFailed: [],
    providerDetails: [],
    providerRuns: [],
    discardedResults: [],
    answers: [
      { providerId: "kimi", summary: "Cut short", fullContent: "Cut short and more", summaryTruncated: true, citations: [], citationDetails: [] },
    ],
    results: [],
    ranking: { strategy: "merged-score-v1", sortOrder: [], consideredCount: 0, returnedCount: 0, droppedCount: 0, dropped: [] },
    evidenceTable: { version: 1, columns: [], rowCount: 0, rows: [] },
    output: { includeRawPayloads: false, includeDiscarded: false, maxSnippetLength: 500 },
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
  } satisfies FusionSearchPayload;
  assert.match(renderAuditReview(createAuditRecord({ payload, request: { query: "q" } })), /\n {2}Cut short…\n/);
});
