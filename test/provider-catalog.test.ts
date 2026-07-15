import test from "node:test";
import assert from "node:assert/strict";
import { findMissingProviders, KNOWN_PROVIDERS } from "../src/provider-catalog.js";
import { resolveProviderCapabilities } from "../src/provider-capabilities.js";

test("KNOWN_PROVIDERS matches the OpenClaw 2026.7.2 web-search catalog", () => {
  assert.deepEqual(
    KNOWN_PROVIDERS.map(({ id, pluginId, envVars, keyless }) => ({
      id,
      pluginId,
      envVars,
      keyless,
    })),
    [
      { id: "brave", pluginId: "brave", envVars: ["BRAVE_API_KEY"], keyless: false },
      { id: "codex", pluginId: "codex", envVars: [], keyless: false },
      { id: "duckduckgo", pluginId: "duckduckgo", envVars: [], keyless: true },
      { id: "exa", pluginId: "exa", envVars: ["EXA_API_KEY"], keyless: false },
      {
        id: "firecrawl",
        pluginId: "firecrawl",
        envVars: ["FIRECRAWL_API_KEY"],
        keyless: false,
      },
      { id: "firecrawl-free", pluginId: "firecrawl", envVars: [], keyless: true },
      { id: "gemini", pluginId: "google", envVars: ["GEMINI_API_KEY"], keyless: false },
      { id: "grok", pluginId: "xai", envVars: ["XAI_API_KEY"], keyless: false },
      {
        id: "kimi",
        pluginId: "moonshot",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        keyless: false,
      },
      {
        id: "minimax",
        pluginId: "minimax",
        envVars: [
          "MINIMAX_CODE_PLAN_KEY",
          "MINIMAX_CODING_API_KEY",
          "MINIMAX_OAUTH_TOKEN",
          "MINIMAX_API_KEY",
        ],
        keyless: false,
      },
      { id: "ollama", pluginId: "ollama", envVars: ["OLLAMA_API_KEY"], keyless: false },
      { id: "parallel", pluginId: "parallel", envVars: ["PARALLEL_API_KEY"], keyless: false },
      { id: "parallel-free", pluginId: "parallel", envVars: [], keyless: true },
      {
        id: "perplexity",
        pluginId: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
        keyless: false,
      },
      { id: "searxng", pluginId: "searxng", envVars: ["SEARXNG_BASE_URL"], keyless: false },
      { id: "tavily", pluginId: "tavily", envVars: ["TAVILY_API_KEY"], keyless: false },
    ],
  );
  assert.equal(KNOWN_PROVIDERS.some((provider) => provider.id === "qa-lab-search"), false);
  assert.deepEqual(
    KNOWN_PROVIDERS.map(({ id, label }) => ({ id, label })),
    [
      { id: "brave", label: "Brave Search" },
      { id: "codex", label: "Codex Hosted Search" },
      { id: "duckduckgo", label: "DuckDuckGo Search (experimental)" },
      { id: "exa", label: "Exa Search" },
      { id: "firecrawl", label: "Firecrawl Search" },
      { id: "firecrawl-free", label: "Firecrawl Search (Free)" },
      { id: "gemini", label: "Gemini (Google Search)" },
      { id: "grok", label: "Grok (xAI)" },
      { id: "kimi", label: "Kimi (Moonshot)" },
      { id: "minimax", label: "MiniMax Search" },
      { id: "ollama", label: "Ollama Web Search" },
      { id: "parallel", label: "Parallel Search" },
      { id: "parallel-free", label: "Parallel Search (Free)" },
      { id: "perplexity", label: "Perplexity Search" },
      { id: "searxng", label: "SearXNG Search" },
      { id: "tavily", label: "Tavily Search" },
    ],
  );
});

test("KNOWN_PROVIDERS references the shared capability registry", () => {
  for (const provider of KNOWN_PROVIDERS) {
    assert.equal(provider.capabilities, resolveProviderCapabilities(provider.id));
  }
});

test("findMissingProviders reports only plugins disabled or not enabled with safe hints", () => {
  const secret = "must-not-leak";
  const missing = findMissingProviders({
    config: {
      tools: { web: { search: { provider: "brave" } } },
      plugins: {
        entries: {
          parallel: {},
          xai: { enabled: false },
        },
      },
    },
    env: {
      FIRECRAWL_API_KEY: secret,
      GEMINI_API_KEY: "   ",
    },
  });

  assert.equal(missing.some((provider) => provider.id === "brave"), false);
  assert.equal(missing.some((provider) => provider.id === "parallel"), false);
  assert.equal(missing.some((provider) => provider.id === "parallel-free"), false);
  assert.equal(missing.some((provider) => provider.id === "grok"), true);
  assert.deepEqual(missing.find((provider) => provider.id === "firecrawl"), {
    id: "firecrawl",
    pluginId: "firecrawl",
    keyless: false,
    envKeyDetected: true,
  });
  assert.deepEqual(missing.find((provider) => provider.id === "firecrawl-free"), {
    id: "firecrawl-free",
    pluginId: "firecrawl",
    keyless: true,
    envKeyDetected: false,
  });
  assert.equal(missing.find((provider) => provider.id === "gemini")?.envKeyDetected, false);
  assert.equal(JSON.stringify(missing).includes(secret), false);
  assert.equal(JSON.stringify(missing).includes("FIRECRAWL_API_KEY"), false);
});
