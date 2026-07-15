import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAuditRecord, parseAuditRecord } from "../audit/record.js";
import { renderAuditReview, compareAuditRecords } from "../audit/review.js";
import { AUDIT_SCHEMA_VERSION } from "../audit/types.js";
import type { FusionSearchPayload, ProviderSelectionRequest } from "../src/types.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function minimalPayload(overrides: Partial<FusionSearchPayload> = {}): FusionSearchPayload {
  return {
    query: "openclaw plugin sdk",
    provider: "search-fusion",
    tookMs: 500,
    count: 2,
    configuredProviders: ["brave", "tavily"],
    providersQueried: ["brave", "tavily"],
    providersSucceeded: ["brave", "tavily"],
    providersFailed: [],
    providerDetails: [
      { provider: "brave", ok: true, tookMs: 200, rawCount: 2, discardedCount: 0, attempts: 1, configured: true },
      { provider: "tavily", ok: true, tookMs: 500, rawCount: 1, discardedCount: 0, attempts: 1, configured: true },
    ],
    providerRuns: [
      {
        provider: "brave",
        ok: true,
        tookMs: 200,
        rawCount: 2,
        discardedCount: 0,
        attempts: 1,
        configured: true,
        results: [
          {
            title: "SDK Docs",
            url: "https://docs.openclaw.ai/plugins/sdk",
            originalUrl: "https://docs.openclaw.ai/plugins/sdk",
            canonicalUrl: "https://docs.openclaw.ai/plugins/sdk",
            snippet: "Runtime helpers.",
            siteName: "docs.openclaw.ai",
            providerId: "brave",
            score: 0.9,
            rawRank: 1,
            sourceType: "results",
            sourceTier: "high",
            flags: [],
          },
          {
            title: "Plugin Guide",
            url: "https://docs.openclaw.ai/plugins/guide",
            originalUrl: "https://docs.openclaw.ai/plugins/guide",
            canonicalUrl: "https://docs.openclaw.ai/plugins/guide",
            snippet: "How to write plugins.",
            siteName: "docs.openclaw.ai",
            providerId: "brave",
            score: 0.8,
            rawRank: 2,
            sourceType: "results",
            sourceTier: "high",
            flags: [],
          },
        ],
        discardedResults: [],
        retryHistory: [],
      },
      {
        provider: "tavily",
        ok: true,
        tookMs: 500,
        rawCount: 1,
        discardedCount: 0,
        attempts: 1,
        configured: true,
        results: [
          {
            title: "SDK Docs",
            url: "https://docs.openclaw.ai/plugins/sdk",
            originalUrl: "https://docs.openclaw.ai/plugins/sdk",
            canonicalUrl: "https://docs.openclaw.ai/plugins/sdk",
            snippet: "Plugin SDK runtime helpers.",
            siteName: "docs.openclaw.ai",
            providerId: "tavily",
            score: 0.85,
            rawRank: 1,
            sourceType: "results",
            sourceTier: "high",
            flags: [],
          },
        ],
        discardedResults: [],
        retryHistory: [],
      },
    ],
    discardedResults: [],
    answers: [],
    ranking: {
      strategy: "merged-score-v1",
      sortOrder: ["score:desc", "bestSourceTier:desc", "bestRank:asc", "providerCount:desc", "title:asc"],
      consideredCount: 2,
      returnedCount: 2,
      droppedCount: 0,
      dropped: [],
    },
    evidenceTable: {
      version: 1,
      columns: [],
      rowCount: 0,
      rows: [],
    },
    output: {
      includeRawPayloads: false,
      includeDiscarded: false,
      maxSnippetLength: 500,
    },
    results: [
      {
        title: "SDK Docs",
        url: "https://docs.openclaw.ai/plugins/sdk",
        canonicalUrl: "https://docs.openclaw.ai/plugins/sdk",
        snippet: "Plugin SDK runtime helpers.",
        siteName: "docs.openclaw.ai",
        providers: ["brave", "tavily"],
        providerCount: 2,
        score: 1.09,
        bestRank: 1,
        bestSourceTier: "high",
        flags: [],
        rankings: [
          { providerId: "brave", rawRank: 1, score: 0.9, sourceType: "results", sourceTier: "high", flags: [] },
          { providerId: "tavily", rawRank: 1, score: 0.85, sourceType: "results", sourceTier: "high", flags: [] },
        ],
        variants: [],
        ranking: {
          strategy: "merged-score-v1",
          rank: 1,
          scoreBreakdown: {
            bestVariantScore: 0.9,
            corroborationBonus: 0.12,
            bestRankBonus: 0.35,
            tierAdjustment: 0,
            flagPenalty: 0,
            finalScore: 1.09,
          },
          tieBreakers: {
            bestSourceTier: "high",
            bestRank: 1,
            providerCount: 2,
            title: "SDK Docs",
          },
        },
      },
      {
        title: "Plugin Guide",
        url: "https://docs.openclaw.ai/plugins/guide",
        canonicalUrl: "https://docs.openclaw.ai/plugins/guide",
        snippet: "How to write plugins.",
        siteName: "docs.openclaw.ai",
        providers: ["brave"],
        providerCount: 1,
        score: 0.8,
        bestRank: 2,
        bestSourceTier: "high",
        flags: [],
        rankings: [
          { providerId: "brave", rawRank: 2, score: 0.8, sourceType: "results", sourceTier: "high", flags: [] },
        ],
        variants: [],
        ranking: {
          strategy: "merged-score-v1",
          rank: 2,
          scoreBreakdown: {
            bestVariantScore: 0.8,
            corroborationBonus: 0,
            bestRankBonus: 0.31,
            tierAdjustment: 0,
            flagPenalty: 0.31,
            finalScore: 0.8,
          },
          tieBreakers: {
            bestSourceTier: "high",
            bestRank: 2,
            providerCount: 1,
            title: "Plugin Guide",
          },
        },
      },
    ],
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "search-fusion",
      aggregated: true,
    },
    ...overrides,
  };
}

