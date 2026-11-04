import test from "node:test";
import assert from "node:assert/strict";
import { findMissingProviders, isKnownProviderPluginEnabled, KNOWN_PROVIDERS } from "../src/provider-catalog.js";
import { discoverProviders } from "../src/provider-discovery.js";

const brave = KNOWN_PROVIDERS.find((entry) => entry.id === "brave")!;
const tavily = KNOWN_PROVIDERS.find((entry) => entry.id === "tavily")!;

function catalogIds(config: unknown): string[] {
  return discoverProviders({ providers: [], config, env: {}, selfId: "search-fusion" }).map((entry) => entry.id);
}

test("denylisted plugins are not treated as enabled catalog providers", () => {
  const config = {
    plugins: {
      deny: [" Brave "],
      entries: { brave: { config: { webSearch: { apiKey: "left-over" } } }, tavily: {} },
    },
  };
  assert.equal(isKnownProviderPluginEnabled(brave, config), false);
  assert.equal(isKnownProviderPluginEnabled(tavily, config), true);
  assert.deepEqual(catalogIds(config), ["tavily"]);
  assert.ok(findMissingProviders({ config, env: {} }).some((entry) => entry.id === "brave"));
});

test("a globally disabled plugin system enables no catalog providers", () => {
  const config = {
    plugins: { enabled: false, entries: { brave: {}, tavily: {} } },
    tools: { web: { search: { provider: "brave" } } },
  };
  assert.deepEqual(catalogIds(config), []);
  assert.equal(findMissingProviders({ config, env: {} }).length, KNOWN_PROVIDERS.length);
});

test("an explicitly disabled entry wins over the selected web search provider", () => {
  const config = {
    plugins: { entries: { brave: { enabled: false } } },
    tools: { web: { search: { provider: "brave" } } },
  };
  assert.equal(isKnownProviderPluginEnabled(brave, config), false);
  assert.deepEqual(catalogIds(config), []);
});

test("a plugin allowlist gates bundled catalog providers unless compat discovery is on", () => {
  const entries = { brave: {}, tavily: {} };
  const allowlisted = { plugins: { allow: ["tavily", "search-fusion"], entries } };
  assert.deepEqual(catalogIds(allowlisted), ["tavily"]);

  const compat = { plugins: { allow: ["tavily"], bundledDiscovery: "compat", entries } };
  assert.deepEqual(catalogIds(compat), ["brave", "tavily"]);

  // An empty allowlist is not a restriction.
  assert.deepEqual(catalogIds({ plugins: { allow: [], entries } }), ["brave", "tavily"]);
});

test("ordinary enabled entries and the selected provider still enable catalog providers", () => {
  assert.deepEqual(catalogIds({ plugins: { entries: { brave: {} } } }), ["brave"]);
  assert.deepEqual(catalogIds({ tools: { web: { search: { provider: "tavily" } } } }), ["tavily"]);
  assert.deepEqual(catalogIds({ plugins: { deny: "brave", entries: { brave: {} } } }), ["brave"]);
});
