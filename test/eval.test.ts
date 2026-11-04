import test from "node:test";
import assert from "node:assert/strict";
import {
  listFixtureSets,
  loadFixtures,
  readBaseline,
  runSet,
} from "../eval/harness.js";
import {
  aggregateMetrics,
  computeQueryMetrics,
  dedupedGrades,
  INFORMATIONAL,
  LOWER_IS_BETTER,
  METRIC_NAMES,
  ndcgAt,
  type JudgedPage,
} from "../eval/metrics.js";
import type { FusionMergedResult, FusionSearchPayload } from "../src/types.js";

function page(id: string, grade: number, ...urls: string[]): JudgedPage {
  return { id, grade, urls };
}

function merged(urls: string[], snippet?: string, snippetSources?: Array<"provider" | "answer-fallback">): FusionMergedResult {
  return {
    title: urls[0],
    url: urls[0],
    canonicalUrl: urls[0],
    snippet,
    providers: urls.map((_, index) => `p${index}`),
    providerCount: urls.length,
    bestRank: 1,
    bestSourceTier: "high",
    flags: [],
    score: 1,
    rankings: [],
    variants: urls.map((url, index) => ({
      title: url,
      url,
      originalUrl: url,
      canonicalUrl: url,
      snippet,
      providerId: `p${index}`,
      score: 1,
      rawRank: 1,
      sourceType: "results" as const,
      sourceTier: "high" as const,
      snippetSource: snippetSources?.[index],
      flags: [],
    })),
  } as unknown as FusionMergedResult;
}

function payloadOf(results: FusionMergedResult[], answers: Array<{ fullContent: string; summary: string }> = []) {
  return { results, answers } as unknown as FusionSearchPayload;
}

test("eval metrics: duplicates earn no gain and are counted", () => {
  const pages = [page("a", 3, "https://a/1", "https://a/2"), page("b", 2, "https://b")];
  const metrics = computeQueryMetrics({
    payload: payloadOf([merged(["https://a/1"]), merged(["https://a/2"]), merged(["https://b"])]),
    pages,
    retrievable: pages,
  });
  assert.equal(metrics["dup@10"], 1 / 3);
  assert.deepEqual(dedupedGrades([pages[0], pages[0], pages[1]]), [3, 0, 2]);
  assert.ok(metrics["ndcg@5"] < 1);
  assert.equal(metrics.mrr, 1);
});

test("eval metrics: ideal ordering scores ndcg 1 and junk is measured", () => {
  const pages = [page("a", 3, "https://a"), page("b", 2, "https://b"), page("c", 0, "https://c")];
  assert.equal(ndcgAt(pages, pages, 5), 1);
  const metrics = computeQueryMetrics({
    payload: payloadOf([merged(["https://c"]), merged(["https://a"])]),
    pages,
    retrievable: pages,
  });
  assert.equal(metrics["junk@5"], 0.5);
  assert.equal(metrics.mrr, 0.5);
});

test("eval metrics: snippet fallback, false merges, and answer recall", () => {
  const pages = [page("a", 3, "https://a"), page("b", 2, "https://b")];
  const metrics = computeQueryMetrics({
    payload: payloadOf(
      [merged(["https://a", "https://b"], "answer text", ["provider", "answer-fallback"])],
      [{ fullContent: "The answer is 42", summary: "The answer is 42" }],
    ),
    pages,
    retrievable: pages,
    mustMention: ["42", "forty-two"],
  });
  assert.equal(metrics.falseMerge, 1);
  assert.equal(metrics.answerRecall, 0.5);
  // The merged snippet came from the answer although a provider had a page snippet.
  const fallback = merged(["https://a", "https://a"], "x", ["provider", "answer-fallback"]);
  fallback.variants[0].snippet = "real page snippet";
  const withFallback = computeQueryMetrics({ payload: payloadOf([fallback]), pages, retrievable: pages });
  assert.equal(withFallback.snippetFallback, 1);
});

test("eval metrics: aggregate skips undefined values", () => {
  const base = {
    "ndcg@5": 1,
    "ndcg@10": 1,
    "p@5": 1,
    mrr: undefined,
    "dup@10": 0,
    "junk@5": 0,
    "domains@5": 5,
    snippetFallback: 0,
    falseMerge: 0,
    answerRecall: undefined,
  };
  const aggregate = aggregateMetrics([base, { ...base, mrr: 0.5, "ndcg@5": 0 }]);
  assert.equal(aggregate.mrr, 0.5);
  assert.equal(aggregate["ndcg@5"], 0.5);
  assert.equal(aggregate.answerRecall, 0);
});

test("eval fixtures: ids are unique and grades are 0-3", () => {
  const sets = listFixtureSets();
  assert.ok(sets.includes("dev"), "dev fixture set exists");
  const ids = new Set<string>();
  for (const set of sets) {
    for (const fixture of loadFixtures(set)) {
      assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
      ids.add(fixture.id);
      for (const judged of fixture.pages) {
        assert.ok(Number.isInteger(judged.grade) && judged.grade >= 0 && judged.grade <= 3, `${fixture.id}/${judged.id} grade`);
      }
    }
  }
});

test("eval: result quality does not regress below the recorded baseline", async () => {
  const baseline = readBaseline();
  assert.ok(baseline, "eval/baseline.json exists");
  for (const set of listFixtureSets()) {
    const report = await runSet(set);
    for (const run of report.runs) {
      assert.deepEqual(run.unjudgedUrls, [], `${set}/${run.fixture.id} has unjudged URLs`);
    }
    const floor = baseline[set];
    assert.ok(floor, `baseline has an entry for fixture set "${set}"`);
    for (const name of METRIC_NAMES) {
      if (INFORMATIONAL.has(name)) continue;
      const value = Math.round(report.aggregate[name] * 10_000) / 10_000;
      if (LOWER_IS_BETTER.has(name)) {
        assert.ok(value <= floor[name], `${set} ${name} regressed: ${value} > baseline ${floor[name]}`);
      } else {
        assert.ok(value >= floor[name], `${set} ${name} regressed: ${value} < baseline ${floor[name]}`);
      }
    }
  }
});