const defaultRequest: ProviderSelectionRequest = {
  query: "openclaw plugin sdk",
  providers: ["brave", "tavily"],
  count: 5,
};

// ─── createAuditRecord ────────────────────────────────────────────────────────

test("createAuditRecord sets schemaVersion and preserves request", () => {
  const record = createAuditRecord({
    payload: minimalPayload(),
    request: defaultRequest,
    label: "sdk-test",
  });

  assert.equal(record.schemaVersion, AUDIT_SCHEMA_VERSION);
  assert.equal(record.label, "sdk-test");
  assert.deepEqual(record.request, defaultRequest);
});

test("createAuditRecord uses provided capturedAt timestamp", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const record = createAuditRecord({
    payload: minimalPayload(),
    request: defaultRequest,
    capturedAt: ts,
  });

  assert.equal(record.capturedAt, ts);
});

test("createAuditRecord defaults to current time when capturedAt is omitted", () => {
  const before = Date.now();
  const record = createAuditRecord({ payload: minimalPayload(), request: defaultRequest });
  const after = Date.now();
  const ts = new Date(record.capturedAt).getTime();

  assert.ok(ts >= before, "capturedAt should be >= before");
  assert.ok(ts <= after, "capturedAt should be <= after");
});

test("createAuditRecord populates summary from payload", () => {
  const record = createAuditRecord({ payload: minimalPayload(), request: defaultRequest });

  assert.equal(record.summary.mergedResultCount, 2);
  assert.deepEqual(record.summary.providersQueried, ["brave", "tavily"]);
  assert.deepEqual(record.summary.providersSucceeded, ["brave", "tavily"]);
  assert.deepEqual(record.summary.providersFailed, []);
  assert.deepEqual(record.summary.answerProviders, []);
});

