import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverProviders,
  FREE_TIER_PROVIDER_SIBLINGS,
  resolveProviderConfiguration,
  preferPaidProviderSiblings,
  resolveSelectedProviders,
} from "../src/provider-discovery.js";

const providers = [
  {
    id: "brave",
    label: "Brave",
    autoDetectOrder: 10,
    envVars: [],
    getConfiguredCredentialValue: () => "brave-key",
    getCredentialValue: () => undefined,
  },
  {
    id: "tavily",
    label: "Tavily",
    autoDetectOrder: 20,
    envVars: [],
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: () => undefined,
  },
  {
    id: "gemini",
    label: "Gemini",
    autoDetectOrder: 30,
    envVars: [],
    getConfiguredCredentialValue: () => "gemini-key",
    getCredentialValue: () => undefined,
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    autoDetectOrder: 100,
    requiresCredential: false,
    envVars: [],
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: () => undefined,
  },
  {
    id: "search-fusion",
    label: "Search Fusion",
    autoDetectOrder: 999,
    envVars: [],
    getConfiguredCredentialValue: () => "always-enabled",
    getCredentialValue: () => undefined,
  },
] as const;

function getDiscovered() {
  return discoverProviders({
    providers: [...providers],
    config: {},
    selfId: "search-fusion",
  });
}

test("discoverProviders excludes self and marks configured providers", () => {
  const discovered = getDiscovered();

  assert.deepEqual(
    discovered.map((provider) => ({ id: provider.id, configured: provider.configured })),
    [
      { id: "brave", configured: true },
      { id: "tavily", configured: false },
      { id: "gemini", configured: true },
      { id: "duckduckgo", configured: true },
    ],
  );
});

test("discoverProviders attaches capability taxonomy tags", () => {
  const discovered = getDiscovered();
  const brave = discovered.find((p) => p.id === "brave");
  const gemini = discovered.find((p) => p.id === "gemini");
  const tavily = discovered.find((p) => p.id === "tavily");
  const duckduckgo = discovered.find((p) => p.id === "duckduckgo");

  assert.deepEqual(brave?.capabilities, ["news", "privacy", "results"]);
  assert.deepEqual(gemini?.capabilities, ["answer", "results"]);
  assert.deepEqual(tavily?.capabilities, ["neural", "results"]);
  assert.deepEqual(duckduckgo?.capabilities, ["free-tier", "privacy", "results"]);
});

test("discoverProviders prefers authoritative registry entries on catalog id collisions", () => {
  const discovered = discoverProviders({
    providers: [
      {
        id: "brave",
        label: "Registry Brave",
        hint: "registry metadata",
        getConfiguredCredentialValue: () => undefined,
      },
    ],
    config: {
      plugins: {
        entries: {
          brave: { config: { webSearch: { apiKey: "declared-brave-key" } } },
          tavily: { config: { webSearch: { apiKey: "declared-tavily-key" } } },
        },
      },
    },
    selfId: "search-fusion",
  });

  assert.equal(discovered.filter((provider) => provider.id === "brave").length, 1);
  assert.deepEqual(discovered.find((provider) => provider.id === "brave"), {
    id: "brave",
    label: "Registry Brave",
    hint: "registry metadata",
    autoDetectOrder: undefined,
    configured: false,
    capabilities: ["news", "privacy", "results"],
  });
  assert.deepEqual(discovered.find((provider) => provider.id === "tavily"), {
    id: "tavily",
    label: "Tavily Search",
    configured: true,
    credentialSource: "plugin-config (declared)",
    capabilities: ["neural", "results"],
  });
});

test("discoverProviders synthesizes selected-provider and enabled-plugin catalog entries", () => {
  const discovered = discoverProviders({
    providers: [],
    config: {
      tools: { web: { search: { provider: "codex" } } },
      plugins: { entries: { exa: {}, xai: {} } },
    },
    env: {},
    selfId: "search-fusion",
  });

  assert.deepEqual(discovered, [
    {
      id: "codex",
      label: "Codex Hosted Search",
      configured: true,
      credentialSource: "account-auth",
      capabilities: ["answer", "results"],
    },
    {
      id: "exa",
      label: "Exa Search",
      configured: false,
      hint: "Configure plugins.entries.exa.config.webSearch.apiKey or EXA_API_KEY.",
      capabilities: ["academic", "code", "extract", "neural", "results"],
    },
    {
      id: "grok",
      label: "Grok (xAI)",
      configured: true,
      credentialSource: "account-auth (unverified)",
      capabilities: ["answer", "news", "results"],
    },
  ]);
});

test("resolveSelectedProviders falls back to configured providers by default", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini", "duckduckgo"]);
});

test("resolveSelectedProviders keeps keyless providers in the default pool", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [
      {
        id: "duckduckgo",
        label: "DuckDuckGo",
        autoDetectOrder: 100,
        configured: true,
      },
      {
        id: "tavily",
        label: "Tavily",
        autoDetectOrder: 20,
        configured: false,
      },
    ],
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["duckduckgo"]);
});

