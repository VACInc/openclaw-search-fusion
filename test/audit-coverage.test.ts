import test from "node:test";
import assert from "node:assert/strict";
import { createAuditRecord, parseAuditRecord } from "../audit/record.js";
import { compareAuditRecords, renderAuditReview } from "../audit/review.js";
import type { FusionMergedResult, FusionSearchPayload } from "../src/types.js";

type Run = FusionSearchPayload["providerRuns"][number];

function run(provider: string, overrides: Partial<Run> = {}): Run {
  return {
    provider,
    ok: true,
    tookMs: 10,
    rawCount: 1,
    discardedCount: 0,
    attempts: 1,
    configured: true,
    results: [],
    discardedResults: [],
    retryHistory: [],
    ...overrides,
  };
}

function merged(url: string, overrides: Partial<FusionMergedResult> = {}): FusionMergedResult {
  return {
    title: url,
    url,
    canonicalUrl: url,
    providers: ["brave"],
    providerCount: 1,
    score: 1.23456,
    bestRank: 1,
    bestSourceTier: "high",
    flags: [],
    rankings: [],
    variants: [],
    ranking: {
      strategy: "merged-score-v1",
      rank: 1,
      scoreBreakdown: {
        bestVariantScore: 1,
        corroborationBonus: 0,
        bestRankBonus: 0,
        tierAdjustment: 0,
        flagPenalty: 0,
        finalScore: 1,
      },
      tieBreakers: { bestSourceTier: "high", bestRank: 1, providerCount: 1, title: url },
    },
    ...overrides,
  };
}

function payload(overrides: Partial<FusionSearchPayload> = {}): FusionSearchPayload {
  return {
    query: "audit coverage",
    provider: "search-fusion",
    tookMs: 42,
    count: 0,
    configuredProviders: [],
    providersQueried: [],
    providersSucceeded: [],
    providersFailed: [],
    providerDetails: [],
    providerRuns: [],
    discardedResults: [],
    answers: [],
    results: [],
    ranking: { strategy: "merged-score-v1", sortOrder: [], consideredCount: 0, returnedCount: 0, droppedCount: 0, dropped: [] },
    evidenceTable: { version: 1, columns: [], rowCount: 0, rows: [] },
    output: { includeRawPayloads: false, includeDiscarded: false, maxSnippetLength: 500 },
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
    ...overrides,
  };
}

const codes = (caveats: Array<{ code: string }>) => caveats.map((caveat) => caveat.code);

test("no queried providers yields a single blocking caveat", () => {
  const record = createAuditRecord({ payload: payload(), request: { query: "q" } });
  assert.deepEqual(codes(record.caveats), ["no-providers-queried"]);
  assert.equal(record.caveats[0]?.severity, "error");
  assert.deepEqual(record.pluginConfig, {});
});

test("partial failures, empty providers, and unconfigured providers are each flagged", () => {
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["brave", "tavily", "exa"],
      providersSucceeded: ["brave", "exa"],
      providersFailed: [{ provider: "tavily", error: "HTTP 500" }],
      providerRuns: [
        run("brave", { rawCount: 0 }),
        run("tavily", { ok: false, rawCount: 0, error: "HTTP 500" }),
        run("exa", { configured: false, rawCount: 0 }),
      ],
    }),
    request: { query: "q" },
  });
  assert.deepEqual(codes(record.caveats), ["some-providers-failed", "no-results"]);
  assert.equal(record.caveats[0]?.message, "1 of 3 provider(s) failed: tavily.");
  const [brave, tavily, exa] = record.providerSummaries;
  assert.deepEqual(codes(brave?.caveats ?? []), ["provider-empty-results"]);
  assert.deepEqual(codes(tavily?.caveats ?? []), ["provider-run-failed"]);
  assert.deepEqual(codes(exa?.caveats ?? []), ["provider-not-configured", "provider-empty-results"]);
  // No results means no flagged fraction, not a division by zero.
  assert.equal(brave?.flaggedResultFraction, 0);
});

test("a failed provider without an error message gets no run-failed caveat", () => {
  const record = createAuditRecord({
    payload: payload({ providersQueried: ["brave"], providerRuns: [run("brave", { ok: false })] }),
    request: { query: "q" },
  });
  assert.deepEqual(record.providerSummaries[0]?.caveats, []);
});

test("retry caveats use singular and plural wording", () => {
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["a", "b"],
      providersSucceeded: ["a", "b"],
      providerRuns: [run("a", { attempts: 2 }), run("b", { attempts: 3 })],
      results: [merged("https://example.com/x")],
    }),
    request: { query: "q" },
  });
  assert.match(record.providerSummaries[0]?.caveats[0]?.message ?? "", /after 2 attempts \(1 retry\)/);
  assert.match(record.providerSummaries[1]?.caveats[0]?.message ?? "", /after 3 attempts \(2 retries\)/);
});

test("uncorroborated multi-provider results get an informational caveat", () => {
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["brave", "tavily"],
      providersSucceeded: ["brave", "tavily"],
      providerRuns: [run("brave"), run("tavily")],
      results: [merged("https://example.com/a"), merged("https://example.com/b", { providers: ["tavily"] })],
    }),
    request: { query: "q" },
  });
  assert.deepEqual(codes(record.caveats), ["no-cross-provider-corroboration"]);
  assert.equal(record.caveats[0]?.severity, "info");
});

test("a low sponsored ratio stays below the warning threshold", () => {
  const results = [
    merged("https://example.com/ad", { flags: ["sponsored"], providerCount: 2 }),
    ...["b", "c", "d"].map((id) => merged(`https://example.com/${id}`, { providerCount: 2 })),
  ];
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["brave"],
      providersSucceeded: ["brave"],
      providerRuns: [run("brave")],
      results,
    }),
    request: { query: "q" },
  });
  assert.deepEqual(codes(record.caveats), []);
});