test("createAuditRecord builds providerSummaries for each run", () => {
  const record = createAuditRecord({ payload: minimalPayload(), request: defaultRequest });

  assert.equal(record.providerSummaries.length, 2);
  const brave = record.providerSummaries.find((ps) => ps.provider === "brave");
  assert.ok(brave);
  assert.equal(brave.ok, true);
  assert.equal(brave.rawCount, 2);
  assert.equal(brave.attempts, 1);
  assert.equal(brave.caveats.length, 0);
});

test("createAuditRecord reports error caveat when a provider fails", () => {
  const payload = minimalPayload({
    providersFailed: [{ provider: "tavily", error: "API timeout" }],
    providersSucceeded: ["brave"],
    providerRuns: [
      ...minimalPayload().providerRuns.slice(0, 1),
      {
        provider: "tavily",
        ok: false,
        tookMs: 15001,
        rawCount: 0,
        discardedCount: 0,
        attempts: 3,
        configured: true,
        results: [],
        discardedResults: [],
        retryHistory: [],
        error: "API timeout",
      },
    ],
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  const tavilyCaveats = record.providerSummaries
    .find((ps) => ps.provider === "tavily")
    ?.caveats ?? [];
  assert.ok(tavilyCaveats.some((c) => c.severity === "error" && c.code === "provider-run-failed"));
});

test("createAuditRecord raises auth-error caveat for credential failures", () => {
  const payload = minimalPayload({
    providersFailed: [{ provider: "brave", error: "401 invalid API key" }],
    providersSucceeded: ["tavily"],
    providerRuns: [
      {
        provider: "brave",
        ok: false,
        tookMs: 50,
        rawCount: 0,
        discardedCount: 0,
        attempts: 1,
        configured: true,
        results: [],
        discardedResults: [],
        retryHistory: [],
        error: "401 invalid API key",
      },
      ...minimalPayload().providerRuns.slice(1),
    ],
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  const braveCaveats = record.providerSummaries
    .find((ps) => ps.provider === "brave")
    ?.caveats ?? [];
  assert.ok(braveCaveats.some((c) => c.code === "provider-auth-error"));
});

test("createAuditRecord warns when a provider needed retries", () => {
  const payload = minimalPayload({
    providerRuns: [
      { ...minimalPayload().providerRuns[0]!, attempts: 3 },
      minimalPayload().providerRuns[1]!,
    ],
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  const braveCaveats = record.providerSummaries.find((ps) => ps.provider === "brave")?.caveats ?? [];
  assert.ok(braveCaveats.some((c) => c.code === "provider-needed-retry"));
});

test("createAuditRecord emits top-level caveat when all providers fail", () => {
  const payload = minimalPayload({
    providersSucceeded: [],
    providersFailed: [
      { provider: "brave", error: "timeout" },
      { provider: "tavily", error: "timeout" },
    ],
    results: [],
    providerRuns: minimalPayload().providerRuns.map((run) => ({
      ...run,
      ok: false,
      rawCount: 0,
      results: [],
      error: "timeout",
    })),
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  assert.ok(record.caveats.some((c) => c.code === "all-providers-failed" && c.severity === "error"));
});

test("createAuditRecord emits top-level caveat for high sponsored ratio", () => {
  const payload = minimalPayload({
    results: [
      { ...minimalPayload().results[0]!, flags: ["sponsored"], canonicalUrl: "https://a.com", url: "https://a.com", providers: ["brave"] },
      { ...minimalPayload().results[0]!, flags: ["sponsored"], canonicalUrl: "https://b.com", url: "https://b.com", providers: ["brave"] },
      { ...minimalPayload().results[0]!, flags: ["sponsored"], canonicalUrl: "https://c.com", url: "https://c.com", providers: ["brave"] },
      { ...minimalPayload().results[1]!, flags: [], canonicalUrl: "https://d.com", url: "https://d.com" },
    ],
    count: 4,
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  assert.ok(record.caveats.some((c) => c.code === "high-sponsored-ratio" && c.severity === "warn"));
});

test("createAuditRecord computes flaggedResultFraction correctly", () => {
  const payload = minimalPayload({
    providerRuns: [
      {
        ...minimalPayload().providerRuns[0]!,
        results: [
          { ...minimalPayload().providerRuns[0]!.results[0]!, flags: ["sponsored"] },
          { ...minimalPayload().providerRuns[0]!.results[1]!, flags: [] },
        ],
      },
      minimalPayload().providerRuns[1]!,
    ],
  });
  const record = createAuditRecord({ payload, request: defaultRequest });

  const brave = record.providerSummaries.find((ps) => ps.provider === "brave");
  assert.equal(brave?.flaggedResultFraction, 0.5);
  assert.deepEqual(brave?.observedFlags, ["sponsored"]);
});

// ─── parseAuditRecord ─────────────────────────────────────────────────────────

test("parseAuditRecord round-trips through JSON serialization", () => {
  const original = createAuditRecord({
    payload: minimalPayload(),
    request: defaultRequest,
    label: "round-trip",
    capturedAt: "2026-04-09T10:00:00.000Z",
  });
  const json = JSON.stringify(original);
  const parsed = parseAuditRecord(json);

  assert.equal(parsed.schemaVersion, AUDIT_SCHEMA_VERSION);
  assert.equal(parsed.label, "round-trip");
  assert.equal(parsed.capturedAt, "2026-04-09T10:00:00.000Z");
  assert.deepEqual(parsed.summary, original.summary);
});

test("parseAuditRecord throws on missing or wrong schemaVersion", () => {
  assert.throws(() => parseAuditRecord("{}"), /schemaVersion/);
  assert.throws(
    () => parseAuditRecord(JSON.stringify({ schemaVersion: 99 })),
    /schemaVersion/,
  );
  assert.throws(() => parseAuditRecord("not json at all"), /SyntaxError|Unexpected/);
});

test("parseAuditRecord loads the example fixture without throwing", () => {
  const fixturePath = path.resolve(import.meta.dirname, "fixtures", "example-audit.json");
  const json = fs.readFileSync(fixturePath, "utf8");
  const record = parseAuditRecord(json);

  assert.equal(record.schemaVersion, AUDIT_SCHEMA_VERSION);
  assert.equal(record.label, "openclaw plugin sdk docs");
  assert.equal(record.summary.mergedResultCount, 3);
  assert.deepEqual(record.summary.providersQueried, ["brave", "tavily"]);
});

// ─── renderAuditReview ────────────────────────────────────────────────────────

test("renderAuditReview contains query and provider status", () => {
  const record = createAuditRecord({ payload: minimalPayload(), request: defaultRequest, label: "review-test" });
  const review = renderAuditReview(record);

  assert.match(review, /openclaw plugin sdk/);
  assert.match(review, /brave/);
  assert.match(review, /tavily/);
  assert.match(review, /Merged results/i);
  assert.match(review, /Provider source quality/i);
});

test("renderAuditReview includes caveats when present", () => {
  const payload = minimalPayload({
    providersSucceeded: ["brave"],
    providersFailed: [{ provider: "tavily", error: "timeout" }],
    providerRuns: [
      minimalPayload().providerRuns[0]!,
      {
        provider: "tavily",
        ok: false,
        tookMs: 5000,
        rawCount: 0,
        discardedCount: 0,
        attempts: 3,
        configured: true,
        results: [],
        discardedResults: [],
        retryHistory: [],
        error: "timeout",
      },
    ],
  });
  const record = createAuditRecord({ payload, request: defaultRequest });
  const review = renderAuditReview(record);

  assert.match(review, /some-providers-failed|provider-run-failed/);
});

test("renderAuditReview renders fixture without throwing", () => {
  const fixturePath = path.resolve(import.meta.dirname, "fixtures", "example-audit.json");
  const json = fs.readFileSync(fixturePath, "utf8");
  const record = parseAuditRecord(json);
  const review = renderAuditReview(record);

  assert.ok(review.length > 100);
  assert.match(review, /openclaw plugin sdk docs/i);
  assert.match(review, /brave/);
  assert.match(review, /tavily/);
});

// ─── compareAuditRecords ─────────────────────────────────────────────────────

test("compareAuditRecords detects added and removed URLs", () => {
  const original = createAuditRecord({ payload: minimalPayload(), request: defaultRequest, capturedAt: "2026-04-09T10:00:00.000Z" });

  // Rerun: SDK Docs retained, Plugin Guide removed, new GitHub result added
  const rerunPayload = minimalPayload({
    results: [
      minimalPayload().results[0]!,
      {
        title: "Search Fusion on GitHub",
        url: "https://github.com/VACInc/openclaw-search-fusion",
        canonicalUrl: "https://github.com/VACInc/openclaw-search-fusion",
        providers: ["tavily"],
        providerCount: 1,
        score: 0.75,
        bestRank: 2,
        bestSourceTier: "high",
        flags: [],
        rankings: [],
        variants: [],
        ranking: {
          strategy: "merged-score-v1",
          rank: 2,
          scoreBreakdown: {
            bestVariantScore: 0.75,
            corroborationBonus: 0,
            bestRankBonus: 0.31,
            tierAdjustment: 0,
            flagPenalty: 0.31,
            finalScore: 0.75,
          },
          tieBreakers: {
            bestSourceTier: "high",
            bestRank: 2,
            providerCount: 1,
            title: "Search Fusion on GitHub",
          },
        },
      },
    ],
    count: 2,
  });
  const rerun = createAuditRecord({ payload: rerunPayload, request: defaultRequest, capturedAt: "2026-04-09T11:00:00.000Z" });
  const diff = compareAuditRecords(original, rerun);

  assert.deepEqual(diff.urlsRetained, ["https://docs.openclaw.ai/plugins/sdk"]);
  assert.deepEqual(diff.urlsAdded, ["https://github.com/VACInc/openclaw-search-fusion"]);
  assert.deepEqual(diff.urlsRemoved, ["https://docs.openclaw.ai/plugins/guide"]);
  assert.match(diff.summary, /Added URLs/);
  assert.match(diff.summary, /Removed URLs/);
});

test("compareAuditRecords reports no changes when results are identical", () => {
  const record = createAuditRecord({ payload: minimalPayload(), request: defaultRequest, capturedAt: "2026-04-09T10:00:00.000Z" });
  const rerun = createAuditRecord({ payload: minimalPayload(), request: defaultRequest, capturedAt: "2026-04-09T11:00:00.000Z" });
  const diff = compareAuditRecords(record, rerun);

  assert.equal(diff.urlsAdded.length, 0);
  assert.equal(diff.urlsRemoved.length, 0);
  assert.equal(diff.urlsRetained.length, 2);
  assert.match(diff.summary, /No changes detected/);
});

test("compareAuditRecords detects provider status changes", () => {
  const original = createAuditRecord({ payload: minimalPayload(), request: defaultRequest, capturedAt: "2026-04-09T10:00:00.000Z" });
  const rerunPayload = minimalPayload({
    providersSucceeded: ["brave"],
    providersFailed: [{ provider: "tavily", error: "timeout" }],
  });
  const rerun = createAuditRecord({ payload: rerunPayload, request: defaultRequest, capturedAt: "2026-04-09T11:00:00.000Z" });
  const diff = compareAuditRecords(original, rerun);

  assert.ok(diff.providerChanges.some((c) => c.includes("tavily") && c.includes("failed")));
  assert.match(diff.summary, /Provider status changes/);
});