test("resolveSelectedProviders lets explicit all override default exclusions", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestProviders: ["all"],
    config: { excludeProviders: ["brave"] },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini", "duckduckgo"]);
});

test("preferPaidProviderSiblings is deterministic and retains lone free providers", () => {
  assert.deepEqual(FREE_TIER_PROVIDER_SIBLINGS, {
    "firecrawl-free": "firecrawl",
    "parallel-free": "parallel",
  });

  const selected = preferPaidProviderSiblings([
    { id: "firecrawl-free", configured: true },
    { id: "brave" },
    { id: "firecrawl", configured: true },
    { id: "parallel", configured: true },
    { id: "parallel-free", configured: true },
    { id: "duckduckgo" },
  ]);
  assert.deepEqual(selected.map((provider) => provider.id), [
    "brave",
    "firecrawl",
    "parallel",
    "duckduckgo",
  ]);
  assert.deepEqual(
    preferPaidProviderSiblings([{ id: "firecrawl-free", configured: true }]).map((provider) => provider.id),
    ["firecrawl-free"],
  );
});

test("resolveSelectedProviders never fans out to paid and free siblings together", () => {
  const availableProviders = [
    { id: "firecrawl", label: "Firecrawl", configured: true },
    { id: "firecrawl-free", label: "Firecrawl Free", configured: true },
    { id: "parallel", label: "Parallel", configured: true },
    { id: "parallel-free", label: "Parallel Free", configured: true },
  ];

  const selected = resolveSelectedProviders({
    availableProviders,
    requestProviders: ["all"],
    config: {},
  });
  assert.deepEqual(selected.map((provider) => provider.id), ["firecrawl", "parallel"]);
});

test("resolveSelectedProviders keeps a configured free sibling when paid is unconfigured", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [
      { id: "firecrawl", label: "Firecrawl", configured: false },
      { id: "firecrawl-free", label: "Firecrawl Free", configured: true },
    ],
    requestProviders: ["firecrawl", "firecrawl-free"],
    config: {},
  });
  assert.deepEqual(selected.map((provider) => provider.id), ["firecrawl-free"]);
});

test("resolveSelectedProviders throws for unknown explicit ids and lists valid ids", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: getDiscovered(),
        requestProviders: ["tavliy"],
        config: {},
      }),
    /Unknown Search Fusion provider: tavliy\. Valid provider ids: brave, duckduckgo, gemini, tavily\./,
  );
});

test("resolveSelectedProviders lets an explicit provider override default exclusions", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestProviders: ["brave"],
    config: { excludeProviders: ["brave"] },
  });
  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders honors explicit mode", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestMode: "deep",
    config: {
      modes: {
        fast: ["brave"],
        deep: ["tavily", "gemini"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["tavily", "gemini"]);
});

test("resolveSelectedProviders provides built-in starter modes when custom modes are absent", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestMode: "balanced",
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini"]);
});

test("resolveSelectedProviders lets defaultMode target built-in starter modes", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {
      defaultMode: "fast",
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders treats custom modes as authoritative", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: getDiscovered(),
        requestMode: "balanced",
        config: {
          modes: {
            custom: ["gemini"],
          },
        },
      }),
    /Unknown Search Fusion mode: balanced/,
  );
});

test("resolveSelectedProviders honors defaultMode before legacy defaultProviders", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    config: {
      defaultMode: "balanced",
      modes: {
        balanced: ["brave", "tavily"],
      },
      defaultProviders: ["gemini"],
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "tavily"]);
});

test("resolveSelectedProviders throws on unknown explicit mode", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: getDiscovered(),
        requestMode: "chaos",
        config: {
          modes: {
            fast: ["brave"],
          },
        },
      }),
    /Unknown Search Fusion mode: chaos/,
  );
});

test("resolveSelectedProviders routes by intent when intentProviders is configured", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "research",
    config: {
      intentProviders: {
        research: ["gemini", "tavily", "brave"],
        keyword: ["brave", "duckduckgo"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["gemini", "tavily", "brave"]);
});

test("resolveSelectedProviders uses answer capabilities when intentProviders is omitted", () => {
  const availableProviders = [
    "codex",
    "gemini",
    "grok",
    "kimi",
    "perplexity",
    "firecrawl",
  ].map((id) => ({ id, label: id, configured: true }));

  const selected = resolveSelectedProviders({
    availableProviders,
    requestIntent: "answer",
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), [
    "codex",
    "gemini",
    "grok",
    "kimi",
    "perplexity",
  ]);
});

test("resolveSelectedProviders routes research by extraction and neural capabilities", () => {
  const availableProviders = [
    "brave",
    "firecrawl-free",
    "firecrawl",
    "parallel-free",
    "parallel",
    "tavily",
  ].map((id) => ({ id, label: id, configured: true }));

  const selected = resolveSelectedProviders({
    availableProviders,
    requestIntent: "research",
    config: {},
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["parallel", "tavily"]);
});

test("resolveSelectedProviders built-in keyword routing excludes answer providers", () => {
  const selected = resolveSelectedProviders({
    availableProviders: ["brave", "gemini", "perplexity", "tavily"].map((id) => ({
      id,
      label: id,
      configured: true,
    })),
    requestIntent: "keyword",
    config: {},
  });
  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "tavily"]);
});