test("parseAuditRecord rejects non-object JSON", () => {
  assert.throws(() => parseAuditRecord("null"), /expected schemaVersion 1\. Got: undefined/);
  assert.throws(() => parseAuditRecord("42"), /Invalid audit record/);
  assert.throws(() => parseAuditRecord("{not json"), SyntaxError);
});

test("renderAuditReview renders request context, failures, answers, and empty merges", () => {
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["brave", "gemini"],
      providersSucceeded: ["gemini"],
      providersFailed: [{ provider: "brave", error: "HTTP 500" }],
      providerRuns: [run("brave", { ok: false, error: "HTTP 500", rawCount: 0 }), run("gemini", { rawCount: 0 })],
      answers: [
        {
          providerId: "gemini",
          summary: "Short answer.",
          fullContent: "Short answer.",
          summaryTruncated: false,
          citations: ["https://example.com/cite"],
          citationDetails: [{ url: "https://example.com/cite" }],
        },
        {
          providerId: "kimi",
          summary: "Uncited answer.",
          fullContent: "Uncited answer.",
          summaryTruncated: false,
          citations: [],
          citationDetails: [],
        },
      ],
    }),
    request: { query: "review me", mode: "deep", providers: ["brave", "gemini"] },
    capturedAt: "2026-01-01T00:00:00.000Z",
  });
  const text = renderAuditReview(record);
  assert.match(text, /^# Search Fusion Audit Review\nCaptured: 2026-01-01T00:00:00\.000Z\nQuery: review me\nMode: deep\nProviders: brave, gemini\n/);
  assert.match(text, /- Providers failed: brave \(HTTP 500\)/);
  assert.match(text, /- Answer digests: gemini, kimi/);
  assert.match(text, /### brave — failed \(10ms\)/);
  assert.match(text, /  \(no results\)/);
  assert.match(text, /## Provider answer digests\n### gemini\n  Short answer\.\n  Citations \(1\):\n    - https:\/\/example\.com\/cite\n### kimi\n  Uncited answer\.\n/);
});

test("renderAuditReview shows retries, observed flags, and merged-result details", () => {
  const record = createAuditRecord({
    payload: payload({
      providersQueried: ["brave"],
      providersSucceeded: ["brave"],
      providerRuns: [
        run("brave", {
          attempts: 2,
          rawCount: 2,
          results: [
            { title: "v", url: "https://youtube.com/v", originalUrl: "https://youtube.com/v", canonicalUrl: "https://youtube.com/v", providerId: "brave", score: 1, rawRank: 1, sourceType: "results", sourceTier: "low", flags: ["video"] },
            { title: "c", url: "https://example.com/c", originalUrl: "https://example.com/c", canonicalUrl: "https://example.com/c", providerId: "brave", score: 1, rawRank: 2, sourceType: "results", sourceTier: "high", flags: [] },
          ],
        }),
      ],
      results: [merged("https://youtube.com/v", { flags: ["video"], snippet: "A video.", providerCount: 2 })],
    }),
    request: { query: "q" },
    label: "flags",
  });
  const text = renderAuditReview(record);
  assert.match(text, /^# Search Fusion Audit Review "flags"/);
  assert.match(text, /### brave — ok \(2 hits, 10ms, 2 attempts\)/);
  assert.match(text, /  Flags observed: video \(50% of results\)/);
  assert.match(text, /Providers: brave • Best rank: #1 • Score: 1\.235/);
  assert.match(text, /   Flags: video\n   Snippet: A video\./);
  assert.match(text, /- Providers queried: brave/);
  const empty = renderAuditReview(createAuditRecord({ payload: payload(), request: { query: "q" } }));
  assert.match(empty, /- Providers queried: \(none\)\n- Providers succeeded: \(none\)/);
  assert.match(empty, /✖ \[no-providers-queried\]/);
});

test("compareAuditRecords reports providers that started failing", () => {
  const base = { providersQueried: ["brave", "tavily"], providerRuns: [run("brave"), run("tavily")] };
  const original = createAuditRecord({
    payload: payload({ ...base, providersSucceeded: ["brave", "tavily"], results: [merged("https://example.com/a")] }),
    request: { query: "q" },
  });
  const rerun = createAuditRecord({
    payload: payload({ ...base, providersSucceeded: ["brave"], results: [merged("https://example.com/b")] }),
    request: { query: "q" },
  });
  const diff = compareAuditRecords(original, rerun);
  assert.deepEqual(diff.providerChanges, ["tavily: was ok → now failed"]);
  assert.deepEqual(diff.urlsAdded, ["https://example.com/b"]);
  assert.deepEqual(diff.urlsRemoved, ["https://example.com/a"]);
  assert.deepEqual(diff.urlsRetained, []);
  assert.match(diff.summary, /Provider status changes:\n  ~ tavily: was ok → now failed/);
  assert.doesNotMatch(diff.summary, /No changes detected/);
});

test("compareAuditRecords reports providers that recovered", () => {
  const base = { providersQueried: ["brave", "tavily"], providerRuns: [run("brave"), run("tavily")] };
  const original = createAuditRecord({ payload: payload({ ...base, providersSucceeded: ["brave"] }), request: { query: "q" } });
  const rerun = createAuditRecord({ payload: payload({ ...base, providersSucceeded: ["brave", "tavily"] }), request: { query: "q" } });
  const diff = compareAuditRecords(original, rerun);
  assert.deepEqual(diff.providerChanges, ["tavily: was failed → now ok"]);
  assert.match(diff.summary, /Results retained: 0\nResults added: {4}0\nResults removed: {2}0/);
});
