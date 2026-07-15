import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PROVIDER_CAPABILITIES,
  filterByAnyCapability,
  filterByCapabilities,
  hasCapability,
  resolveProviderCapabilities,
  type ProviderCapability,
} from "../src/provider-capabilities.js";

// ---------------------------------------------------------------------------
// resolveProviderCapabilities
// ---------------------------------------------------------------------------

test("resolveProviderCapabilities returns registered capabilities for known providers", () => {
  assert.deepEqual(resolveProviderCapabilities("brave"), ["news", "privacy", "results"]);
  assert.deepEqual(resolveProviderCapabilities("codex"), ["answer", "results"]);
  assert.deepEqual(resolveProviderCapabilities("gemini"), ["answer", "results"]);
  assert.deepEqual(resolveProviderCapabilities("duckduckgo"), ["free-tier", "privacy", "results"]);
  assert.deepEqual(resolveProviderCapabilities("exa"), ["academic", "code", "extract", "neural", "results"]);
  assert.deepEqual(resolveProviderCapabilities("firecrawl"), ["results"]);
  assert.deepEqual(resolveProviderCapabilities("firecrawl-free"), ["free-tier", "results"]);
  assert.deepEqual(resolveProviderCapabilities("minimax"), ["code", "results"]);
  assert.deepEqual(resolveProviderCapabilities("ollama"), ["free-tier", "results"]);
  assert.deepEqual(resolveProviderCapabilities("parallel"), ["extract", "neural", "results"]);
  assert.deepEqual(resolveProviderCapabilities("parallel-free"), ["extract", "free-tier", "neural", "results"]);
  assert.deepEqual(resolveProviderCapabilities("perplexity"), ["answer", "neural", "results"]);
  assert.deepEqual(resolveProviderCapabilities("tavily"), ["neural", "results"]);
});

test("resolveProviderCapabilities excludes non-runtime google and serper ids", () => {
  assert.deepEqual(resolveProviderCapabilities("google"), []);
  assert.deepEqual(resolveProviderCapabilities("serper"), []);
});

test("resolveProviderCapabilities is case-insensitive", () => {
  assert.deepEqual(resolveProviderCapabilities("Brave"), resolveProviderCapabilities("brave"));
  assert.deepEqual(resolveProviderCapabilities("GEMINI"), resolveProviderCapabilities("gemini"));
});

test("resolveProviderCapabilities returns empty array for unknown providers", () => {
  assert.deepEqual(resolveProviderCapabilities("unknown-provider"), []);
  assert.deepEqual(resolveProviderCapabilities(""), []);
  assert.deepEqual(resolveProviderCapabilities("my-custom-api"), []);
});

test("resolveProviderCapabilities results are sorted and match ALL_PROVIDER_CAPABILITIES vocabulary", () => {
  // Every returned capability should be a recognised tag; and entries in each
  // provider's list should be in alphabetical order (how the registry is kept).
  const allKnown: readonly ProviderCapability[] = ALL_PROVIDER_CAPABILITIES;
  const known = new Set<string>(allKnown);

  const registeredIds = [
    "brave",
    "codex",
    "duckduckgo",
    "exa",
    "firecrawl",
    "firecrawl-free",
    "gemini",
    "grok",
    "kimi",
    "minimax",
    "ollama",
    "parallel",
    "parallel-free",
    "perplexity",
    "searxng",
    "tavily",
  ];

  for (const id of registeredIds) {
    const caps = resolveProviderCapabilities(id);
    for (const cap of caps) {
      assert.ok(known.has(cap), `${id}: unknown capability "${cap}"`);
    }
    // Registry entries are kept in alphabetical order within each provider.
    const sorted = [...caps].sort();
    assert.deepEqual(caps, sorted, `${id}: capabilities are not alphabetically sorted`);
  }
});

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

test("hasCapability returns true when capability is present", () => {
  const caps = resolveProviderCapabilities("gemini");
  assert.equal(hasCapability(caps, "answer"), true);
  assert.equal(hasCapability(caps, "results"), true);
});

test("hasCapability returns false when capability is absent", () => {
  const caps = resolveProviderCapabilities("gemini");
  assert.equal(hasCapability(caps, "free-tier"), false);
  assert.equal(hasCapability(caps, "privacy"), false);
});

test("hasCapability works on an empty array", () => {
  assert.equal(hasCapability([], "results"), false);
});

// ---------------------------------------------------------------------------
// filterByCapabilities (ALL required)
// ---------------------------------------------------------------------------

test("filterByCapabilities keeps providers that have all required capabilities", () => {
  const providers = ["brave", "duckduckgo", "gemini", "exa", "tavily"];

  assert.deepEqual(
    filterByCapabilities(providers, ["results"]),
    ["brave", "duckduckgo", "gemini", "exa", "tavily"],
  );

  assert.deepEqual(
    filterByCapabilities(providers, ["answer"]),
    ["gemini"],
  );

  // DuckDuckGo is the only one that is both free-tier AND privacy-conscious.
  assert.deepEqual(
    filterByCapabilities(providers, ["free-tier", "privacy"]),
    ["duckduckgo"],
  );

  // No provider in the list has both "academic" and "answer".
  assert.deepEqual(
    filterByCapabilities(providers, ["academic", "answer"]),
    [],
  );
});

test("filterByCapabilities with empty required list returns all providers", () => {
  const providers = ["brave", "duckduckgo", "gemini"];
  assert.deepEqual(filterByCapabilities(providers, []), providers);
});

test("filterByCapabilities handles unknown providers gracefully", () => {
  // Unknown providers have no capabilities; they are dropped unless required is empty.
  assert.deepEqual(filterByCapabilities(["unknown-search"], ["results"]), []);
  assert.deepEqual(filterByCapabilities(["unknown-search"], []), ["unknown-search"]);
});

// ---------------------------------------------------------------------------
// filterByAnyCapability (ANY match)
// ---------------------------------------------------------------------------

test("filterByAnyCapability keeps providers that have at least one required capability", () => {
  const providers = ["brave", "duckduckgo", "gemini", "exa", "tavily"];

  // "answer" OR "academic"
  assert.deepEqual(
    filterByAnyCapability(providers, ["answer", "academic"]),
    ["gemini", "exa"],
  );

  // "free-tier" OR "privacy" — brave, duckduckgo have privacy; duckduckgo also has free-tier
  assert.deepEqual(
    filterByAnyCapability(providers, ["free-tier", "privacy"]),
    ["brave", "duckduckgo"],
  );
});

test("filterByAnyCapability with empty any list returns all providers", () => {
  const providers = ["brave", "duckduckgo", "gemini"];
  assert.deepEqual(filterByAnyCapability(providers, []), providers);
});

// ---------------------------------------------------------------------------
// ALL_PROVIDER_CAPABILITIES completeness
// ---------------------------------------------------------------------------

test("ALL_PROVIDER_CAPABILITIES contains every capability used in the registry", () => {
  const known = new Set<string>(ALL_PROVIDER_CAPABILITIES);
  const sample: ProviderCapability[] = [
    "results", "answer", "extract", "news", "images", "video",
    "local", "academic", "code", "neural", "free-tier", "privacy",
  ];
  for (const cap of sample) {
    assert.ok(known.has(cap), `ALL_PROVIDER_CAPABILITIES is missing "${cap}"`);
  }
  assert.equal(ALL_PROVIDER_CAPABILITIES.length, sample.length);
});
