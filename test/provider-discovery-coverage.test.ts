import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverProviders,
  isProviderConfigured,
  resolveProviderConfiguration,
  resolveSelectedProviders,
} from "../src/provider-discovery.js";
import type { ResolvedProvider, RuntimeWebSearchProvider } from "../src/types.js";

const ENV_KEY = "SEARCH_FUSION_DISCOVERY_COVERAGE_KEY";

function withEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

function provider(id: string, configured = true, extra: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return { id, label: id, configured, ...extra };
}

test("credential values count only when they carry real content", () => {
  const cases: Array<[unknown, boolean]> = [
    ["key", true],
    ["   ", false],
    [0, true],
    [false, true],
    [["a"], true],
    [[], false],
    [{ nested: true }, true],
    [{}, false],
    [null, false],
    [undefined, false],
    [Symbol("x"), false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(
      isProviderConfigured({ id: "p", label: "p", getConfiguredCredentialValue: () => value }, {}),
      expected,
      String(typeof value === "symbol" ? "symbol" : JSON.stringify(value)),
    );
  }
});

test("env SecretRefs count as configured only when the variable is set", () => {
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const entry: RuntimeWebSearchProvider = { id: "p", label: "p", getConfiguredCredentialValue: () => ref };
  assert.equal(withEnv(undefined, () => isProviderConfigured(entry, {})), false);
  assert.equal(withEnv("  ", () => isProviderConfigured(entry, {})), false);
  assert.equal(withEnv("value", () => isProviderConfigured(entry, {})), true);
  // File and exec refs cannot be checked from the plugin, so presence is enough.
  assert.equal(
    isProviderConfigured({ id: "p", label: "p", getConfiguredCredentialValue: () => ({ source: "file", id: "/x" }) }, {}),
    true,
  );
});

test("throwing credential accessors fall through to the next configuration route", () => {
  const throwing = () => {
    throw new Error("accessor exploded");
  };
  assert.deepEqual(
    withEnv("set", () =>
      resolveProviderConfiguration(
        {
          id: "p",
          label: "p",
          envVars: [ENV_KEY],
          getConfiguredCredentialValue: throwing,
          getCredentialValue: throwing,
          getConfiguredCredentialFallback: throwing,
        },
        {},
      ),
    ),
    { configured: true, credentialSource: `environment (${ENV_KEY})` },
  );
  assert.deepEqual(
    resolveProviderConfiguration(
      {
        id: "p",
        label: "p",
        getConfiguredCredentialValue: throwing,
        getCredentialValue: throwing,
        getConfiguredCredentialFallback: throwing,
      },
      {},
    ),
    { configured: false },
  );
});

test("scoped search credentials and pathless fallbacks are reported", () => {
  const config = { tools: { web: { search: { p: { apiKey: "scoped" } } } } };
  assert.deepEqual(
    resolveProviderConfiguration(
      { id: "p", label: "p", getCredentialValue: (searchConfig) => (searchConfig as any)?.p?.apiKey },
      config,
    ),
    { configured: true, credentialSource: "search-config" },
  );
  // A non-object search config is not passed to the accessor.
  let received: unknown = "unset";
  resolveProviderConfiguration(
    { id: "p", label: "p", getCredentialValue: (searchConfig) => {
      received = searchConfig;
      return undefined;
    } },
    { tools: { web: { search: ["not", "a", "record"] } } },
  );
  assert.equal(received, undefined);
  assert.deepEqual(
    resolveProviderConfiguration(
      { id: "p", label: "p", getConfiguredCredentialFallback: () => ({ path: "", value: "fallback" }) },
      {},
    ),
    { configured: true, credentialSource: "configured fallback" },
  );
  assert.deepEqual(
    resolveProviderConfiguration(
      { id: "p", label: "p", getConfiguredCredentialFallback: () => undefined },
      {},
    ),
    { configured: false },
  );
});

test("discoverProviders consults the fallback config only when the primary has no credential", () => {
  const entry: RuntimeWebSearchProvider = {
    id: "p",
    label: "P",
    getConfiguredCredentialValue: (cfg) => (cfg as any)?.key,
  };
  const [fromFallback] = discoverProviders({
    providers: [entry],
    config: {},
    fallbackConfig: { key: "fallback" },
    catalogConfig: {},
    selfId: "search-fusion",
  });
  assert.equal(fromFallback?.configured, true);
  assert.equal(fromFallback?.credentialSource, "provider-config");

  const [noFallback] = discoverProviders({ providers: [entry], config: {}, catalogConfig: {}, selfId: "search-fusion" });
  assert.equal(noFallback?.configured, false);
});

test("discoverProviders orders by autoDetectOrder, then id, with unordered entries last", () => {
  const ids = discoverProviders({
    providers: [
      { id: "zeta", label: "Z" },
      { id: "beta", label: "B", autoDetectOrder: 5 },
      { id: "alpha", label: "A" },
      { id: "gamma", label: "G", autoDetectOrder: 1 },
      { id: "search-fusion", label: "Self", autoDetectOrder: 0 },
    ],
    config: {},
    catalogConfig: {},
    env: {},
    selfId: "search-fusion",
  }).map((entry) => entry.id);
  assert.deepEqual(ids, ["gamma", "beta", "alpha", "zeta"]);
});

test("catalog stubs explain how to configure them and report Codex account auth", () => {
  const providers = discoverProviders({
    providers: [],
    config: { plugins: { entries: { codex: { enabled: true }, brave: {} } } },
    env: {},
    selfId: "search-fusion",
  });
  const brave = providers.find((entry) => entry.id === "brave");
  assert.equal(brave?.configured, false);
  assert.equal(brave?.hint, "Configure plugins.entries.brave.config.webSearch.apiKey or BRAVE_API_KEY.");
  const codex = providers.find((entry) => entry.id === "codex");
  assert.deepEqual([codex?.configured, codex?.credentialSource], [true, "account-auth"]);
});

test("catalog stubs read declared keys from the fallback config and env vars", () => {
  const [fromFallback] = discoverProviders({
    providers: [],
    config: { plugins: { entries: { tavily: {} } } },
    fallbackConfig: { plugins: { entries: { tavily: { config: { webSearch: { apiKey: { source: "exec", id: "x" } } } } } } },
    env: {},
    selfId: "search-fusion",
  });
  assert.deepEqual([fromFallback?.id, fromFallback?.credentialSource], ["tavily", "plugin-config (declared)"]);

  const [fromEnv] = discoverProviders({
    providers: [],
    config: { plugins: { entries: { moonshot: { config: { webSearch: { apiKey: "  " } } } } } },
    env: { MOONSHOT_API_KEY: "set" },
    selfId: "search-fusion",
  });
  assert.deepEqual([fromEnv?.id, fromEnv?.credentialSource], ["kimi", "environment (MOONSHOT_API_KEY)"]);
});

test("an explicit mode that names only unavailable providers is an error", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: [provider("brave")],
        requestMode: "ghost",
        config: { modes: { ghost: ["not-installed"] } },
      }),
    /Search Fusion mode "ghost" resolved to no available providers\./,
  );
});

