import test from "node:test";
import assert from "node:assert/strict";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/config-runtime";
import plugin, {
  ALL_PROVIDER_CAPABILITIES,
  filterByAnyCapability,
  filterByCapabilities,
  hasCapability,
  KNOWN_PROVIDERS,
  resolveProviderCapabilities,
} from "../index.js";

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
};

type RegisteredProvider = {
  id: string;
  getCredentialValue: () => unknown;
  setCredentialValue: (target: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: () => unknown;
  createTool: (ctx?: Record<string, unknown>) => {
    execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<any>;
  };
};

function registerWith(options: {
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  providers?: Array<{ id: string; label: string; key?: string }>;
  search?: (params: { providerId?: string }) => Promise<{ provider: string; result: Record<string, unknown> }>;
  withProviderRegistration?: boolean;
}) {
  const tools: RegisteredTool[] = [];
  let provider: RegisteredProvider | undefined;
  const api: Record<string, unknown> = {
    config: options.config ?? {},
    pluginConfig: options.pluginConfig,
    runtime: {
      webSearch: {
        listProviders: () =>
          (options.providers ?? []).map((entry) => ({
            id: entry.id,
            label: entry.label,
            envVars: [],
            getConfiguredCredentialValue: () => entry.key,
            getCredentialValue: () => undefined,
          })),
        search:
          options.search ??
          (async ({ providerId }: { providerId?: string }) => ({
            provider: providerId ?? "x",
            result: { results: [{ title: `${providerId}`, url: `https://example.com/${providerId}` }] },
          })),
      },
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  if (options.withProviderRegistration !== false) {
    api.registerWebSearchProvider = (entry: RegisteredProvider) => {
      provider = entry;
    };
  }
  plugin.register(api as never);
  const tool = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    assert.ok(found, name);
    return found;
  };
  return { tools, tool, provider: () => provider };
}

test("the entry point re-exports the capability helpers and catalog", () => {
  assert.equal(ALL_PROVIDER_CAPABILITIES.length, 12);
  assert.ok(hasCapability(resolveProviderCapabilities("BRAVE"), "news"));
  assert.deepEqual(filterByCapabilities(["brave", "exa"], ["neural"]), ["exa"]);
  assert.deepEqual(filterByAnyCapability(["brave", "exa", "unknown"], ["news", "academic"]), ["brave", "exa"]);
  assert.equal(KNOWN_PROVIDERS.length, 16);
  assert.equal(plugin.id, "search-fusion");
});

test("tools still register when the host cannot register web search providers", () => {
  clearRuntimeConfigSnapshot();
  const { tools, provider } = registerWith({ withProviderRegistration: false });
  assert.deepEqual(tools.map((entry) => entry.name).sort(), ["search_fusion", "search_fusion_providers"]);
  assert.equal(provider(), undefined);
});

test("the registered web search provider is always enabled and has inert credential hooks", () => {
  clearRuntimeConfigSnapshot();
  const registered = registerWith({}).provider();
  assert.ok(registered);
  assert.equal(registered.getCredentialValue(), undefined);
  assert.equal(registered.getConfiguredCredentialValue?.(), "always-enabled");
  const target: Record<string, unknown> = {};
  registered.setCredentialValue(target, "ignored");
  assert.deepEqual(target, {});
});

test("the provider tool works without a tool context", async () => {
  clearRuntimeConfigSnapshot();
  const registered = registerWith({ providers: [{ id: "brave", label: "Brave", key: "k" }] }).provider();
  const result = await registered?.createTool().execute({ query: "no ctx", providers: ["brave"] });
  assert.match(result?.content ?? "", /"providersSucceeded": \[\n\s+"brave"\n\s+\]/);
  assert.deepEqual(result?.externalContent, {
    untrusted: true,
    source: "web_search",
    provider: "search-fusion",
    aggregated: true,
  });
});

test("search_fusion includes failures in its summary only when asked", async () => {
  clearRuntimeConfigSnapshot();
  const { tool } = registerWith({
    providers: [
      { id: "brave", label: "Brave", key: "k" },
      { id: "tavily", label: "Tavily", key: "k" },
    ],
    pluginConfig: { retry: { maxAttempts: 1 } },
    search: async ({ providerId }) => {
      if (providerId === "tavily") throw new Error("HTTP 500 upstream");
      return { provider: "brave", result: { results: [{ title: "ok", url: "https://example.com/ok" }] } };
    },
  });
  const quiet = await tool("search_fusion").execute("1", { query: "q" });
  assert.doesNotMatch(quiet.details.summary, /HTTP 500/);
  const loud = await tool("search_fusion").execute("2", { query: "q", includeFailures: true });
  assert.match(loud.details.summary, /Failures:\n- tavily: HTTP 500 upstream/);
  assert.deepEqual(loud.details.payload.providersFailed, [{ provider: "tavily", error: "HTTP 500 upstream" }]);
});

test("search_fusion_providers can list only configured providers", async () => {
  clearRuntimeConfigSnapshot();
  const { tool } = registerWith({
    providers: [
      { id: "brave", label: "Brave", key: "k" },
      { id: "tavily", label: "Tavily" },
    ],
  });
  const all = await tool("search_fusion_providers").execute("1", {});
  assert.deepEqual(all.details.providers.map((entry: { id: string }) => entry.id), ["brave", "tavily"]);
  assert.match(all.details.summary, /- tavily: Tavily \[not configured\]/);
  assert.match(all.details.summary, /- brave: Brave \[configured\] \[credential: provider-config\] \[news, privacy, results\]/);
  const onlyConfigured = await tool("search_fusion_providers").execute("2", { onlyConfigured: true });
  assert.deepEqual(onlyConfigured.details.providers.map((entry: { id: string }) => entry.id), ["brave"]);
  // The text result is plain JSON, not wrapped as external content.
  assert.equal(JSON.parse(onlyConfigured.content[0].text).providers.length, 1);
});

test("search_fusion_providers reports when nothing is discovered", async () => {
  clearRuntimeConfigSnapshot();
  const { tool } = registerWith({ providers: [] });
  const result = await tool("search_fusion_providers").execute("1", {});
  assert.match(result.details.summary, /^No enabled web search providers discovered\./);
  assert.match(result.details.summary, /Catalog providers with plugin disabled\/not enabled:\n- brave: plugin brave/);
  assert.equal(result.details.missing.length, 16);
});

test("search_fusion_providers rejects already-aborted signals with the abort reason", async () => {
  clearRuntimeConfigSnapshot();
  const { tool } = registerWith({});
  const reasonError = new Error("caller gave up");
  const withError = new AbortController();
  withError.abort(reasonError);
  await assert.rejects(tool("search_fusion_providers").execute("1", {}, withError.signal), (error) => error === reasonError);

  const withString = new AbortController();
  withString.abort("stop now");
  await assert.rejects(
    tool("search_fusion_providers").execute("2", {}, withString.signal),
    (error: Error) => error.name === "AbortError" && error.message === "stop now",
  );

  const withObject = new AbortController();
  withObject.abort({ why: "object reason" });
  await assert.rejects(
    tool("search_fusion_providers").execute("3", {}, withObject.signal),
    (error: Error) => error.name === "AbortError" && error.message === "Search aborted",
  );
});