test("resolveSelectedProviders local intent falls through without an explicit mapping", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "local",
    config: { defaultProviders: ["duckduckgo"] },
  });
  assert.deepEqual(selected.map((provider) => provider.id), ["duckduckgo"]);
});

test("provider configuration mirrors direct, scoped, fallback, auth, env, and keyless routes", () => {
  const config = {
    tools: { web: { search: { scoped: { apiKey: "scoped-key" } } } },
    models: { providers: { google: { apiKey: "google-model-key" } } },
  };
  const previous = process.env.SEARCH_FUSION_TEST_KEY;
  process.env.SEARCH_FUSION_TEST_KEY = "env-key";
  try {
    assert.deepEqual(
      resolveProviderConfiguration(
        { id: "direct", label: "Direct", getConfiguredCredentialValue: () => "direct-key" },
        config,
      ),
      { configured: true, credentialSource: "provider-config" },
    );
    assert.deepEqual(
      resolveProviderConfiguration(
        { id: "scoped", label: "Scoped", getCredentialValue: (search) => search?.scoped },
        config,
      ),
      { configured: true, credentialSource: "search-config" },
    );
    assert.deepEqual(
      resolveProviderConfiguration(
        {
          id: "gemini",
          label: "Gemini",
          getConfiguredCredentialFallback: (cfg: any) => ({
            path: "models.providers.google.apiKey",
            value: cfg?.models?.providers?.google?.apiKey,
          }),
        },
        config,
      ),
      {
        configured: true,
        credentialSource: "configured fallback (models.providers.google.apiKey)",
      },
    );
    assert.deepEqual(
      resolveProviderConfiguration(
        { id: "grok", label: "Grok", authProviderId: "xai" },
        config,
      ),
      { configured: true, credentialSource: "account-auth (unverified)" },
    );
    assert.deepEqual(
      resolveProviderConfiguration(
        { id: "env", label: "Env", envVars: ["SEARCH_FUSION_TEST_KEY"] },
        config,
      ),
      { configured: true, credentialSource: "environment (SEARCH_FUSION_TEST_KEY)" },
    );
    assert.deepEqual(
      resolveProviderConfiguration(
        { id: "free", label: "Free", requiresCredential: false },
        config,
      ),
      { configured: true, credentialSource: "keyless" },
    );
  } finally {
    if (previous === undefined) delete process.env.SEARCH_FUSION_TEST_KEY;
    else process.env.SEARCH_FUSION_TEST_KEY = previous;
  }
});

test("resolveSelectedProviders routes keyword intent to configured subset", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "keyword",
    config: {
      intentProviders: {
        keyword: ["brave", "duckduckgo"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "duckduckgo"]);
});

test("resolveSelectedProviders can route keyword intent to minimax when configured", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [
      {
        id: "minimax",
        label: "MiniMax",
        autoDetectOrder: 15,
        configured: true,
      },
      {
        id: "brave",
        label: "Brave",
        autoDetectOrder: 10,
        configured: true,
      },
    ],
    requestIntent: "keyword",
    config: {
      intentProviders: {
        keyword: ["minimax", "brave"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["minimax", "brave"]);
});

test("resolveSelectedProviders intent does not override explicit providers", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestProviders: ["gemini"],
    requestIntent: "keyword",
    config: {
      intentProviders: {
        keyword: ["brave", "duckduckgo"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["gemini"]);
});

test("resolveSelectedProviders intent does not override explicit mode", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestMode: "fast",
    requestIntent: "research",
    config: {
      modes: {
        fast: ["brave"],
      },
      intentProviders: {
        research: ["gemini", "tavily"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders falls through to defaultMode when intent has no entry", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "local",
    config: {
      intentProviders: {
        research: ["gemini"],
      },
      defaultMode: "fallback",
      modes: {
        fallback: ["brave"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["brave"]);
});

test("resolveSelectedProviders falls through to all configured when intent matches nothing in available providers", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "answer",
    config: {
      intentProviders: {
        answer: ["perplexity", "grok"],
      },
    },
  });

  // perplexity and grok are not in the discovered list, falls through
  assert.deepEqual(selected.map((provider) => provider.id), ["brave", "gemini", "duckduckgo"]);
});

test("resolveSelectedProviders normalizes intent casing", () => {
  const selected = resolveSelectedProviders({
    availableProviders: getDiscovered(),
    requestIntent: "RESEARCH",
    config: {
      intentProviders: {
        research: ["gemini"],
      },
    },
  });

  assert.deepEqual(selected.map((provider) => provider.id), ["gemini"]);
});