test("blank mode names and blank provider ids are ignored", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [provider("brave"), provider("tavily")],
    requestMode: " FAST ",
    requestProviders: ["  ", ""],
    config: { modes: { "  ": ["tavily"], fast: [" Brave ", "brave", ""] } },
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["brave"]);
});

test("configured intents that resolve to nothing fall through to defaultProviders", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [provider("brave"), provider("tavily"), provider("exa")],
    requestIntent: "news",
    config: {
      intentProviders: { news: ["not-installed"], answer: [] },
      defaultMode: "missing-mode",
      defaultProviders: ["tavily", "exa"],
    },
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["tavily", "exa"]);

  const emptyList = resolveSelectedProviders({
    availableProviders: [provider("brave"), provider("tavily")],
    requestIntent: "answer",
    config: { intentProviders: { answer: [] } },
  });
  assert.deepEqual(emptyList.map((entry) => entry.id), ["brave", "tavily"]);
});

test("unknown intent strings are ignored rather than rejected", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [provider("brave"), provider("gemini")],
    requestIntent: "shopping",
    config: {},
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["brave", "gemini"]);
});

test("built-in intents use available providers when nothing is configured", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [provider("brave", false), provider("gemini", false)],
    requestIntent: "news",
    config: {},
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["brave"]);
});

test("starter modes are omitted when there are no providers at all", () => {
  assert.throws(
    () => resolveSelectedProviders({ availableProviders: [], requestMode: "fast", config: {} }),
    /Unknown Search Fusion mode: fast/,
  );
  assert.deepEqual(resolveSelectedProviders({ availableProviders: [], config: {} }), []);
});

test("explicit all falls back to every available provider when none are configured", () => {
  const selected = resolveSelectedProviders({
    availableProviders: [provider("brave", false), provider("tavily", false)],
    requestProviders: ["*"],
    config: { excludeProviders: ["tavily"] },
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["brave", "tavily"]);
});

test("unknown explicit ids are reported together with plural wording", () => {
  assert.throws(
    () =>
      resolveSelectedProviders({
        availableProviders: [provider("tavily"), provider("brave")],
        requestProviders: ["nope", "Brave", "ghost"],
        config: {},
      }),
    /^Error: Unknown Search Fusion providers: nope, ghost\. Valid provider ids: brave, tavily\.$/,
  );
});
