import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySourceTier,
  coerceSourceTierMode,
  compareSourceTierDesc,
  pickHigherSourceTier,
  sourceTierMergedAdjustment,
  sourceTierMultiplier,
  sourceTierRank,
} from "../src/source-tier.js";
import type { SearchResultSourceTier, SourceTierMode } from "../src/types.js";

const TIERS: SearchResultSourceTier[] = ["suppressed", "low", "standard", "high"];
const MODES: SourceTierMode[] = ["off", "balanced", "strict"];

test("coerceSourceTierMode accepts valid modes in any case and defaults to balanced", () => {
  assert.equal(coerceSourceTierMode("off"), "off");
  assert.equal(coerceSourceTierMode("  STRICT "), "strict");
  assert.equal(coerceSourceTierMode("Balanced"), "balanced");
  for (const value of [undefined, null, "", "loose", 1, {}, ["off"]]) {
    assert.equal(coerceSourceTierMode(value), "balanced", String(value));
  }
});

test("sourceTierRank orders tiers and treats unknown tiers as standard", () => {
  assert.deepEqual(TIERS.map(sourceTierRank), [0, 1, 2, 3]);
  assert.equal(sourceTierRank("bogus" as SearchResultSourceTier), sourceTierRank("standard"));
});

test("compareSourceTierDesc sorts higher tiers first", () => {
  const shuffled: SearchResultSourceTier[] = ["low", "high", "suppressed", "standard"];
  assert.deepEqual([...shuffled].sort(compareSourceTierDesc), ["high", "standard", "low", "suppressed"]);
  assert.equal(compareSourceTierDesc("high", "high"), 0);
});

test("pickHigherSourceTier keeps the first argument on ties", () => {
  assert.equal(pickHigherSourceTier("low", "high"), "high");
  assert.equal(pickHigherSourceTier("high", "low"), "high");
  assert.equal(pickHigherSourceTier("standard", "standard"), "standard");
});

test("classifySourceTier applies flag precedence before source type", () => {
  assert.equal(classifySourceTier({ sourceType: "results", flags: [] }), "high");
  assert.equal(classifySourceTier({ sourceType: "sources", flags: [] }), "standard");
  assert.equal(classifySourceTier({ sourceType: "citations", flags: [] }), "low");
  for (const flag of ["redirect-wrapper", "community", "video"] as const) {
    assert.equal(classifySourceTier({ sourceType: "results", flags: [flag] }), "low", flag);
  }
  // Tracking-only cleanup does not lower trust.
  assert.equal(classifySourceTier({ sourceType: "results", flags: ["tracking-stripped"] }), "high");
  // Sponsored wins over every other signal.
  assert.equal(
    classifySourceTier({ sourceType: "results", flags: ["community", "sponsored", "video"] }),
    "suppressed",
  );
});

test("sourceTierMultiplier is neutral when off and monotonic by tier otherwise", () => {
  for (const tier of TIERS) {
    assert.equal(sourceTierMultiplier(tier, "off"), 1, tier);
  }
  assert.deepEqual(TIERS.map((tier) => sourceTierMultiplier(tier, "balanced")), [0.22, 0.45, 1, 1.08]);
  assert.deepEqual(TIERS.map((tier) => sourceTierMultiplier(tier, "strict")), [0.12, 0.28, 1, 1.12]);
});

test("sourceTierMergedAdjustment is zero when off and strict is stronger than balanced", () => {
  for (const tier of TIERS) {
    assert.equal(sourceTierMergedAdjustment(tier, "off"), 0, tier);
  }
  assert.deepEqual(TIERS.map((tier) => sourceTierMergedAdjustment(tier, "balanced")), [-0.4, -0.14, 0, 0.06]);
  assert.deepEqual(TIERS.map((tier) => sourceTierMergedAdjustment(tier, "strict")), [-0.6, -0.24, 0, 0.1]);
  for (const mode of MODES) {
    const values = TIERS.map((tier) => sourceTierMergedAdjustment(tier, mode));
    assert.deepEqual([...values].sort((a, b) => a - b), values, mode);
  }
});
