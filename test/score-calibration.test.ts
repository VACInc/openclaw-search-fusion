import test from "node:test";
import assert from "node:assert/strict";
import { calibrateProviderScores } from "../src/result-normalizer.js";
import type { NormalizedSearchResult } from "../src/types.js";

function result(
  rawRank: number,
  nativeScore: number | undefined,
): NormalizedSearchResult {
  return {
    title: `Result ${rawRank}`,
    url: `https://example.com/${rawRank}`,
    originalUrl: `https://example.com/${rawRank}`,
    canonicalUrl: `https://example.com/${rawRank}`,
    providerId: "synthetic",
    score: 0,
    nativeScore,
    rawRank,
    sourceType: "results",
    sourceTier: "high",
    flags: [],
  };
}

test("calibrateProviderScores handles strategies and degenerate score sets", () => {
  const cases: Array<{
    name: string;
    scores: Array<number | undefined>;
    config?: Parameters<typeof calibrateProviderScores>[1];
    expectedScores: number[];
    expectedStrategy: "minmax" | "rank" | "fixed" | "none";
    expectedFallback?: string;
  }> = [
    {
      name: "default minmax",
      scores: [100, 60, 20],
      expectedScores: [1, 0.5, 0],
      expectedStrategy: "minmax",
    },
    {
      name: "none passes native scores through uncalibrated",
      scores: [0.9, 0.2, 0.5],
      config: { strategy: "none" },
      expectedScores: [0.9, 0.2, 0.5],
      expectedStrategy: "none",
    },
    {
      name: "none clamps native scores above one",
      scores: [500, 0.4],
      config: { strategy: "none" },
      expectedScores: [1, 0.4],
      expectedStrategy: "none",
    },
    {
      name: "none keeps singleton and constant sets as-is",
      scores: [0.7],
      config: { strategy: "none" },
      expectedScores: [0.7],
      expectedStrategy: "none",
    },
    {
      name: "none falls back to rank on missing scores",
      scores: [0.9, undefined, 0.5],
      config: { strategy: "none" },
      expectedScores: [1, 0.5, 0.333333],
      expectedStrategy: "rank",
      expectedFallback: "missing-or-invalid-scores",
    },
    {
      name: "explicit rank ignores native scale",
      scores: [0.01, 500, 2],
      config: { strategy: "rank" },
      expectedScores: [1, 0.5, 0.333333],
      expectedStrategy: "rank",
    },
    {
      name: "single result",
      scores: [0.42],
      expectedScores: [1],
      expectedStrategy: "rank",
      expectedFallback: "single-result",
    },
    {
      name: "all equal scores",
      scores: [7, 7, 7],
      expectedScores: [1, 0.5, 0.333333],
      expectedStrategy: "rank",
      expectedFallback: "constant-scores",
    },
    {
      name: "missing score",
      scores: [0.9, undefined, 0.1],
      expectedScores: [1, 0.5, 0.333333],
      expectedStrategy: "rank",
      expectedFallback: "missing-or-invalid-scores",
    },
    {
      name: "NaN score",
      scores: [0.9, Number.NaN],
      expectedScores: [1, 0.5],
      expectedStrategy: "rank",
      expectedFallback: "missing-or-invalid-scores",
    },
    {
      name: "negative score",
      scores: [0.9, -1],
      expectedScores: [1, 0.5],
      expectedStrategy: "rank",
      expectedFallback: "missing-or-invalid-scores",
    },
    {
      name: "fixed curve interpolates and clamps endpoints",
      scores: [0, 30, 100],
      config: {
        strategy: "fixed",
        curve: [
          { input: 10, output: 0.2 },
          { input: 50, output: 0.8 },
        ],
      },
      expectedScores: [0.2, 0.5, 0.8],
      expectedStrategy: "fixed",
    },
    {
      name: "fixed curve calibrates a singleton absolutely",
      scores: [0.1],
      config: {
        strategy: "fixed",
        curve: [
          { input: 0, output: 0 },
          { input: 1, output: 1 },
        ],
      },
      expectedScores: [0.1],
      expectedStrategy: "fixed",
    },
    {
      name: "fixed curve calibrates equal scores absolutely",
      scores: [0.1, 0.1],
      config: {
        strategy: "fixed",
        curve: [
          { input: 0, output: 0 },
          { input: 1, output: 1 },
        ],
      },
      expectedScores: [0.1, 0.1],
      expectedStrategy: "fixed",
    },
    {
      name: "curve implies fixed strategy",
      scores: [0, 0.5, 1],
      config: {
        curve: [
          { input: 0, output: 0.1 },
          { input: 1, output: 0.9 },
        ],
      },
      expectedScores: [0.1, 0.5, 0.9],
      expectedStrategy: "fixed",
    },
  ];

  for (const row of cases) {
    const calibrated = calibrateProviderScores(
      row.scores.map((score, index) => result(index + 1, score)),
      row.config,
    );
    assert.deepEqual(calibrated.scores, row.expectedScores, row.name);
    assert.equal(calibrated.strategy, row.expectedStrategy, row.name);
    assert.equal(calibrated.fallback, row.expectedFallback, row.name);
    assert.ok(
      calibrated.scores.every((score) => score >= 0 && score <= 1),
      `${row.name}: calibrated scores must stay in [0, 1]`,
    );
  }
});

test("calibrateProviderScores rejects invalid fixed curves", () => {
  const cases: Array<{
    name: string;
    curve: NonNullable<Parameters<typeof calibrateProviderScores>[1]>["curve"];
    error: RegExp;
  }> = [
    {
      name: "too short",
      curve: [{ input: 0, output: 0 }],
      error: /at least two curve points/,
    },
    {
      name: "duplicate input",
      curve: [
        { input: 0, output: 0 },
        { input: 0, output: 1 },
      ],
      error: /strictly increasing/,
    },
    {
      name: "decreasing output",
      curve: [
        { input: 0, output: 1 },
        { input: 1, output: 0 },
      ],
      error: /non-decreasing/,
    },
    {
      name: "output outside unit interval",
      curve: [
        { input: 0, output: 0 },
        { input: 1, output: 1.1 },
      ],
      error: /between 0 and 1/,
    },
  ];

  for (const row of cases) {
    assert.throws(
      () =>
        calibrateProviderScores(
          [result(1, 0), result(2, 1)],
          { strategy: "fixed", curve: row.curve },
        ),
      row.error,
      row.name,
    );
  }

  assert.throws(
    () =>
      calibrateProviderScores(
        [result(1, 0), result(2, 1)],
        { strategy: "unknown" } as never,
      ),
    /Unknown score calibration strategy/,
  );
});
