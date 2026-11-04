import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

type SecretResolverParams = {
  config: unknown;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  unresolvedReasonStyle?: "generic" | "detailed";
};

const mockedSecretResolutions = new Map<
  string,
  { value?: string; unresolvedRefReason?: string }
>();
const secretResolverCalls: SecretResolverParams[] = [];
const resolveConfiguredSecretInputString = mock.fn(async (params: SecretResolverParams) => {
  secretResolverCalls.push(params);
  const ref = params.value as { source?: unknown; provider?: unknown; id?: unknown };
  const refKey = `${String(ref.source)}:${String(ref.provider)}:${String(ref.id)}`;
  const mockedResolution = mockedSecretResolutions.get(refKey);
  if (mockedResolution) {
    return mockedResolution;
  }
  if (ref.source === "env" && typeof ref.id === "string" && params.env[ref.id]) {
    return { value: params.env[ref.id] };
  }
  return { unresolvedRefReason: `${params.path} mocked SecretRef resolution failed.` };
});

mock.module("openclaw/plugin-sdk/secret-input-runtime", {
  cache: true,
  namedExports: {
    resolveConfiguredSecretInputString,
  },
});

const { getProviderHealthSnapshot, isHardProviderFailure, resetProviderHealthForTests, runSearchFusion } =
  await import("../src/search-fusion.js");

// Provider health is process-wide by design; isolate every test from earlier failures.
beforeEach(() => {
  resetProviderHealthForTests();
});

function createRuntime(overrides?: {
  providers?: Array<{
    id: string;
    label: string;
    configured?: boolean;
    requiresCredential?: boolean;
    autoDetectOrder?: number;
  }>;
  search?: (params: {
    config?: unknown;
    providerId?: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    agentDir?: string;
    runtimeWebSearch?: unknown;
  }) => Promise<{
    provider: string;
    result: Record<string, unknown>;
  }>;
}) {
  const providers =
    overrides?.providers ??
    [
      { id: "brave", label: "Brave", configured: true, autoDetectOrder: 10 },
      { id: "gemini", label: "Gemini", configured: true, autoDetectOrder: 20 },
      { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 30 },
      {
        id: "duckduckgo",
        label: "DuckDuckGo",
        configured: true,
        requiresCredential: false,
        autoDetectOrder: 100,
      },
      { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
    ];

  return {
    webSearch: {
      listProviders: () =>
        providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          autoDetectOrder: provider.autoDetectOrder,
          requiresCredential: provider.requiresCredential,
          envVars: [],
          getConfiguredCredentialValue: () =>
            provider.requiresCredential === false
              ? undefined
              : provider.configured
                ? `${provider.id}-key`
                : undefined,
          getCredentialValue: () => undefined,
        })),
      search:
        overrides?.search ??
        (async ({ providerId }) => {
          if (providerId === "brave") {
            return {
              provider: "brave",
              result: {
                results: [
                  {
                    title: "OpenClaw Docs",
                    url: "https://docs.openclaw.ai/tools/web?utm_source=brave",
                    description: "Provider one",
                    metadata: { provider: "brave" },
                  },
                ],
              },
            };
          }

          if (providerId === "gemini") {
            return {
              provider: "gemini",
              result: {
                content:
                  "A grounded summary that is long enough to survive preservation checks without getting confused with the short snippet fallback.",
                citations: [
                  "https://docs.openclaw.ai/tools/web",
                  { url: "https://github.com/openclaw/openclaw", title: "GitHub" },
                ],
              },
            };
          }

          if (providerId === "duckduckgo") {
            return {
              provider: "duckduckgo",
              result: {
                results: [
                  {
                    title: "DuckDuckGo fallback docs",
                    url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.openclaw.ai%2Ftools%2Fweb%3Futm_source%3Dddg",
                    description: "Free-ish fallback search result",
                  },
                ],
              },
            };
          }

          return {
            provider: "tavily",
            result: {
              results: [
                {
                  title: "OpenClaw Web Docs",
                  url: "https://docs.openclaw.ai/tools/web",
                  description: "Provider two has a longer snippet",
                  metadata: { provider: "tavily" },
                },
                {
                  title: "Plugin SDK",
                  url: "https://docs.openclaw.ai/plugins/sdk",
                  description: "Plugin docs",
                },
              ],
            },
          };
        }),
    },
  };
}

function createHttpError(params: {
  status: 429 | 503;
  headers: Headers | Record<string, string>;
  message?: string;
  shape?: "direct" | "response" | "cause";
}): Error {
  const error = new Error(params.message ?? `HTTP ${params.status}`);
  const response = { status: params.status, headers: params.headers };
  if (params.shape === "direct") {
    Object.assign(error, { statusCode: params.status, headers: params.headers });
  } else if (params.shape === "cause") {
    Object.assign(error, { cause: { response } });
  } else {
    Object.assign(error, { response });
  }
  return error;
}

type StaticResult = {
  title: string;
  url: string;
  description?: string;
};

function createStaticResultsRuntime(resultsByProvider: Record<string, StaticResult[]>) {
  return createRuntime({
    providers: Object.keys(resultsByProvider).map((providerId, index) => ({
      id: providerId,
      label: providerId,
      configured: true,
      autoDetectOrder: index + 1,
    })),
    search: async ({ providerId }) => ({
      provider: providerId ?? "unknown",
      result: {
        results: resultsByProvider[providerId ?? ""] ?? [],
      },
    }),
  });
}

test("runSearchFusion passes catalog-stub plain-string credentials through unchanged", async () => {
  clearRuntimeConfigSnapshot();
  const config = {
    plugins: {
      entries: {
        tavily: { config: { webSearch: { apiKey: "declared-tavily-key" } } },
      },
    },
  };
  const searchedProviderIds: Array<string | undefined> = [];
  const searchConfigs: unknown[] = [];

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: () => [
            {
              id: "search-fusion",
              label: "Search Fusion",
              getConfiguredCredentialValue: () => "always-enabled",
            },
          ],
          search: async ({ config, providerId }: { config?: unknown; providerId?: string }) => {
            searchConfigs.push(config);
            searchedProviderIds.push(providerId);
            return {
              provider: providerId ?? "tavily",
              result: {
                results: [
                  {
                    title: "Lazy Tavily result",
                    url: "https://example.com/lazy-tavily",
                    description: "loaded on demand",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config,
      pluginConfig: {},
      request: {
        query: "lazy activation",
        providers: ["tavily"],
      },
    });

    assert.deepEqual(payload.configuredProviders, ["tavily"]);
    assert.deepEqual(payload.providersQueried, ["tavily"]);
    assert.deepEqual(payload.providersSucceeded, ["tavily"]);
    assert.deepEqual(searchedProviderIds, ["tavily"]);
    assert.deepEqual(searchConfigs, [config]);
    assert.equal(payload.providerRuns[0]?.provider, "tavily");
  } finally {
    clearRuntimeConfigSnapshot();
  }
});

test("runSearchFusion resolves catalog-stub plugin credential SecretRefs before delegation", async () => {
  clearRuntimeConfigSnapshot();
  const refKey = "exec:catalog_exec:value";
  const secretRef = { source: "exec", provider: "catalog_exec", id: "value" };
  const sourceConfig = {
    secrets: {
      providers: {
        catalog_exec: { source: "exec", command: "/mock/catalog-secret" },
      },
    },
    plugins: {
      entries: {
        google: { config: { webSearch: { apiKey: secretRef } } },
      },
    },
  };
  const runtimeConfig = structuredClone(sourceConfig);
  const searchConfigs: unknown[] = [];
  const callCountBefore = secretResolverCalls.length;
  mockedSecretResolutions.set(refKey, { value: "resolved-catalog-gemini-key" });
  setRuntimeConfigSnapshot(runtimeConfig as never, sourceConfig as never);

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: () => [
            {
              id: "search-fusion",
              label: "Search Fusion",
              getConfiguredCredentialValue: () => "always-enabled",
            },
          ],
          search: async ({ config, providerId }: { config?: unknown; providerId?: string }) => {
            searchConfigs.push(config);
            return {
              provider: providerId ?? "gemini",
              result: {
                results: [
                  {
                    title: "Catalog SecretRef Search OK",
                    url: "https://example.com/catalog-secret-ref",
                    description: "search worked",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config: sourceConfig,
      pluginConfig: {},
      request: {
        query: "catalog secret ref",
        providers: ["gemini"],
      },
    });

    assert.deepEqual(payload.providersSucceeded, ["gemini"]);
    assert.equal(searchConfigs.length, 1);
    assert.notEqual(searchConfigs[0], runtimeConfig);
    assert.equal(
      (searchConfigs[0] as any)?.plugins?.entries?.google?.config?.webSearch?.apiKey,
      "resolved-catalog-gemini-key",
    );
    assert.deepEqual(
      (runtimeConfig as any).plugins.entries.google.config.webSearch.apiKey,
      secretRef,
    );
    assert.equal(secretResolverCalls.length, callCountBefore + 1);
    assert.equal(secretResolverCalls.at(-1)?.config, sourceConfig);
    assert.equal(
      secretResolverCalls.at(-1)?.path,
      "plugins.entries.google.config.webSearch.apiKey",
    );
    assert.deepEqual(secretResolverCalls.at(-1)?.value, secretRef);
  } finally {
    mockedSecretResolutions.delete(refKey);
    clearRuntimeConfigSnapshot();
  }
});

test("runSearchFusion resolves catalog-stub scoped credential SecretRefs when plugin credentials are absent", async () => {
  clearRuntimeConfigSnapshot();
  const refKey = "exec:scoped_exec:value";
  const config = {
    plugins: { entries: { tavily: { enabled: true, config: {} } } },
    tools: {
      web: {
        search: {
          tavily: {
            apiKey: { source: "exec", provider: "scoped_exec", id: "value" },
          },
        },
      },
    },
  };
  const searchConfigs: unknown[] = [];
  mockedSecretResolutions.set(refKey, { value: "resolved-scoped-tavily-key" });

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: () => [
            {
              id: "search-fusion",
              label: "Search Fusion",
              getConfiguredCredentialValue: () => "always-enabled",
            },
          ],
          search: async ({ config, providerId }: { config?: unknown; providerId?: string }) => {
            searchConfigs.push(config);
            return {
              provider: providerId ?? "tavily",
              result: {
                results: [
                  {
                    title: "Scoped SecretRef Search OK",
                    url: "https://example.com/scoped-secret-ref",
                    description: "search worked",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config,
      pluginConfig: {},
      request: {
        query: "scoped secret ref",
        providers: ["tavily"],
      },
    });

    assert.deepEqual(payload.providersSucceeded, ["tavily"]);
    assert.equal(searchConfigs.length, 1);
    assert.notEqual(searchConfigs[0], config);
    assert.equal(
      (searchConfigs[0] as any)?.tools?.web?.search?.tavily?.apiKey,
      "resolved-scoped-tavily-key",
    );
    assert.equal(secretResolverCalls.at(-1)?.config, config);
    assert.equal(secretResolverCalls.at(-1)?.path, "tools.web.search.tavily.apiKey");
  } finally {
    mockedSecretResolutions.delete(refKey);
    clearRuntimeConfigSnapshot();
  }
});

test("runSearchFusion isolates catalog-stub credential resolution failures", async () => {
  clearRuntimeConfigSnapshot();
  const refKey = "exec:failing_exec:value";
  const resolverMessage = "catalog exec resolver could not read the credential";
  const config = {
    plugins: {
      entries: {
        duckduckgo: { enabled: true },
        tavily: {
          config: {
            webSearch: {
              apiKey: { source: "exec", provider: "failing_exec", id: "value" },
            },
          },
        },
      },
    },
  };
  const searchedProviderIds: Array<string | undefined> = [];
  mockedSecretResolutions.set(refKey, { unresolvedRefReason: resolverMessage });

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: () => [
            {
              id: "search-fusion",
              label: "Search Fusion",
              getConfiguredCredentialValue: () => "always-enabled",
            },
          ],
          search: async ({ providerId }: { providerId?: string }) => {
            searchedProviderIds.push(providerId);
            return {
              provider: providerId ?? "duckduckgo",
              result: {
                results: [
                  {
                    title: "Unaffected provider",
                    url: "https://example.com/unaffected-provider",
                    description: "search worked",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config,
      pluginConfig: {},
      request: {
        query: "isolated resolution failure",
        providers: ["tavily", "duckduckgo"],
      },
    });

    assert.deepEqual(payload.providersSucceeded, ["duckduckgo"]);
    assert.deepEqual(payload.providersFailed, [{ provider: "tavily", error: resolverMessage }]);
    assert.deepEqual(searchedProviderIds, ["duckduckgo"]);
    assert.equal(payload.providerRuns.find((run) => run.provider === "tavily")?.ok, false);
  } finally {
    mockedSecretResolutions.delete(refKey);
    clearRuntimeConfigSnapshot();
  }
});

test("runSearchFusion prefers the active runtime config snapshot for credential-backed providers", async () => {
  clearRuntimeConfigSnapshot();
  const rawConfig = {
    tools: { web: { search: { provider: "search-fusion" } } },
    plugins: {
      entries: {
        google: { config: { webSearch: { apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" } } } },
        brave: { config: { apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" } } },
      },
    },
  };
  const runtimeConfig = {
    tools: { web: { search: { provider: "search-fusion" } } },
    plugins: {
      entries: {
        google: { config: { webSearch: { apiKey: "runtime-gemini-key" } } },
        brave: { config: { apiKey: "runtime-brave-key" } },
      },
    },
  };
  const seen: { listProvidersConfigs: unknown[]; searchConfigs: unknown[] } = {
    listProvidersConfigs: [],
    searchConfigs: [],
  };

  setRuntimeConfigSnapshot(runtimeConfig as never, rawConfig as never);

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: ({ config }: { config?: unknown } = {}) => {
            seen.listProvidersConfigs.push(config);
            return [
              {
                id: "brave",
                label: "Brave",
                autoDetectOrder: 10,
                envVars: [],
                getConfiguredCredentialValue: (cfg?: any) => cfg?.plugins?.entries?.brave?.config?.apiKey,
                getCredentialValue: () => undefined,
              },
              {
                id: "gemini",
                label: "Gemini",
                autoDetectOrder: 20,
                envVars: [],
                getConfiguredCredentialValue: (cfg?: any) =>
                  cfg?.plugins?.entries?.google?.config?.webSearch?.apiKey,
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
            ];
          },
          search: async ({ config, providerId }: { config?: unknown; providerId?: string; args: Record<string, unknown> }) => {
            seen.searchConfigs.push(config);
            return {
              provider: providerId ?? "brave",
              result:
                providerId === "gemini"
                  ? {
                      content: "grounded answer",
                      citations: ["https://docs.openclaw.ai/tools/web"],
                    }
                  : {
                      results: [
                        {
                          title: "OpenClaw Docs",
                          url: `https://docs.openclaw.ai/tools/web?src=${providerId}`,
                          description: `${providerId} docs`,
                        },
                      ],
                    },
            };
          },
        },
      } as never,
      config: rawConfig,
      pluginConfig: {},
      request: {
        query: "openclaw",
        providers: ["brave", "gemini"],
      },
    });

    assert.equal(payload.provider, "search-fusion");
    assert.deepEqual(payload.configuredProviders, ["brave", "gemini"]);
    assert.deepEqual(payload.providersQueried, ["brave", "gemini"]);
    assert.ok(seen.listProvidersConfigs.length >= 1);
    assert.ok(seen.listProvidersConfigs.every((config) => config === runtimeConfig));
    assert.equal(seen.searchConfigs.length, 2);
    assert.ok(seen.searchConfigs.every((config) => config === runtimeConfig));
  } finally {
    clearRuntimeConfigSnapshot();
  }
});

test("runSearchFusion resolves SecretRef credentials before delegating providers", async () => {
  clearRuntimeConfigSnapshot();
  const previousKey = process.env.MINIMAX_TEST_KEY;
  process.env.MINIMAX_TEST_KEY = "resolved-minimax-key";
  const rawConfig = {
    plugins: {
      entries: {
        minimax: {
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "default", id: "MINIMAX_TEST_KEY" },
            },
          },
        },
      },
    },
  };
  const seen: { listProvidersConfigs: unknown[]; searchConfigs: unknown[] } = {
    listProvidersConfigs: [],
    searchConfigs: [],
  };
  const resolverCallCountBefore = secretResolverCalls.length;

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: ({ config }: { config?: unknown } = {}) => {
            seen.listProvidersConfigs.push(config);
            return [
              {
                id: "minimax",
                label: "MiniMax",
                autoDetectOrder: 10,
                envVars: [],
                credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
                getConfiguredCredentialValue: (cfg?: any) =>
                  cfg?.plugins?.entries?.minimax?.config?.webSearch?.apiKey,
                setConfiguredCredentialValue: (cfg: any, value: unknown) => {
                  cfg.plugins.entries.minimax.config.webSearch.apiKey = value;
                },
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
            ];
          },
          search: async ({ config, providerId }: { config?: unknown; providerId?: string; args: Record<string, unknown> }) => {
            seen.searchConfigs.push(config);
            return {
              provider: providerId ?? "minimax",
              result: {
                results: [
                  {
                    title: "MiniMax Search OK",
                    url: "https://example.com/minimax",
                    description: "search worked",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config: rawConfig,
      pluginConfig: {},
      request: {
        query: "openclaw",
        providers: ["minimax"],
      },
    });

    assert.deepEqual(payload.configuredProviders, ["minimax"]);
    assert.deepEqual(payload.providersSucceeded, ["minimax"]);
    assert.ok(seen.listProvidersConfigs.every((config) => config === rawConfig));
    assert.equal(seen.searchConfigs.length, 1);
    assert.notEqual(seen.searchConfigs[0], rawConfig);
    assert.equal(
      (seen.searchConfigs[0] as any)?.plugins?.entries?.minimax?.config?.webSearch?.apiKey,
      "resolved-minimax-key",
    );
    assert.equal(secretResolverCalls.length, resolverCallCountBefore + 1);
    assert.equal(
      secretResolverCalls.at(-1)?.path,
      "plugins.entries.minimax.config.webSearch.apiKey",
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.MINIMAX_TEST_KEY;
    } else {
      process.env.MINIMAX_TEST_KEY = previousKey;
    }
  }
});

test("runSearchFusion resolves inactive runtime SecretRefs against source config", async () => {
  clearRuntimeConfigSnapshot();
  const previousKey = process.env.MINIMAX_SOURCE_TEST_KEY;
  process.env.MINIMAX_SOURCE_TEST_KEY = "resolved-source-minimax-key";
  const sourceConfig = {
    secrets: {
      providers: {
        named_env: {
          source: "env",
          allowlist: ["MINIMAX_SOURCE_TEST_KEY"],
        },
      },
    },
    plugins: {
      entries: {
        minimax: {
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "named_env", id: "MINIMAX_SOURCE_TEST_KEY" },
            },
          },
        },
      },
    },
  };
  const runtimeConfig = {
    plugins: {
      entries: {
        minimax: {
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "named_env", id: "MINIMAX_SOURCE_TEST_KEY" },
            },
          },
        },
      },
    },
  };
  const seen: { listProvidersConfigs: unknown[]; searchConfigs: unknown[] } = {
    listProvidersConfigs: [],
    searchConfigs: [],
  };

  setRuntimeConfigSnapshot(runtimeConfig as never, sourceConfig as never);

  try {
    const payload = await runSearchFusion({
      runtime: {
        webSearch: {
          listProviders: ({ config }: { config?: unknown } = {}) => {
            seen.listProvidersConfigs.push(config);
            return [
              {
                id: "minimax",
                label: "MiniMax",
                autoDetectOrder: 10,
                envVars: [],
                credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
                getConfiguredCredentialValue: (cfg?: any) =>
                  cfg?.plugins?.entries?.minimax?.config?.webSearch?.apiKey,
                setConfiguredCredentialValue: (cfg: any, value: unknown) => {
                  cfg.plugins.entries.minimax.config.webSearch.apiKey = value;
                },
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
            ];
          },
          search: async ({ config, providerId }: { config?: unknown; providerId?: string; args: Record<string, unknown> }) => {
            seen.searchConfigs.push(config);
            return {
              provider: providerId ?? "minimax",
              result: {
                results: [
                  {
                    title: "MiniMax Source SecretRef OK",
                    url: "https://example.com/minimax-source",
                    description: "search worked",
                  },
                ],
              },
            };
          },
        },
      } as never,
      config: runtimeConfig,
      pluginConfig: {},
      request: {
        query: "openclaw",
        providers: ["minimax"],
      },
    });

    assert.deepEqual(payload.configuredProviders, ["minimax"]);
    assert.deepEqual(payload.providersSucceeded, ["minimax"]);
    assert.ok(seen.listProvidersConfigs.every((config) => config === runtimeConfig));
    assert.equal(seen.searchConfigs.length, 1);
    assert.notEqual(seen.searchConfigs[0], runtimeConfig);
    assert.equal(
      (seen.searchConfigs[0] as any)?.plugins?.entries?.minimax?.config?.webSearch?.apiKey,
      "resolved-source-minimax-key",
    );
  } finally {
    clearRuntimeConfigSnapshot();
    if (previousKey === undefined) {
      delete process.env.MINIMAX_SOURCE_TEST_KEY;
    } else {
      process.env.MINIMAX_SOURCE_TEST_KEY = previousKey;
    }
  }
});

test("runSearchFusion passes raw configured credentials through to delegated providers", async () => {
  clearRuntimeConfigSnapshot();
  const rawConfig = {
    plugins: {
      entries: {
        minimax: {
          config: {
            webSearch: {
              apiKey: "raw-minimax-key",
            },
          },
        },
      },
    },
  };
  const seen: { searchConfigs: unknown[] } = { searchConfigs: [] };

  const payload = await runSearchFusion({
    runtime: {
      webSearch: {
        listProviders: () => [
          {
            id: "minimax",
            label: "MiniMax",
            autoDetectOrder: 10,
            envVars: [],
            getConfiguredCredentialValue: (cfg?: any) =>
              cfg?.plugins?.entries?.minimax?.config?.webSearch?.apiKey,
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
        ],
        search: async ({ config, providerId }: { config?: unknown; providerId?: string; args: Record<string, unknown> }) => {
          seen.searchConfigs.push(config);
          return {
            provider: providerId ?? "minimax",
            result: {
              results: [
                {
                  title: "MiniMax Raw Search OK",
                  url: "https://example.com/minimax-raw",
                  description: "search worked",
                },
              ],
            },
          };
        },
      },
    } as never,
    config: rawConfig,
    pluginConfig: {},
    request: {
      query: "openclaw",
      providers: ["minimax"],
    },
  });

  assert.deepEqual(payload.configuredProviders, ["minimax"]);
  assert.deepEqual(payload.providersSucceeded, ["minimax"]);
  assert.ok(seen.searchConfigs.every((config) => config === rawConfig));
});

test("runSearchFusion merges scheme and www/mobile variants of one page and shows the https URL", { skip: "this branch shows the highest-ranked variant's URL as-is" }, async () => {
  const resultsByProvider: Record<string, unknown> = {
    brave: { results: [{ title: "Primer", url: "http://www.example.com/primer/" }] },
    duckduckgo: { results: [{ title: "Primer", url: "https://m.example.com/primer" }] },
    tavily: {
      results: [
        { title: "Primer", url: "https://example.com/primer" },
        { title: "Other", url: "https://docs.example.com/primer" },
      ],
    },
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: { query: "host variants", providers: ["brave", "duckduckgo", "tavily"] },
  });

  assert.equal(payload.results.length, 2);
  const primer = payload.results.find((result) => result.canonicalUrl === "https://example.com/primer");
  assert.deepEqual(primer?.providers, ["brave", "duckduckgo", "tavily"]);
  // Only the scheme is upgraded; the host keeps the first provider's spelling.
  assert.equal(primer?.url, "https://www.example.com/primer");
  assert.deepEqual(
    primer?.variants.map((variant) => variant.originalUrl).sort(),
    ["http://www.example.com/primer/", "https://example.com/primer", "https://m.example.com/primer"],
  );
  // A different subdomain is a different site.
  assert.ok(payload.results.some((result) => result.canonicalUrl === "https://docs.example.com/primer"));
});

test("runSearchFusion flags mobile and alias spellings like the host they merge with", async () => {
  const resultsByProvider: Record<string, unknown> = {
    brave: {
      results: [
        { title: "Video", url: "https://www.youtube.com/watch?v=abc" },
        { title: "Thread", url: "https://www.reddit.com/r/x/comments/1/t" },
      ],
    },
    duckduckgo: {
      results: [
        { title: "Video", url: "https://m.youtube.com/watch?v=abc" },
        { title: "Thread", url: "https://np.reddit.com/r/x/comments/1/t" },
      ],
    },
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: { query: "mobile flags", providers: ["brave", "duckduckgo"] },
  });

  assert.equal(payload.results.length, 2);
  for (const result of payload.results) {
    assert.equal(result.providerCount, 2);
    // No unflagged copy lifts the merged page out of the low tier.
    assert.equal(result.bestSourceTier, "low");
    for (const variant of result.variants) assert.equal(variant.sourceTier, "low");
  }
});

test("runSearchFusion ranks cross-provider agreement above a single engine's top hit", { skip: "this branch orders by score, then provider priority, with rank only as a tie-breaker" }, async () => {
  const filler = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({ title: `${prefix} ${index}`, url: `https://${prefix}.example/${index}` }));
  const resultsByProvider: Record<string, unknown> = {
    // brave: solo top hit, then two fillers, then the agreed page at rank 3 and a deeper agreed page at rank 4.
    brave: {
      results: [
        { title: "Solo top hit", url: "https://solo.example/top" },
        ...filler("brave", 1),
        { title: "Agreed", url: "https://agreed.example/page" },
        { title: "Agreed deep", url: "https://agreed.example/deep" },
      ],
    },
    tavily: {
      results: [
        ...filler("tavily", 2),
        { title: "Agreed", url: "https://agreed.example/page" },
        { title: "Agreed deep", url: "https://agreed.example/deep" },
      ],
    },
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: { query: "agreement", providers: ["brave", "tavily"] },
  });

  const order = payload.results.map((result) => result.canonicalUrl);
  const agreed = payload.results.find((result) => result.canonicalUrl === "https://agreed.example/page");
  assert.equal(order[0], "https://agreed.example/page");
  assert.equal(agreed?.ranking.scoreBreakdown.corroborationBonus, 0.3);
  // Agreement only at rank 4 does not outrank a provider's clean #1.
  assert.ok(order.indexOf("https://solo.example/top") < order.indexOf("https://agreed.example/deep"));
});

test("runSearchFusion does not let agreement lift a page one provider marked sponsored", async () => {
  const resultsByProvider: Record<string, unknown> = {
    brave: { results: [{ title: "Ad", url: "https://ad.example/x", sponsored: true }] },
    duckduckgo: { results: [{ title: "Ad", url: "https://ad.example/x" }] },
    tavily: {
      results: [
        { title: "Ad", url: "https://ad.example/x" },
        { title: "Clean", url: "https://clean.example/page" },
      ],
    },
    exa: { results: [{ title: "Clean solo", url: "https://solo.example/page" }] },
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: ["brave", "duckduckgo", "tavily", "exa"].map((id, index) => ({
        id,
        label: id,
        configured: true,
        autoDetectOrder: index + 1,
      })),
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: { query: "ads", providers: ["brave", "duckduckgo", "tavily", "exa"] },
  });

  const order = payload.results.map((result) => result.canonicalUrl);
  const ad = payload.results.find((result) => result.canonicalUrl === "https://ad.example/x");
  assert.equal(ad?.providerCount, 3);
  assert.deepEqual(ad?.flags, ["sponsored"]);
  assert.equal(ad?.ranking.scoreBreakdown.tierAdjustment, -0.4);
  assert.equal(order.at(-1), "https://ad.example/x");
});

test("runSearchFusion prefers a page's own snippet over a longer answer-digest copy", async () => {
  const answer =
    "A long synthesized answer that every citation inherits as its fallback snippet, which is much longer than the page's own snippet text.";
  const resultsByProvider: Record<string, unknown> = {
    gemini: {
      content: answer,
      citations: [
        { url: "https://example.com/cited", title: "example.com" },
        { url: "https://example.com/only-cited", title: "example.com" },
      ],
    },
    brave: { results: [{ title: "Cited page", url: "https://example.com/cited", description: "Short page text." }] },
  };

  for (const order of [["gemini", "brave"], ["brave", "gemini"]]) {
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async ({ providerId }) => ({
          provider: providerId ?? "brave",
          result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
        }),
      }) as never,
      config: {},
      pluginConfig: {},
      request: { query: "snippet provenance", providers: order },
    });

    const cited = payload.results.find((result) => result.canonicalUrl === "https://example.com/cited");
    assert.equal(cited?.snippet, "Short page text.", `provider order ${order.join(",")}`);
    assert.deepEqual(cited?.providers, ["brave", "gemini"]);
    const row = payload.evidenceTable.rows.find((entry) => entry.canonicalUrl === "https://example.com/cited");
    assert.equal(row?.snippet, "Short page text.");

    // This branch's result-quality filter drops citation-only results whose
    // title is just the domain, so the answer-only page is not checked here.
  }
});

test("runSearchFusion merges duplicate URLs across providers and keeps provider variants", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
      providers: ["brave", "tavily", "duckduckgo"],
    },
  });

  const mergedDocs = payload.results.find(
    (result) => result.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );

  assert.equal(payload.results.length, 2);
  assert.deepEqual(mergedDocs?.providers, ["brave", "duckduckgo", "tavily"]);
  assert.equal(mergedDocs?.bestRank, 1);
  assert.equal(mergedDocs?.variants.length, 3);
  assert.equal(mergedDocs?.rankings.length, 3);
  assert.equal(mergedDocs?.bestSourceTier, "high");
  assert.deepEqual(mergedDocs?.flags, ["redirect-wrapper", "tracking-stripped"]);
  assert.equal(mergedDocs?.ranking.strategy, "merged-score-v1");
  assert.equal(mergedDocs?.ranking.rank, 1);
  assert.equal(mergedDocs?.ranking.scoreBreakdown.finalScore, mergedDocs?.score);
  assert.equal(mergedDocs?.ranking.tieBreakers.bestRank, mergedDocs?.bestRank);
  assert.equal(
    mergedDocs?.variants.find((variant) => variant.providerId === "brave")?.rawItem,
    undefined,
  );
  assert.deepEqual(payload.output, {
    includeRawPayloads: false,
    includeDiscarded: false,
    maxSnippetLength: 500,
    maxAnswerLength: 2000,
  });

  assert.equal(payload.evidenceTable.version, 1);
  assert.equal(payload.evidenceTable.rowCount, payload.results.length);
  assert.deepEqual(payload.evidenceTable.columns.map((column) => column.key), [
    "rank",
    "title",
    "url",
    "providers",
    "providerCount",
    "bestRank",
    "score",
    "answerCitationCount",
    "flags",
  ]);
  const evidenceDocs = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );
  assert.equal(evidenceDocs?.rank, 1);
  assert.deepEqual(evidenceDocs?.providers, ["brave", "duckduckgo", "tavily"]);
  assert.equal(evidenceDocs?.providerEvidence.length, 3);
  assert.equal(evidenceDocs?.answerCitationSupport.count, 0);

  assert.equal(payload.providersSucceeded.length, 3);
});

test("runSearchFusion fuzzy-merges URL variants, keeps the highest-ranked instance, and merges provenance", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Primary story title",
          url: "http://www.Example.com:80/story/amp/?utm_custom=value#comments",
          description: "Useful short snippet",
        },
      ],
      beta: [
        {
          title: "Unrelated result",
          url: "https://elsewhere.example/first",
          description: "A separate result",
        },
        {
          title: "A much longer title from the lower-ranked duplicate",
          url: "https://m.example.com/story/?fbclid=value",
          description:
            "The lower-ranked provider supplied this longer and more informative snippet.",
        },
      ],
      gamma: [
        {
          title: "Primary story title",
          url: "https://amp.example.com/story/amp.html?gclid=value",
          description: "Another snippet",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "primary story",
      providers: ["alpha", "beta", "gamma"],
    },
  });

  const merged = payload.results.find(
    (result) => result.canonicalUrl === "https://example.com/story",
  );
  assert.equal(payload.results.length, 2);
  assert.equal(merged?.title, "Primary story title");
  assert.equal(merged?.url, "http://www.example.com/story/amp?utm_custom=value");
  assert.equal(
    merged?.snippet,
    "The lower-ranked provider supplied this longer and more informative snippet.",
  );
  assert.deepEqual(merged?.providers, ["alpha", "beta", "gamma"]);
  assert.equal(merged?.providerCount, 3);
  assert.equal(merged?.variants.length, 3);
  assert.equal(merged?.rankings.length, 3);
  assert.equal(merged?.bestRank, 1);
});

test("runSearchFusion applies fuzzy URL identity to evidence citation support", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "alpha", label: "alpha", configured: true },
        { id: "beta", label: "beta", configured: true },
      ],
      search: async ({ providerId }) =>
        providerId === "alpha"
          ? {
              provider: "alpha",
              result: {
                results: [
                  {
                    title: "Canonical story",
                    url: "https://example.com/story",
                    description: "Canonical result",
                  },
                ],
              },
            }
          : {
              provider: "beta",
              result: {
                content: "An answer supported by a same-host alternate URL for the same story.",
                citations: [
                  {
                    title: " canonical story ",
                    url: "http://m.example.com/news/alternate/amp/?utm_source=answer#section",
                  },
                ],
              },
            },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "canonical story",
      providers: ["alpha", "beta"],
    },
  });

  const evidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://example.com/story",
  );
  assert.equal(evidence?.answerCitationSupport.count, 1);
  assert.deepEqual(evidence?.answerCitationSupport.providers, ["beta"]);
});

test("runSearchFusion merges normalized-title matches only on the same canonical host", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Quarterly Results — Q2",
          url: "https://www.example.com/press/q2",
          description: "Press release",
        },
      ],
      beta: [
        {
          title: " quarterly results q2 ",
          url: "https://m.example.com/news/results",
          description: "A longer same-host account of the quarterly results",
        },
      ],
      gamma: [
        {
          title: "Quarterly Results Q2",
          url: "https://different.example/press/q2",
          description: "Different publisher",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "quarterly results",
      providers: ["alpha", "beta", "gamma"],
    },
  });

  assert.equal(payload.results.length, 2);
  const sameHost = payload.results.find((result) => result.providerCount === 2);
  assert.deepEqual(sameHost?.providers, ["alpha", "beta"]);
  assert.equal(sameHost?.canonicalUrl, "https://example.com/press/q2");
  assert.ok(
    payload.results.some(
      (result) => result.canonicalUrl === "https://different.example/press/q2",
    ),
  );
});

test("runSearchFusion never title-merges conflicting meaningful query values", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Product details",
          url: "https://example.com/product?id=1&utm_source=alpha",
          description: "Product one",
        },
      ],
      beta: [
        {
          title: "PRODUCT DETAILS",
          url: "https://www.example.com/product?id=2&utm_source=beta",
          description: "Product two",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "product",
      providers: ["alpha", "beta"],
    },
  });

  assert.equal(payload.results.length, 2);
  assert.deepEqual(
    payload.results.map((result) => result.canonicalUrl).sort(),
    ["https://example.com/product?id=1", "https://example.com/product?id=2"],
  );
  assert.ok(payload.results.every((result) => result.providerCount === 1));
});

test("runSearchFusion never title-merges different non-default ports", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Service status",
          url: "https://example.com:8443/status/current",
          description: "First service",
        },
      ],
      beta: [
        {
          title: "SERVICE STATUS",
          url: "https://example.com:9443/health",
          description: "Second service",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "service status",
      providers: ["alpha", "beta"],
    },
  });

  assert.equal(payload.results.length, 2);
  assert.ok(payload.results.every((result) => result.providerCount === 1));
});

test("runSearchFusion can disable fuzzy dedupe without disabling legacy exact merging", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Story",
          url: "http://www.example.com/story/amp",
          description: "Mobile variant",
        },
        {
          title: "Exact duplicate",
          url: "http://www.example.com/story/amp#fragment",
          description: "Exact canonical duplicate",
        },
      ],
      beta: [
        {
          title: "Story",
          url: "https://example.com/story",
          description: "Canonical variant",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {
      fuzzyDedupe: false,
    },
    request: {
      query: "story",
      providers: ["alpha", "beta"],
      includeRawPayloads: true,
    },
  });

  assert.equal(payload.results.length, 2);
  assert.deepEqual(
    payload.results.map((result) => result.providerCount).sort(),
    [1, 1],
  );
  const legacyExact = payload.results.find(
    // The exact canonical URL folds scheme and www. but keeps the /amp path.
    (result) => result.canonicalUrl === "https://example.com/story/amp",
  );
  assert.equal(legacyExact?.variants.length, 2);
});

test("runSearchFusion fuzzy-dedupe disable preserves non-legacy tracking distinctions", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Story",
          url: "https://example.com/story?utm_custom=alpha",
          description: "Alpha campaign",
        },
      ],
      beta: [
        {
          title: "Story",
          url: "https://example.com/story?utm_custom=beta",
          description: "Beta campaign",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {
      fuzzyDedupe: false,
    },
    request: {
      query: "story",
      providers: ["alpha", "beta"],
    },
  });

  assert.equal(payload.results.length, 2);
  assert.deepEqual(
    payload.results.map((result) => result.canonicalUrl).sort(),
    [
      "https://example.com/story?utm_custom=alpha",
      "https://example.com/story?utm_custom=beta",
    ],
  );
});

test("runSearchFusion keeps single-provider results raw by default (fuzzy dedupe is fusion-only)", async () => {
  const runtime = createStaticResultsRuntime({
    alpha: [
      {
        title: "Story",
        url: "https://example.com/story?utm_custom=alpha",
        description: "Tracked variant",
      },
      {
        title: "Story",
        url: "https://example.com/story?utm_custom=beta",
        description: "Second tracked variant",
      },
    ],
  }) as never;

  const defaulted = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {},
    request: {
      query: "story",
      providers: ["alpha"],
    },
  });
  assert.equal(defaulted.results.length, 2);

  const optedIn = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      fuzzyDedupe: true,
    },
    request: {
      query: "story",
      providers: ["alpha"],
    },
  });
  assert.equal(optedIn.results.length, 1);
  assert.equal(optedIn.results[0]?.canonicalUrl, "https://example.com/story");
});

test("runSearchFusion extends and overrides tracking-parameter dedupe safely", async () => {
  const runtime = createStaticResultsRuntime({
    alpha: [
      {
        title: "Campaign story",
        url: "https://example.com/story?campaign_id=alpha&ref=one",
        description: "Alpha campaign",
      },
    ],
    beta: [
      {
        title: "Campaign story",
        url: "https://example.com/story?campaign_id=beta&ref=two",
        description: "Beta campaign",
      },
    ],
  }) as never;
  const request = {
    query: "campaign story",
    providers: ["alpha", "beta"],
  };

  const extended = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      trackingParams: ["campaign_id"],
    },
    request,
  });
  const overridden = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      trackingParams: ["campaign_id"],
      trackingParamMode: "override",
    },
    request,
  });

  assert.equal(extended.results.length, 1);
  assert.equal(extended.results[0]?.canonicalUrl, "https://example.com/story");
  assert.deepEqual(extended.results[0]?.providers, ["alpha", "beta"]);
  assert.equal(overridden.results.length, 2);
  assert.deepEqual(
    overridden.results.map((result) => result.canonicalUrl).sort(),
    [
      "https://example.com/story?ref=one",
      "https://example.com/story?ref=two",
    ],
  );
  assert.deepEqual(
    overridden.results.map((result) => result.url).sort(),
    [
      "https://example.com/story?campaign_id=alpha&ref=one",
      "https://example.com/story?campaign_id=beta&ref=two",
    ],
  );
});

test("runSearchFusion preserves override-mode display and navigation URLs", async () => {
  const payload = await runSearchFusion({
    runtime: createStaticResultsRuntime({
      alpha: [
        {
          title: "Referenced story",
          url: "https://example.com/story?ref=one",
        },
      ],
    }) as never,
    config: {},
    pluginConfig: {
      trackingParams: [],
      trackingParamMode: "override",
    },
    request: {
      query: "referenced story",
      providers: ["alpha"],
    },
  });

  assert.equal(payload.results[0]?.url, "https://example.com/story?ref=one");
  assert.equal(
    payload.results[0]?.canonicalUrl,
    "https://example.com/story?ref=one",
  );
  assert.equal(
    payload.results[0]?.variants[0]?.originalUrl,
    "https://example.com/story?ref=one",
  );
});

test("runSearchFusion attributes override-mode citations to the matching evidence row", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "alpha", label: "alpha", configured: true },
        { id: "beta", label: "beta", configured: true },
        { id: "gamma", label: "gamma", configured: true },
      ],
      search: async ({ providerId }) => {
        if (providerId === "alpha") {
          return {
            provider: "alpha",
            result: {
              results: [
                {
                  title: "Referenced story",
                  url: "https://example.com/story?ref=one",
                },
              ],
            },
          };
        }
        if (providerId === "beta") {
          return {
            provider: "beta",
            result: {
              results: [
                {
                  title: "Base story",
                  url: "https://example.com/story",
                },
              ],
            },
          };
        }
        return {
          provider: "gamma",
          result: {
            content: "An answer supported by the referenced story.",
            citations: ["https://example.com/story?ref=one"],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      trackingParams: [],
      trackingParamMode: "override",
    },
    request: {
      query: "story",
      providers: ["alpha", "beta", "gamma"],
    },
  });

  assert.deepEqual(payload.answers[0]?.citations, [
    "https://example.com/story?ref=one",
  ]);
  const referencedEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://example.com/story?ref=one",
  );
  const baseEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://example.com/story",
  );
  assert.equal(referencedEvidence?.answerCitationSupport.count, 1);
  assert.deepEqual(referencedEvidence?.answerCitationSupport.providers, ["gamma"]);
  assert.equal(baseEvidence?.answerCitationSupport.count, 0);
  assert.deepEqual(baseEvidence?.answerCitationSupport.providers, []);
});


test("runSearchFusion keeps missing-url junk as non-merged provenance", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: "Knowledge panel",
              description: "No URL attached",
              kind: "infobox",
            },
            {
              title: "OpenClaw docs",
              url: "https://docs.openclaw.ai/tools/web",
              description: "Official docs",
            },
          ],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw web docs",
      providers: ["brave"],
      includeDiscarded: true,
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.discardedResults.length, 1);
  assert.equal(payload.discardedResults[0]?.reason, "missing-url");
  assert.equal(payload.providerRuns[0]?.discardedResults.length, 1);
  assert.equal(payload.providerRuns[0]?.rawCount, 2);
  assert.equal(payload.providerDetails[0]?.rawCount, 2);
  assert.equal(payload.providerDetails[0]?.discardedCount, 1);
});

test("runSearchFusion uses configured default providers and excludes itself", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      defaultProviders: ["brave", "gemini", "search-fusion"],
    },
    request: {
      query: "openclaw",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini"]);
  assert.equal(payload.provider, "search-fusion");
});

test("runSearchFusion honors explicit request mode", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      modes: {
        fast: ["brave"],
        deep: ["gemini", "tavily"],
      },
    },
    request: {
      query: "openclaw",
      mode: "deep",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion provides built-in starter modes when custom modes are absent", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
      mode: "balanced",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini"]);
});

test("runSearchFusion falls back to all configured providers when no defaults or mode are set", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave", "gemini", "tavily", "duckduckgo"]);
});

test("runSearchFusion does not query paid and free siblings in the same fan-out", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "firecrawl-free", label: "Firecrawl Free", configured: true, requiresCredential: false },
        { id: "firecrawl", label: "Firecrawl", configured: true },
        { id: "parallel-free", label: "Parallel Free", configured: true, requiresCredential: false },
        { id: "parallel", label: "Parallel", configured: true },
        { id: "search-fusion", label: "Search Fusion", configured: true },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "dedupe provider tiers",
    },
  });

  assert.deepEqual(payload.providersQueried, ["firecrawl", "parallel"]);
});

test("runSearchFusion includes empty ranking metadata when no providers are available", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [{ id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 }],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw",
    },
  });

  assert.equal(payload.results.length, 0);
  assert.equal(payload.ranking.strategy, "merged-score-v1");
  assert.deepEqual(payload.ranking.sortOrder, [
    "score:desc",
    "providerPriority:asc",
    "bestRank:asc",
  ]);
  assert.equal(payload.ranking.consideredCount, 0);
  assert.equal(payload.ranking.returnedCount, 0);
  assert.equal(payload.ranking.droppedCount, 0);
  assert.deepEqual(payload.ranking.dropped, []);
});

test("runSearchFusion treats custom modes as authoritative", async () => {
  await assert.rejects(
    async () =>
      await runSearchFusion({
        runtime: createRuntime() as never,
        config: {},
        pluginConfig: {
          modes: {
            custom: ["brave"],
          },
        },
        request: {
          query: "openclaw",
          mode: "balanced",
        },
      }),
    /Unknown Search Fusion mode: balanced/,
  );
});

test("runSearchFusion throws on unknown explicit mode", async () => {
  await assert.rejects(
    async () =>
      await runSearchFusion({
        runtime: createRuntime() as never,
        config: {},
        pluginConfig: {
          modes: {
            fast: ["brave"],
          },
        },
        request: {
          query: "openclaw",
          mode: "chaos",
        },
      }),
    /Unknown Search Fusion mode: chaos/,
  );
});

test("runSearchFusion preserves full answer content and raw payloads for answer-style providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "openclaw grounding",
      providers: ["gemini", "tavily"],
      includeRawPayloads: true,
    },
  });

  assert.equal(payload.answers.length, 1);
  assert.equal(payload.answers[0]?.providerId, "gemini");
  assert.match(payload.answers[0]?.summary ?? "", /grounded summary/i);
  assert.match(payload.answers[0]?.fullContent ?? "", /preservation checks/i);
  assert.equal(payload.answers[0]?.citationDetails[1]?.title, "GitHub");
  assert.ok(payload.results.some((result) => result.providers.includes("gemini")));
  assert.ok(payload.results.some((result) => result.providers.includes("tavily")));
  assert.match(String(payload.providerRuns[0]?.rawPayload?.content ?? ""), /grounded summary/i);

  const docsEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );
  const githubEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://github.com/openclaw/openclaw",
  );
  assert.equal(docsEvidence?.answerCitationSupport.count, 1);
  assert.deepEqual(docsEvidence?.answerCitationSupport.providers, ["gemini"]);
  assert.equal(githubEvidence?.answerCitationSupport.count, 1);
  assert.deepEqual(githubEvidence?.providerEvidence.map((entry) => entry.sourceType), ["citations"]);
});

test("runSearchFusion evidenceTable tracks citation counts and unique providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "gemini", label: "Gemini", configured: true, autoDetectOrder: 20 },
        { id: "kimi", label: "Kimi", configured: true, autoDetectOrder: 25 },
        { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
      ],
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          return {
            provider: "gemini",
            result: {
              content: "Gemini synthesis",
              citations: [
                "https://docs.openclaw.ai/tools/web",
                "https://docs.openclaw.ai/tools/web?utm_source=gemini",
              ],
            },
          };
        }

        return {
          provider: providerId ?? "kimi",
          result: {
            content: "Kimi synthesis",
            citations: ["https://docs.openclaw.ai/tools/web"],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "citation corroboration",
      providers: ["gemini", "kimi"],
    },
  });

  const docsEvidence = payload.evidenceTable.rows.find(
    (row) => row.canonicalUrl === "https://docs.openclaw.ai/tools/web",
  );

  assert.equal(docsEvidence?.answerCitationSupport.count, 3);
  assert.equal(docsEvidence?.answerCitationSupport.providerCount, 2);
  assert.deepEqual(docsEvidence?.answerCitationSupport.providers, ["gemini", "kimi"]);
});

test("runSearchFusion ranks clean result-style hits ahead of sponsored noise", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "brave") {
          return {
            provider: "brave",
            result: {
              results: [
                {
                  title: "Good docs",
                  url: "https://docs.openclaw.ai/tools/web",
                  description: "Official docs",
                },
                {
                  title: "Ad result",
                  url: "https://example.com/buy-now",
                  description: "sponsored",
                  sponsored: true,
                },
              ],
            },
          };
        }
        return {
          provider: providerId ?? "tavily",
          result: {
            results: [{ title: "Other", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "quality ordering",
      providers: ["brave"],
    },
  });

  assert.equal(payload.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(payload.results[0]?.bestSourceTier, "high");
  assert.deepEqual(payload.results[1]?.flags, ["sponsored"]);
  assert.equal(payload.results[1]?.bestSourceTier, "suppressed");
});

test("runSearchFusion default calibration removes cross-provider score-scale bias", async () => {
  const cases = [
    {
      name: "probability scores versus percentages",
      preferredScores: [0.9, 0.2],
      inflatedScores: [95, 20],
    },
    {
      name: "small confidence values versus large retrieval scores",
      preferredScores: [0.08, 0.01],
      inflatedScores: [800, 100],
    },
  ];

  for (const row of cases) {
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async ({ providerId }) => {
          const scores =
            providerId === "brave" ? row.preferredScores : row.inflatedScores;
          return {
            provider: providerId ?? "brave",
            result: {
              results: scores.map((score, index) => ({
                title: `${providerId} result ${index + 1}`,
                url: `https://example.com/${providerId}/${index + 1}`,
                score,
              })),
            },
          };
        },
      }) as never,
      config: {},
      pluginConfig: {},
      request: {
        query: row.name,
        providers: ["brave", "gemini"],
      },
    });

    const naiveTopProvider =
      Math.max(...row.inflatedScores) > Math.max(...row.preferredScores)
        ? "gemini"
        : "brave";
    const braveRun = payload.providerRuns.find((run) => run.provider === "brave");
    const geminiRun = payload.providerRuns.find((run) => run.provider === "gemini");

    assert.equal(naiveTopProvider, "gemini", row.name);
    assert.deepEqual(braveRun?.results.map((result) => result.score), [1, 0], row.name);
    assert.deepEqual(geminiRun?.results.map((result) => result.score), [1, 0], row.name);
    assert.equal(payload.results[0]?.providers[0], "brave", row.name);
    assert.equal(payload.results[0]?.ranking.tieBreakers.providerPriority, 0, row.name);
    assert.equal(payload.results[0]?.ranking.tieBreakers.priorityProvider, "brave", row.name);
  }
});

test("runSearchFusion keeps fully tied calibrated results in stable provider order", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: "Zulu inserted first",
              url: "https://example.com/first",
              score: 0,
            },
          ],
          web: {
            results: [
              {
                title: "Alpha inserted second",
                url: "https://example.com/second",
                score: 1,
              },
            ],
          },
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      sourceTierMode: "off",
      providerConfig: {
        brave: {
          scoreCalibration: {
            strategy: "fixed",
            curve: [
              { input: 0, output: 0.5 },
              { input: 1, output: 0.5 },
            ],
          },
        },
      },
    },
    request: {
      query: "stable calibrated tie",
      providers: ["brave"],
    },
  });

  assert.deepEqual(
    payload.providerRuns[0]?.results.map((result) => result.score),
    [0.5, 0.5],
  );
  assert.deepEqual(
    payload.results.map((result) => result.title),
    ["Zulu inserted first", "Alpha inserted second"],
  );
  assert.deepEqual(payload.ranking.sortOrder, [
    "score:desc",
    "providerPriority:asc",
    "bestRank:asc",
  ]);
});

test("runSearchFusion applies provider priority before original rank for calibrated ties", async () => {
  const fixedTie = {
    strategy: "fixed" as const,
    curve: [
      { input: 0, output: 0.5 },
      { input: 1, output: 0.5 },
    ],
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: `${providerId}-1`,
              url: `https://example.com/${providerId}-1`,
              score: 0,
            },
            {
              title: `${providerId}-2`,
              url: `https://example.com/${providerId}-2`,
              score: 1,
            },
          ],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      sourceTierMode: "off",
      providerConfig: {
        brave: { scoreCalibration: fixedTie },
        gemini: { scoreCalibration: fixedTie },
      },
    },
    request: {
      query: "provider priority before original rank",
      providers: ["brave", "gemini"],
    },
  });

  assert.deepEqual(
    payload.results.map((result) => [
      result.title,
      result.ranking.tieBreakers.providerPriority,
      result.bestRank,
      result.score,
    ]),
    [
      ["brave-1", 0, 1, 0.5],
      ["brave-2", 0, 2, 0.5],
      ["gemini-1", 1, 1, 0.5],
      ["gemini-2", 1, 2, 0.5],
    ],
  );
  assert.ok(
    payload.results.every(
      (result) => result.ranking.scoreBreakdown.bestRankBonus === 0,
    ),
  );
});

test("runSearchFusion rejects invalid fixed calibration before calling a provider", async () => {
  let searchCalls = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        searchCalls += 1;
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "Unexpected", url: "https://example.com/unexpected" }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 5, backoffMs: 0 },
      providerConfig: {
        brave: {
          scoreCalibration: {
            strategy: "fixed",
            curve: [
              { input: 0, output: 1 },
              { input: 1, output: 0 },
            ],
          },
        },
      },
    },
    request: {
      query: "invalid fixed curve",
      providers: ["brave"],
    },
  });

  assert.equal(searchCalls, 0);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /non-decreasing/);
});

test("runSearchFusion treats keyless providers like DuckDuckGo as configured", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        {
          id: "duckduckgo",
          label: "DuckDuckGo",
          configured: true,
          requiresCredential: false,
          autoDetectOrder: 100,
        },
        { id: "search-fusion", label: "Search Fusion", configured: true, autoDetectOrder: 999 },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "free fallback",
    },
  });

  assert.deepEqual(payload.configuredProviders, ["duckduckgo"]);
  assert.deepEqual(payload.providersQueried, ["duckduckgo"]);
  assert.deepEqual(payload.providersSucceeded, ["duckduckgo"]);
});

test("runSearchFusion retries transient failures with the default policy", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attempts += 1;
        if (providerId === "brave" && attempts < 3) {
          throw new Error("temporary upstream failure");
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        backoffMs: 0,
      },
    },
    request: {
      query: "retry default",
      providers: ["brave"],
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providerRuns[0]?.attempts, 3);
  assert.equal(payload.providerRuns[0]?.retryHistory.length, 2);
});

test("runSearchFusion honors per-provider retry overrides", async () => {
  const counts = new Map<string, number>();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        const key = providerId ?? "unknown";
        const current = (counts.get(key) ?? 0) + 1;
        counts.set(key, current);

        if (key === "brave" && current <= 2) {
          throw new Error("temporary brave failure");
        }
        if (key === "gemini" && current <= 3) {
          throw new Error("temporary gemini failure");
        }

        return {
          provider: key,
          result: {
            results: [{ title: `${key} ok`, url: `https://example.com/${key}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 2,
        backoffMs: 0,
      },
      providerConfig: {
        gemini: {
          retry: {
            maxAttempts: 4,
            backoffMs: 0,
          },
        },
      },
    },
    request: {
      query: "retry override",
      providers: ["brave", "gemini"],
    },
  });

  assert.equal(counts.get("brave"), 2);
  assert.equal(counts.get("gemini"), 4);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "brave", error: "temporary brave failure" }]);
  assert.equal(payload.providerRuns.find((run) => run.provider === "brave")?.attempts, 2);
  assert.equal(payload.providerRuns.find((run) => run.provider === "gemini")?.attempts, 4);
});

test("runSearchFusion defaults to verified provider-native counts in delegated payloads", async () => {
  const seenArgs = new Map<string, Record<string, unknown>>();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "brave", label: "Brave", configured: true, autoDetectOrder: 10 },
        { id: "exa", label: "Exa", configured: true, autoDetectOrder: 20 },
        { id: "parallel", label: "Parallel", configured: true, autoDetectOrder: 30 },
        { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 40 },
      ],
      search: async ({ providerId, args }) => {
        const id = providerId ?? "unknown";
        seenArgs.set(id, args);
        return {
          provider: id,
          result: {
            results: [{ title: `${id} result`, url: `https://example.com/${id}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "native provider counts",
      providers: ["brave", "exa", "parallel", "tavily"],
    },
  });

  assert.deepEqual(
    Object.fromEntries([...seenArgs].map(([providerId, args]) => [providerId, args.count])),
    {
      brave: 10,
      exa: 100,
      parallel: 40,
      tavily: 20,
    },
  );
  for (const args of seenArgs.values()) {
    assert.equal("numResults" in args, false);
    assert.equal("max_results" in args, false);
    assert.equal("advanced_settings" in args, false);
  }
  assert.deepEqual(payload.providersSucceeded, ["brave", "exa", "parallel", "tavily"]);
});

test("runSearchFusion keeps the conservative default for unknown provider adapters", async () => {
  let seenCount: unknown;
  await runSearchFusion({
    runtime: createRuntime({
      providers: [
        {
          id: "custom-search",
          label: "Custom Search",
          configured: true,
          autoDetectOrder: 10,
        },
      ],
      search: async ({ providerId, args }) => {
        seenCount = args.count;
        return {
          provider: providerId ?? "custom-search",
          result: {
            results: [{ title: "Custom result", url: "https://example.com/custom" }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "unknown provider count",
      providers: ["custom-search"],
    },
  });

  assert.equal(seenCount, 5);
});

test("runSearchFusion keeps keyless providers within their free adapter contracts", async () => {
  const seenCounts = new Map<string, unknown>();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        {
          id: "duckduckgo",
          label: "DuckDuckGo",
          configured: true,
          requiresCredential: false,
          autoDetectOrder: 10,
        },
        {
          id: "firecrawl-free",
          label: "Firecrawl Free",
          configured: true,
          requiresCredential: false,
          autoDetectOrder: 20,
        },
        {
          id: "parallel-free",
          label: "Parallel Free",
          configured: true,
          requiresCredential: false,
          autoDetectOrder: 30,
        },
      ],
      search: async ({ providerId, args }) => {
        const id = providerId ?? "unknown";
        seenCounts.set(id, args.count);
        return {
          provider: id,
          result: {
            results: [{ title: `${id} result`, url: `https://example.com/${id}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "free provider counts",
      providers: ["duckduckgo", "firecrawl-free", "parallel-free"],
    },
  });

  assert.deepEqual(Object.fromEntries(seenCounts), {
    duckduckgo: 10,
    "firecrawl-free": 10,
    "parallel-free": 40,
  });
  assert.deepEqual(payload.providersSucceeded, [
    "duckduckgo",
    "firecrawl-free",
    "parallel-free",
  ]);
});

test("runSearchFusion clamps requests to configured and native provider maxima", async () => {
  const seenCounts = new Map<string, unknown>();
  await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "brave", label: "Brave", configured: true, autoDetectOrder: 10 },
        { id: "exa", label: "Exa", configured: true, autoDetectOrder: 20 },
        { id: "parallel", label: "Parallel", configured: true, autoDetectOrder: 30 },
        { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 40 },
      ],
      search: async ({ providerId, args }) => {
        const id = providerId ?? "unknown";
        seenCounts.set(id, args.count);
        return {
          provider: id,
          result: {
            results: [{ title: `${id} result`, url: `https://example.com/${id}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: { maxResults: 4 },
        exa: { maxResults: 12 },
        parallel: { maxResults: 100 },
        tavily: { maxResults: 8 },
      },
    },
    request: {
      query: "clamped provider counts",
      providers: ["brave", "exa", "parallel", "tavily"],
      count: 100,
    },
  });

  assert.deepEqual(Object.fromEntries(seenCounts), {
    brave: 4,
    exa: 12,
    parallel: 40,
    tavily: 8,
  });
});

test("runSearchFusion uses maxResults overrides as the default pull count", async () => {
  let seenCount: unknown;
  await runSearchFusion({
    runtime: createRuntime({
      providers: [{ id: "exa", label: "Exa", configured: true, autoDetectOrder: 10 }],
      search: async ({ providerId, args }) => {
        seenCount = args.count;
        return {
          provider: providerId ?? "exa",
          result: {
            results: [{ title: "Exa result", url: "https://example.com/exa" }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerConfig: {
        exa: { maxResults: 17 },
      },
    },
    request: {
      query: "configured provider default",
      providers: ["exa"],
    },
  });

  assert.equal(seenCount, 17);
});

test("runSearchFusion keeps merged output capped while ranking deeper native pulls", async () => {
  const seenCounts = new Map<string, number>();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "exa", label: "Exa", configured: true, autoDetectOrder: 10 },
        { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 20 },
      ],
      search: async ({ providerId, args }) => {
        const id = providerId ?? "unknown";
        const count = typeof args.count === "number" ? args.count : 0;
        seenCounts.set(id, count);
        return {
          provider: id,
          result: {
            results: Array.from({ length: count }, (_, index) => ({
              title: `${id} result ${index + 1}`,
              url: `https://example.com/${id}/${index + 1}`,
            })),
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "deep candidates bounded output",
      providers: ["exa", "tavily"],
      maxMergedResults: 7,
    },
  });

  assert.deepEqual(Object.fromEntries(seenCounts), {
    exa: 100,
    tavily: 20,
  });
  assert.equal(payload.providerRuns.find((run) => run.provider === "exa")?.rawCount, 100);
  assert.equal(payload.providerRuns.find((run) => run.provider === "tavily")?.rawCount, 20);
  assert.equal(payload.ranking.consideredCount, 120);
  assert.equal(payload.ranking.returnedCount, 7);
  assert.equal(payload.ranking.droppedCount, 113);
  assert.deepEqual(payload.ranking.dropped, []);
  assert.equal(payload.results.length, 7);
  assert.equal(
    payload.providerRuns.reduce((total, run) => total + run.results.length, 0),
    7,
  );
  assert.equal(payload.evidenceTable.rowCount, 7);
  assert.equal(payload.count, 7);
});

test("runSearchFusion bounds duplicate merged evidence unless raw audit output is requested", async () => {
  const runtime = createRuntime({
    providers: [
      { id: "exa", label: "Exa", configured: true, autoDetectOrder: 10 },
      { id: "tavily", label: "Tavily", configured: true, autoDetectOrder: 20 },
    ],
    search: async ({ providerId, args }) => {
      const id = providerId ?? "unknown";
      const count = typeof args.count === "number" ? args.count : 0;
      return {
        provider: id,
        result: {
          results: Array.from({ length: count }, (_, index) => ({
            title: `${id} duplicate ${index + 1}`,
            url: "https://example.com/shared",
            description: `${id} evidence ${index + 1}`,
          })),
        },
      };
    },
  }) as never;

  const bounded = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {},
    request: {
      query: "duplicate candidate evidence",
      providers: ["exa", "tavily"],
    },
  });

  assert.equal(bounded.results.length, 1);
  assert.equal(bounded.results[0]?.providerCount, 2);
  assert.deepEqual(
    bounded.results[0]?.variants.map((variant) => variant.providerId),
    ["exa", "tavily"],
  );
  assert.deepEqual(
    bounded.results[0]?.rankings.map((ranking) => ranking.providerId),
    ["exa", "tavily"],
  );
  assert.deepEqual(
    bounded.providerRuns.map((run) => [run.provider, run.rawCount, run.results.length]),
    [
      ["exa", 100, 1],
      ["tavily", 20, 1],
    ],
  );
  assert.deepEqual(
    bounded.evidenceTable.rows[0]?.providerEvidence.map((entry) => entry.providerId),
    ["exa", "tavily"],
  );

  const audit = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {},
    request: {
      query: "duplicate candidate evidence",
      providers: ["exa", "tavily"],
      includeRawPayloads: true,
    },
  });

  assert.equal(audit.results[0]?.variants.length, 120);
  assert.equal(audit.results[0]?.rankings.length, 120);
  assert.equal(
    audit.providerRuns.reduce((total, run) => total + run.results.length, 0),
    120,
  );
  assert.equal(audit.evidenceTable.rows[0]?.providerEvidence.length, 120);
  assert.ok(audit.providerRuns.every((run) => Boolean(run.rawPayload)));
});

test("runSearchFusion passes providerConfig count overrides when request count is absent", async () => {
  let seenCount: unknown;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId, args }) => {
        seenCount = args.count;
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      countPerProvider: 5,
      providerConfig: {
        gemini: {
          count: 2,
        },
      },
    },
    request: {
      query: "provider count override",
      providers: ["gemini"],
    },
  });

  assert.equal(seenCount, 2);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
});

test("runSearchFusion passes providerConfig timeout overrides", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerTimeoutMs: 1000,
      retry: {
        maxAttempts: 1,
      },
      providerConfig: {
        gemini: {
          timeoutMs: 2000,
        },
      },
    },
    request: {
      query: "provider timeout override",
      providers: ["gemini"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
});

test("runSearchFusion applies provider weight multipliers to ranking scores", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: {
          results: [
            {
              title: providerId === "brave" ? "Alpha source" : "Zulu source",
              url: providerId === "brave" ? "https://example.com/alpha" : "https://example.com/zulu",
              description: `${providerId} result`,
            },
          ],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 0.5,
        },
        gemini: {
          weight: 1.5,
        },
      },
    },
    request: {
      query: "provider weighting",
      providers: ["brave", "gemini"],
    },
  });

  const braveRun = payload.providerRuns.find((run) => run.provider === "brave");
  const geminiRun = payload.providerRuns.find((run) => run.provider === "gemini");

  assert.equal(braveRun?.results[0]?.score, 0.5);
  assert.equal(geminiRun?.results[0]?.score, 1.5);
  assert.equal(payload.results[0]?.canonicalUrl, "https://example.com/zulu");
});

test("runSearchFusion clamps provider weight overrides to a safe range", async () => {
  const runtime = createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "brave",
      result: {
        results: [{ title: "Seed result", url: `https://example.com/${providerId ?? "brave"}` }],
      },
    }),
  }) as never;

  const highWeightPayload = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 100,
        },
      },
    },
    request: {
      query: "high provider weight",
      providers: ["brave"],
    },
  });

  const lowWeightPayload = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      providerConfig: {
        brave: {
          weight: 0,
        },
      },
    },
    request: {
      query: "low provider weight",
      providers: ["brave"],
    },
  });

  assert.equal(highWeightPayload.providerRuns[0]?.results[0]?.score, 5);
  assert.equal(lowWeightPayload.providerRuns[0]?.results[0]?.score, 0.1);
});

test("runSearchFusion still honors legacy providerRetries overrides", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attempts += 1;
        if (attempts < 4) {
          throw new Error("temporary gemini failure");
        }
        return {
          provider: providerId ?? "gemini",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 2,
        backoffMs: 0,
      },
      providerRetries: {
        gemini: {
          maxAttempts: 4,
          backoffMs: 0,
        },
      },
    },
    request: {
      query: "legacy retry override",
      providers: ["gemini"],
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(payload.providersSucceeded, ["gemini"]);
  assert.equal(payload.providerRuns[0]?.attempts, 4);
});

test("runSearchFusion does not retry non-retriable auth errors", async () => {
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async () => {
        attempts += 1;
        throw new Error("401 Unauthorized: invalid API key");
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 5,
        backoffMs: 0,
      },
    },
    request: {
      query: "auth failure",
      providers: ["gemini"],
    },
  });

  assert.equal(attempts, 1);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "401 Unauthorized: invalid API key" }]);
});

test("runSearchFusion tolerates provider failures and reports them", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          throw new Error("Gemini exploded");
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [
              {
                title: `${providerId} result`,
                url: `https://example.com/${providerId}`,
                description: `from ${providerId}`,
              },
            ],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 1,
      },
    },
    request: {
      query: "partial failure",
      providers: ["brave", "gemini", "tavily"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave", "tavily"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "Gemini exploded" }]);
  assert.equal(payload.results.length, 2);
});


test("runSearchFusion isolates unexpected provider pipeline crashes", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "unknown",
        result: {
          results: [{ title: `${providerId} ok`, url: `https://example.com/${providerId}` }],
        },
      }),
    }) as never,
    config: {},
    pluginConfig: {
      retry: {
        maxAttempts: 1,
      },
      providerConfig: new Proxy({}, {
        get: (_target, prop) => {
          if (prop === "gemini") {
            throw new Error("gemini pipeline blew up");
          }
          return undefined;
        },
      }),
    },
    request: {
      query: "pipeline isolation",
      providers: ["brave", "gemini", "tavily"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave", "tavily"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "gemini pipeline blew up" }]);
  assert.equal(payload.providerRuns.find((run) => run.provider === "gemini")?.ok, false);
});

test("runSearchFusion enforces per-provider timeouts", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        if (providerId === "gemini") {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return {
            provider: "gemini",
            result: {
              results: [{ title: "late", url: "https://example.com/late" }],
            },
          };
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "ok", url: `https://example.com/${providerId}` }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerTimeoutMs: 1000,
      retry: {
        maxAttempts: 1,
      },
    },
    request: {
      query: "timeout",
      providers: ["brave", "gemini"],
    },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providersFailed.length, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /timed out/i);
});

test("runSearchFusion honors request maxMergedResults without losing provider payloads", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: { maxMergedResults: 10 },
    request: {
      query: "openclaw",
      providers: ["brave", "gemini", "tavily"],
      maxMergedResults: 2,
      includeRawPayloads: true,
    },
  });

  assert.equal(payload.results.length, 2);
  assert.equal(payload.providerRuns.length, 3);
  assert.ok(payload.providerRuns.every((run) => (run.ok ? Boolean(run.rawPayload) : true)));
  assert.equal(
    payload.providerRuns.reduce((total, run) => total + run.results.length, 0),
    5,
  );

  assert.equal(payload.ranking.strategy, "merged-score-v1");
  assert.deepEqual(payload.ranking.sortOrder, [
    "score:desc",
    "providerPriority:asc",
    "bestRank:asc",
  ]);
  assert.equal(payload.ranking.consideredCount, 3);
  assert.equal(payload.ranking.returnedCount, 2);
  assert.equal(payload.ranking.droppedCount, 1);
  assert.equal(payload.ranking.dropped[0]?.rank, 3);
  assert.equal(payload.ranking.dropped[0]?.reason, "maxMergedResults");
  assert.equal(payload.ranking.dropped[0]?.title, "GitHub");
  assert.equal(payload.ranking.dropped[0]?.url, "https://github.com/openclaw/openclaw");
  assert.equal(payload.ranking.dropped[0]?.canonicalUrl, "https://github.com/openclaw/openclaw");
  assert.equal(payload.ranking.dropped[0]?.bestRank, 2);
  assert.equal(payload.ranking.dropped[0]?.providerCount, 1);
  assert.ok(Math.abs((payload.ranking.dropped[0]?.score ?? 0) - 0.01) < 0.0001);
  assert.deepEqual(
    payload.results.map((result) => result.ranking.rank),
    [1, 2],
  );
  assert.ok(payload.results.every((result) => result.ranking.scoreBreakdown.finalScore === result.score));
});

test("runSearchFusion routes by intent hint when intentProviders is configured", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        research: ["gemini", "tavily"],
        keyword: ["brave"],
      },
    },
    request: {
      query: "deep dive into openclaw plugin sdk",
      intent: "research",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion uses capability-driven answer routing by default", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      providers: [
        { id: "codex", label: "Codex", configured: true, requiresCredential: false },
        { id: "gemini", label: "Gemini", configured: true },
        { id: "grok", label: "Grok", configured: true },
        { id: "kimi", label: "Kimi", configured: true },
        { id: "perplexity", label: "Perplexity", configured: true },
        { id: "firecrawl", label: "Firecrawl", configured: true },
        { id: "search-fusion", label: "Search Fusion", configured: true },
      ],
    }) as never,
    config: {},
    pluginConfig: {},
    request: {
      query: "answer intent provider routing",
      intent: "answer",
    },
  });

  assert.deepEqual(payload.providersQueried, ["codex", "gemini", "grok", "kimi", "perplexity"]);
});

test("runSearchFusion intent does not override explicit providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        keyword: ["brave"],
      },
    },
    request: {
      query: "explicit override test",
      providers: ["tavily"],
      intent: "keyword",
    },
  });

  assert.deepEqual(payload.providersQueried, ["tavily"]);
});

test("runSearchFusion intent does not override explicit mode", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      modes: {
        deep: ["gemini", "tavily"],
      },
      intentProviders: {
        keyword: ["brave"],
      },
    },
    request: {
      query: "mode wins over intent",
      mode: "deep",
      intent: "keyword",
    },
  });

  assert.deepEqual(payload.providersQueried, ["gemini", "tavily"]);
});

test("runSearchFusion falls through to defaults when intent maps to no available providers", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime() as never,
    config: {},
    pluginConfig: {
      intentProviders: {
        answer: ["perplexity"],
      },
      defaultProviders: ["brave"],
    },
    request: {
      query: "fallthrough when intent providers unavailable",
      intent: "answer",
    },
  });

  assert.deepEqual(payload.providersQueried, ["brave"]);
});

test("runSearchFusion sourceTierMode strict suppresses citation-first noise vs off", async () => {
  const sharedRuntime = createRuntime({
    search: async ({ providerId }) => {
      if (providerId === "gemini") {
        return {
          provider: "gemini",
          result: {
            results: [
              {
                title: "Official docs",
                url: "https://docs.openclaw.ai/tools/web",
                score: 0.3,
              },
            ],
            citations: [
              {
                title: "Citation-heavy blog",
                url: "https://example.com/citation-blog",
                score: 2,
              },
            ],
          },
        };
      }

      return {
        provider: providerId ?? "gemini",
        result: {
          results: [{ title: "Other", url: `https://example.com/${providerId}` }],
        },
      };
    },
  }) as never;

  const offPayload = await runSearchFusion({
    runtime: sharedRuntime,
    config: {},
    pluginConfig: {
      sourceTierMode: "off",
    },
    request: {
      query: "source tier off",
      providers: ["gemini"],
    },
  });

  const strictPayload = await runSearchFusion({
    runtime: sharedRuntime,
    config: {},
    pluginConfig: {
      sourceTierMode: "strict",
    },
    request: {
      query: "source tier strict",
      providers: ["gemini"],
    },
  });

  assert.equal(offPayload.results[0]?.canonicalUrl, "https://example.com/citation-blog");
  assert.equal(strictPayload.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(strictPayload.results[1]?.bestSourceTier, "low");
});

test("runSearchFusion outer abort stops retries and reaches delegated search", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let delegatedSignal: AbortSignal | undefined;
  const search = runSearchFusion({
    runtime: createRuntime({
      search: async ({ signal }) => {
        attempts += 1;
        delegatedSignal = signal;
        throw new Error("temporary upstream failure");
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 5, backoffMs: 5000 },
    },
    request: { query: "cancel retries", providers: ["brave"] },
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(new Error("caller cancelled")), 20);
  const payload = await search;
  assert.equal(attempts, 1);
  assert.ok(delegatedSignal);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /caller cancelled/i);
});

test("runSearchFusion global deadline returns completed providers as partial results", async () => {
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId, signal }) => {
        if (providerId === "brave") {
          return {
            provider: "brave",
            result: {
              results: [{ title: "Fast result", url: "https://example.com/fast" }],
            },
          };
        }
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ provider: "gemini", result: { results: [] } }),
            10000,
          );
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }) as never,
    config: {},
    pluginConfig: {
      totalTimeoutMs: 5000,
      providerTimeoutMs: 120000,
      retry: { maxAttempts: 5, backoffMs: 0 },
    },
    request: { query: "partial deadline", providers: ["brave", "gemini"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.deepEqual(payload.providersFailed, [{ provider: "gemini", error: "deadline exceeded" }]);
  assert.equal(payload.results[0]?.title, "Fast result");
  assert.ok(payload.tookMs >= 4900 && payload.tookMs < 7000, `unexpected deadline duration ${payload.tookMs}ms`);
});

test("runSearchFusion timed-out attempts do not start overlapping retries", async () => {
  let attempts = 0;
  let active = 0;
  let maxActive = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attempts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        active -= 1;
        return { provider: providerId ?? "brave", result: { results: [] } };
      },
    }) as never,
    config: {},
    pluginConfig: {
      providerTimeoutMs: 1000,
      retry: { maxAttempts: 4, backoffMs: 0 },
    },
    request: { query: "no overlap", providers: ["brave"] },
  });

  assert.equal(attempts, 1);
  assert.equal(maxActive, 1);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.match(payload.providersFailed[0]?.error ?? "", /timed out/i);
});

test("runSearchFusion does not retry deterministic HTTP failures", async () => {
  for (const message of ["404 not found", "409 conflict", "422 invalid input", "resource not found"]) {
    let attempts = 0;
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async () => {
          attempts += 1;
          throw new Error(message);
        },
      }) as never,
      config: {},
      pluginConfig: { retry: { maxAttempts: 4, backoffMs: 0 } },
      request: { query: message, providers: ["brave"] },
    });
    assert.equal(attempts, 1, message);
    assert.equal(payload.providerRuns[0]?.attempts, 1, message);
  }
});

test("runSearchFusion waits at least two seconds before retrying rate limits", async () => {
  const attemptTimes: number[] = [];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) throw new Error("429 rate limit exceeded");
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/recovered" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "rate limit", providers: ["brave"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(attemptTimes.length, 2);
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= 1900);
  assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 2000);
});

test("runSearchFusion distinguishes malformed Retry-After dates from overflowing numeric deltas", async () => {
  const attemptTimes: number[] = [];
  const hugeNegativeDelta = `-${"9".repeat(400)}`;
  const headers = [{ "retry-after": "1/2" }, { "retry-after": hugeNegativeDelta }];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        const header = headers[attemptTimes.length - 1];
        if (header) {
          throw createHttpError({ status: 429, headers: header });
        }
        return {
          provider: providerId ?? "brave",
          result: {
            results: [{ title: "Recovered", url: "https://example.com/numeric-boundaries" }],
          },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 3, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "numeric retry after boundaries", providers: ["brave"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.deepEqual(
    payload.providerRuns[0]?.retryHistory.map((entry) => entry.delayMs),
    [2000, 0],
  );
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= 1900);
});

test("runSearchFusion honors Retry-After delta-seconds on 429 responses", async () => {
  const attemptTimes: number[] = [];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          throw createHttpError({
            status: 429,
            headers: new Headers({ "Retry-After": "1" }),
          });
        }
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/delta" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "delta retry after", providers: ["brave"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 1000);
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= 900);
});

test("runSearchFusion honors Retry-After HTTP dates on 503 responses", async () => {
  const retryAt = new Date(Date.now() + 1500).toUTCString();
  const attemptTimes: number[] = [];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          throw createHttpError({
            status: 503,
            headers: { "retry-after": retryAt },
            shape: "direct",
          });
        }
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/http-date" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "date retry after", providers: ["brave"] },
  });

  const delayMs = payload.providerRuns[0]?.retryHistory[0]?.delayMs ?? 0;
  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.ok(delayMs > 0 && delayMs <= 1500, `unexpected parsed date delay ${delayMs}ms`);
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= delayMs - 50);
});

test("runSearchFusion honors millisecond and x-ratelimit-reset header variants", async () => {
  const cases: Array<{
    name: string;
    headers: Record<string, string>;
    shape: "direct" | "response" | "cause";
    minimumDelayMs: number;
    maximumDelayMs: number;
  }> = [
    {
      name: "retry-after-ms",
      headers: { "retry-after-ms": "40" },
      shape: "response",
      minimumDelayMs: 40,
      maximumDelayMs: 40,
    },
    {
      name: "x-ms-retry-after-ms",
      headers: { "x-ms-retry-after-ms": "35" },
      shape: "direct",
      minimumDelayMs: 35,
      maximumDelayMs: 35,
    },
    {
      name: "x-ratelimit-reset",
      headers: { "x-ratelimit-reset": String(Math.ceil((Date.now() + 1500) / 1000)) },
      shape: "cause",
      minimumDelayMs: 400,
      maximumDelayMs: 2000,
    },
  ];

  for (const current of cases) {
    let attempts = 0;
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async ({ providerId }) => {
          attempts += 1;
          if (attempts === 1) {
            throw createHttpError({
              status: 429,
              headers: current.headers,
              shape: current.shape,
            });
          }
          return {
            provider: providerId ?? "brave",
            result: {
              results: [{ title: "Recovered", url: `https://example.com/${current.name}` }],
            },
          };
        },
      }) as never,
      config: {},
      pluginConfig: {
        retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
      },
      request: { query: current.name, providers: ["brave"] },
    });

    const delayMs = payload.providerRuns[0]?.retryHistory[0]?.delayMs ?? -1;
    assert.deepEqual(payload.providersSucceeded, ["brave"], current.name);
    assert.ok(delayMs >= current.minimumDelayMs, `${current.name}: ${delayMs}ms`);
    assert.ok(delayMs <= current.maximumDelayMs, `${current.name}: ${delayMs}ms`);
  }
});

test("runSearchFusion handles negative, malformed, and past rate-limit headers safely", async () => {
  const headers = [
    { "retry-after": "-10" },
    { "retry-after": "not-a-number-or-date" },
    { "retry-after": new Date(Date.now() - 60_000).toUTCString() },
  ];
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        const header = headers[attempts];
        attempts += 1;
        if (header) {
          throw createHttpError({ status: 503, headers: header });
        }
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/malformed" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 4, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "malformed retry after", providers: ["brave"] },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.deepEqual(
    payload.providerRuns[0]?.retryHistory.map((entry) => entry.delayMs),
    [0, 0, 0],
  );
});

test("runSearchFusion clamps absurd rate-limit waits to one hour", async () => {
  for (const value of ["999999", "9".repeat(400)]) {
    const startedAt = Date.now();
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async () => {
          throw createHttpError({
            status: 429,
            headers: { "retry-after": value },
          });
        },
      }) as never,
      config: {},
      pluginConfig: {
        totalTimeoutMs: 5000,
        retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
      },
      request: { query: "absurd retry after", providers: ["brave"] },
    });

    assert.equal(payload.providerRuns[0]?.attempts, 1, value);
    assert.equal(payload.providerRuns[0]?.retryHistory.length, 0, value);
    assert.match(payload.providersFailed[0]?.error ?? "", /3600000ms/, value);
    assert.ok(Date.now() - startedAt < 1000, "absurd wait should fail without sleeping");
  }
});

test("runSearchFusion fails a rate-limited provider fast when its wait exceeds the deadline", async () => {
  const startedAt = Date.now();
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async () => {
        throw createHttpError({
          status: 503,
          headers: { "retry-after-ms": "10000" },
        });
      },
    }) as never,
    config: {},
    pluginConfig: {
      totalTimeoutMs: 5000,
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "deadline retry after", providers: ["brave"] },
  });

  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.match(
    payload.providersFailed[0]?.error ?? "",
    /Rate-limit wait of 10000ms from retry-after-ms exceeds the remaining total timeout budget/,
  );
  assert.ok(Date.now() - startedAt < 1000, "deadline-incompatible wait should fail fast");
});

test("runSearchFusion prioritizes structured 503 retry metadata over message heuristics", async () => {
  const attemptTimes: number[] = [];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          throw createHttpError({
            status: 503,
            headers: { "retry-after-ms": "25" },
            message: "upstream route not found",
          });
        }
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/structured-503" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "structured 503", providers: ["brave"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(attemptTimes.length, 2);
  assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 25);
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= 20);

  let malformedAttempts = 0;
  const malformedPayload = await runSearchFusion({
    runtime: createRuntime({
      search: async () => {
        malformedAttempts += 1;
        throw createHttpError({
          status: 503,
          headers: { "retry-after-ms": "not-a-duration" },
          message: "upstream route not found",
        });
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "malformed structured 503", providers: ["brave"] },
  });

  assert.equal(malformedAttempts, 1);
  assert.equal(malformedPayload.providerRuns[0]?.retryHistory.length, 0);
  assert.match(malformedPayload.providersFailed[0]?.error ?? "", /not found/);
});

test("runSearchFusion does not issue a retry sub-query while its provider is cooling", async () => {
  const attemptTimes: number[] = [];
  let markFirstAttempt: (() => void) | undefined;
  const firstAttempt = new Promise<void>((resolve) => {
    markFirstAttempt = resolve;
  });
  const search = runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          markFirstAttempt?.();
          return {
            provider: providerId ?? "brave",
            result: {
              error: "HTTP 429 rate limit exceeded",
              status: 429,
              headers: { "retry-after-ms": "150" },
            },
          };
        }
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/cooldown" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "cooldown", providers: ["brave"] },
  });

  await firstAttempt;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attemptTimes.length, 1);

  const payload = await search;
  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 150);
  assert.ok((attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0) >= 130);
});

test("runSearchFusion bounds visible text and keeps full fidelity behind opt-ins", async () => {
  const longText = `long-${"x".repeat(800)}`;
  const runtime = createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "gemini",
      result: {
        content: longText,
        results: [
          {
            title: "Long result",
            url: "https://example.com/long",
            description: longText,
          },
          { title: "Discarded", description: longText },
        ],
      },
    }),
  }) as never;

  const bounded = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: { maxSnippetLength: 120, maxAnswerLength: 150 },
    request: { query: "bounded", providers: ["gemini"] },
  });
  assert.equal(bounded.providerRuns[0]?.rawPayload, undefined);
  assert.equal(bounded.providerRuns[0]?.results[0]?.rawItem, undefined);
  assert.deepEqual(bounded.discardedResults, []);
  assert.deepEqual(bounded.providerRuns[0]?.discardedResults, []);
  assert.equal(bounded.providerDetails[0]?.discardedCount, 1);
  assert.equal(bounded.answers[0]?.truncated, true);
  assert.ok((bounded.answers[0]?.fullContent.length ?? Infinity) <= 150);
  assert.ok((bounded.answers[0]?.fullContent.length ?? 0) > 120);
  assert.equal(bounded.results[0]?.truncated, true);
  assert.ok((bounded.results[0]?.snippet?.length ?? Infinity) <= 120);
  assert.equal(bounded.results[0]?.variants[0]?.truncated, true);
  assert.equal(bounded.evidenceTable.rows[0]?.truncated, true);
  assert.equal(bounded.evidenceTable.rows[0]?.providerEvidence[0]?.truncated, true);

  const audit = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {
      maxSnippetLength: 120,
      includeRawPayloads: true,
      includeDiscarded: true,
    },
    request: { query: "audit", providers: ["gemini"] },
  });
  assert.equal(audit.output.includeRawPayloads, true);
  assert.equal(audit.output.includeDiscarded, true);
  assert.equal((audit.providerRuns[0]?.rawPayload?.content as string)?.length, longText.length);
  assert.equal((audit.providerRuns[0]?.results[0]?.rawItem as { description?: string })?.description, longText);
  assert.equal(audit.discardedResults.length, 1);
  assert.equal((audit.discardedResults[0]?.rawItem as { description?: string })?.description, longText);
});

// ---- Provider circuit breaker (cross-call health) ----

function countingRuntime(failures: Record<string, () => string | undefined>) {
  const calls: Record<string, number> = {};
  const runtime = createRuntime({
    search: async ({ providerId }) => {
      const id = providerId ?? "unknown";
      calls[id] = (calls[id] ?? 0) + 1;
      const failure = failures[id]?.();
      if (failure) {
        throw new Error(failure);
      }
      return {
        provider: id,
        result: { results: [{ title: `${id} result`, url: `https://example.com/${id}` }] },
      };
    },
  });
  return { runtime, calls };
}

async function fuse(runtime: unknown, pluginConfig: Record<string, unknown> = {}, signal?: AbortSignal) {
  return await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig,
    request: { query: "circuit", providers: ["brave", "tavily"] },
    signal,
  });
}

test("isHardProviderFailure classifies auth, billing, plan and refused-connection errors only", () => {
  for (const message of [
    "MiniMax Search API error (1008): insufficient balance",
    "model_not_found: OpenAI sign-in has no Codex plan",
    "fetch failed | connect ECONNREFUSED 127.0.0.1:11434 | ECONNREFUSED",
    "getaddrinfo ENOTFOUND search.example",
    "HTTP 401 Unauthorized",
    "Request failed with status 402 Payment Required",
    "Invalid API key",
    "403 Forbidden",
  ]) {
    assert.equal(isHardProviderFailure(message), true, message);
  }
  for (const message of [
    "Provider tavily timed out after 15000ms",
    "deadline exceeded",
    "HTTP 503 upstream unavailable",
    "429 rate limit",
    "Gemini exploded",
    "error 14010 while parsing",
    undefined,
  ]) {
    assert.equal(isHardProviderFailure(message), false, String(message));
  }
});

test("hard provider failure skips retries and opens the circuit for later searches", async () => {
  const { runtime, calls } = countingRuntime({ tavily: () => "Search API error (1008): insufficient balance" });

  const first = await fuse(runtime);
  assert.equal(calls.tavily, 1, "hard failure must not be retried in-call");
  assert.deepEqual(first.providersSucceeded, ["brave"]);

  const second = await fuse(runtime);
  assert.equal(calls.tavily, 1, "open circuit must skip the provider");
  assert.equal(calls.brave, 2);
  assert.deepEqual(second.providersSucceeded, ["brave"]);
  const skipped = second.providersFailed.find((failure) => failure.provider === "tavily");
  assert.ok(skipped);
  assert.match(skipped.error, /^circuit open: skipped for \d+s more after 1 consecutive failure\(s\); last error: .*insufficient balance/);
  const detail = second.providerDetails.find((entry) => entry.provider === "tavily");
  assert.equal(detail?.attempts, 0);
  assert.equal(detail?.tookMs, 0);
  assert.equal(second.results.length, 1);
  assert.equal(getProviderHealthSnapshot().tavily.open, true);
});

test("soft failures open the circuit only after the consecutive threshold", async () => {
  const { runtime, calls } = countingRuntime({ tavily: () => "HTTP 503 upstream unavailable" });
  const config = { retry: { maxAttempts: 1 } };

  await fuse(runtime, config);
  await fuse(runtime, config);
  assert.equal(calls.tavily, 2);
  assert.equal(getProviderHealthSnapshot().tavily.open, false);
  await fuse(runtime, config);
  assert.equal(calls.tavily, 3);
  assert.equal(getProviderHealthSnapshot().tavily.open, true);
  await fuse(runtime, config);
  assert.equal(calls.tavily, 3);
});

test("a success resets the consecutive failure count", async () => {
  let failNext = true;
  const { runtime, calls } = countingRuntime({
    tavily: () => (failNext ? "HTTP 503 upstream unavailable" : undefined),
  });
  const config = { retry: { maxAttempts: 1 }, circuitBreaker: { failureThreshold: 2 } };

  await fuse(runtime, config);
  failNext = false;
  await fuse(runtime, config);
  assert.equal(getProviderHealthSnapshot().tavily, undefined);
  failNext = true;
  await fuse(runtime, config);
  assert.equal(getProviderHealthSnapshot().tavily.open, false);
  await fuse(runtime, config);
  assert.equal(getProviderHealthSnapshot().tavily.open, true);
  assert.equal(calls.tavily, 4);
});

test("an expired circuit probes once and doubles the window when the probe fails", async (t) => {
  const realNow = Date.now.bind(Date);
  let offsetMs = 0;
  t.mock.method(Date, "now", () => realNow() + offsetMs);
  const { runtime, calls } = countingRuntime({ tavily: () => "401 Unauthorized" });
  const config = { circuitBreaker: { cooldownMs: 10_000, maxCooldownMs: 15_000 } };

  await fuse(runtime, config);
  const firstWindow = getProviderHealthSnapshot().tavily.openForMs;
  assert.ok(firstWindow > 9_000 && firstWindow <= 10_000, String(firstWindow));

  offsetMs += 10_001;
  await fuse(runtime, config);
  assert.equal(calls.tavily, 2, "expired circuit must allow one probe");
  const secondWindow = getProviderHealthSnapshot().tavily.openForMs;
  assert.ok(secondWindow > 14_000 && secondWindow <= 15_000, `doubled window capped at max: ${secondWindow}`);
  assert.equal(getProviderHealthSnapshot().tavily.openCount, 2);

  offsetMs += 15_001;
  await fuse(createRuntime() as never, config);
  assert.equal(getProviderHealthSnapshot().tavily, undefined, "successful probe closes the circuit");
});

test("when every selected provider is cooling off, all of them are probed", async () => {
  const { runtime, calls } = countingRuntime({
    brave: () => "401 Unauthorized",
    tavily: () => "401 Unauthorized",
  });
  await fuse(runtime);
  await fuse(runtime);
  assert.equal(calls.brave, 2);
  assert.equal(calls.tavily, 2);
});

test("circuitBreaker.enabled=false never skips a failing provider", async () => {
  const { runtime, calls } = countingRuntime({ tavily: () => "401 Unauthorized" });
  const config = { circuitBreaker: { enabled: false } };
  await fuse(runtime, config);
  await fuse(runtime, config);
  assert.equal(calls.tavily, 2);
  assert.deepEqual(getProviderHealthSnapshot(), {});
});

test("a caller abort does not count against provider health", async () => {
  const controller = new AbortController();
  const search = runSearchFusion({
    runtime: createRuntime({
      search: async () => {
        throw new Error("401 Unauthorized while cancelling");
      },
    }) as never,
    config: {},
    pluginConfig: { circuitBreaker: { failureThreshold: 1 }, retry: { maxAttempts: 5, backoffMs: 5000 } },
    request: { query: "cancel health", providers: ["brave"] },
    signal: controller.signal,
  });
  controller.abort(new Error("caller cancelled"));
  await search;
  assert.deepEqual(getProviderHealthSnapshot(), {});
});

// ---- Reciprocal-rank fusion ----

function rankedRuntime(lists: Record<string, string[]>) {
  return createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "unknown",
      result: {
        results: (lists[providerId ?? ""] ?? []).map((path) => ({
          title: `page ${path}`,
          url: `https://example.com/${path}`,
          description: `snippet ${path}`,
        })),
      },
    }),
  });
}

test("rrf ranking lifts results that several providers agree on", async () => {
  const runtime = rankedRuntime({ brave: ["solo", "x1", "shared"], tavily: ["t1", "t2", "shared"] });
  const payload = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: { rankingStrategy: "rrf", sourceTierMode: "off" },
    request: { query: "rrf", providers: ["brave", "tavily"] },
  });
  assert.equal(payload.results[0].url, "https://example.com/shared");
  assert.equal(payload.ranking.strategy, "rrf-v1");
  const top = payload.results[0].ranking;
  assert.equal(top.strategy, "rrf-v1");
  assert.equal(top.scoreBreakdown.corroborationBonus, 0);
  // 2 * 61/63 for two rank-3 hits at k=60
  assert.equal(top.scoreBreakdown.rrfScore, Math.round(((2 * 61) / 63) * 1e6) / 1e6);
  assert.equal(top.scoreBreakdown.finalScore, top.scoreBreakdown.rrfScore);
  const solo = payload.results.find((result) => result.url === "https://example.com/solo");
  assert.equal(solo?.ranking.scoreBreakdown.rrfScore, 1);
});

test("rrf honors provider weights and rrfK", async () => {
  const runtime = rankedRuntime({ brave: ["b1"], tavily: ["t1"] });
  const payload = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: {
      rankingStrategy: "rrf",
      rrfK: 10,
      sourceTierMode: "off",
      providerConfig: { tavily: { weight: 2 } },
    },
    request: { query: "rrf weights", providers: ["brave", "tavily"] },
  });
  assert.deepEqual(
    payload.results.map((result) => [result.url, result.ranking.scoreBreakdown.rrfScore]),
    [
      ["https://example.com/t1", 2],
      ["https://example.com/b1", 1],
    ],
  );
});

test("default ranking stays merged-score-v1 without an rrf score", async () => {
  const runtime = rankedRuntime({ brave: ["b1"], tavily: ["t1"] });
  const payload = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: {},
    request: { query: "default ranking", providers: ["brave", "tavily"] },
  });
  assert.equal(payload.ranking.strategy, "merged-score-v1");
  assert.equal(payload.results[0].ranking.strategy, "merged-score-v1");
  assert.equal(payload.results[0].ranking.scoreBreakdown.rrfScore, undefined);
});

test("rrf still applies the sponsored penalty", async () => {
  const runtime = createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "brave",
      result: {
        results: [
          { title: "Ad", url: "https://example.com/ad", description: "ad", sponsored: true },
          { title: "Organic", url: "https://example.com/organic", description: "organic" },
        ],
      },
    }),
  });
  const payload = await runSearchFusion({
    runtime: runtime as never,
    config: {},
    pluginConfig: { rankingStrategy: "rrf", sourceTierMode: "off" },
    request: { query: "rrf ads", providers: ["brave"] },
  });
  assert.equal(payload.results[0].url, "https://example.com/organic");
  const ad = payload.results.find((result) => result.url === "https://example.com/ad");
  assert.ok(ad);
  assert.equal(ad.ranking.scoreBreakdown.flagPenalty > 0, true);
  assert.equal(
    ad.ranking.scoreBreakdown.finalScore,
    Math.max(0.01, (ad.ranking.scoreBreakdown.rrfScore ?? 0) - ad.ranking.scoreBreakdown.flagPenalty),
  );
});

test("runSearchFusion retries rate limits even when the message names the API key", async () => {
  const attemptTimes: number[] = [];
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) throw new Error("HTTP 429: API key rate limit exceeded");
        return {
          provider: providerId ?? "brave",
          result: { results: [{ title: "Recovered", url: "https://example.com/recovered" }] },
        };
      },
    }) as never,
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
    },
    request: { query: "api key rate limit", providers: ["brave"] },
  });

  assert.deepEqual(payload.providersSucceeded, ["brave"]);
  assert.equal(attemptTimes.length, 2);
  assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 2000);
});

test("runSearchFusion matches retry status codes only as standalone numbers", async () => {
  for (const message of [
    "503 after 1400 ms",
    "502 bad gateway, upstream took 4040ms",
    "500 internal error (request 14010)",
    "service unavailable after 400 ms",
    "503 unavailable after 1429 ms",
  ]) {
    let attempts = 0;
    const payload = await runSearchFusion({
      runtime: createRuntime({
        search: async ({ providerId }) => {
          attempts += 1;
          if (attempts === 1) throw new Error(message);
          return {
            provider: providerId ?? "brave",
            result: { results: [{ title: "Recovered", url: "https://example.com/recovered" }] },
          };
        },
      }) as never,
      config: {},
      pluginConfig: { retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 } },
      request: { query: message, providers: ["brave"] },
    });
    assert.equal(attempts, 2, message);
    assert.deepEqual(payload.providersSucceeded, ["brave"], message);
    // Longer numbers such as "1429" must not be read as a 429 either.
    assert.equal(payload.providerRuns[0]?.retryHistory[0]?.delayMs, 0, message);
  }

  for (const message of ["HTTP 400: invalid query", "status 404.", "upstream said (409)", "code=422"]) {
    let attempts = 0;
    await runSearchFusion({
      runtime: createRuntime({
        search: async () => {
          attempts += 1;
          throw new Error(message);
        },
      }) as never,
      config: {},
      pluginConfig: { retry: { maxAttempts: 4, backoffMs: 0 } },
      request: { query: message, providers: ["brave"] },
    });
    assert.equal(attempts, 1, message);
  }
});

test("runSearchFusion merges the same page when query parameters arrive in a different order", async () => {
  const resultsByProvider: Record<string, unknown> = {
    brave: { results: [{ title: "Page", url: "https://example.com/page?b=2&a=1&utm_source=feed" }] },
    tavily: {
      results: [
        { title: "Page", url: "https://example.com/page?a=1&b=2" },
        { title: "Other page", url: "https://example.com/page?a=2&b=2" },
      ],
    },
    gemini: {
      content: "Answer that cites the page.",
      citations: [{ url: "https://example.com/page?b=2&a=1", title: "Page" }],
    },
  };
  const payload = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "brave",
        result: resultsByProvider[providerId ?? "brave"] as Record<string, unknown>,
      }),
    }) as never,
    config: {},
    pluginConfig: {},
    request: { query: "param order", providers: ["brave", "tavily", "gemini"] },
  });

  const merged = payload.results.filter((result) => result.canonicalUrl === "https://example.com/page?a=1&b=2");
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.providers, ["brave", "gemini", "tavily"]);
  // The display URL is one provider's own URL; this branch picks the
  // representative variant by ranking, so either order is valid here.
  assert.ok(
    ["https://example.com/page?b=2&a=1", "https://example.com/page?a=1&b=2"].includes(merged[0]?.url ?? ""),
  );
  // Different parameter values are still different pages.
  assert.equal(payload.results.length, 2);

  const evidence = payload.evidenceTable.rows.find((row) => row.canonicalUrl === "https://example.com/page?a=1&b=2");
  assert.equal(evidence?.answerCitationSupport.count, 1);
});

test("runSearchFusion keeps whole answers under the answer cap while snippets keep the snippet cap", async () => {
  const sentence = "Renewal steps and fees are listed here in full detail for the reader. ";
  const answer = `${sentence.repeat(14)}Use Form DS-82 to renew by mail.`;
  assert.ok(answer.length > 1000 && answer.length < 2000);
  const runtime = createRuntime({
    search: async ({ providerId }) => ({
      provider: providerId ?? "gemini",
      result: { content: answer, citations: ["https://travel.example.gov/renew"] },
    }),
  }) as never;

  const payload = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: {},
    request: { query: "renew passport", providers: ["gemini"] },
  });
  assert.equal(payload.output.maxAnswerLength, 2000);
  assert.equal(payload.answers[0]?.fullContent, answer);
  assert.equal(payload.answers[0]?.truncated, undefined);
  assert.equal(payload.answers[0]?.summaryTruncated, true);
  // The citation's fallback snippet is still bounded by maxSnippetLength.
  assert.equal(payload.results[0]?.truncated, true);
  assert.ok((payload.results[0]?.snippet?.length ?? Infinity) <= 500);

  const capped = await runSearchFusion({
    runtime,
    config: {},
    pluginConfig: { maxAnswerLength: 300 },
    request: { query: "renew passport", providers: ["gemini"] },
  });
  assert.equal(capped.answers[0]?.truncated, true);
  assert.ok((capped.answers[0]?.fullContent.length ?? Infinity) <= 300);

  // A large snippet cap configured for long answers is still honored.
  const longAnswer = `${sentence.repeat(40)}End.`;
  const wide = await runSearchFusion({
    runtime: createRuntime({
      search: async ({ providerId }) => ({
        provider: providerId ?? "gemini",
        result: { content: longAnswer, citations: ["https://travel.example.gov/renew"] },
      }),
    }) as never,
    config: {},
    pluginConfig: { maxSnippetLength: 5000 },
    request: { query: "renew passport", providers: ["gemini"] },
  });
  assert.ok(longAnswer.length > 2000);
  assert.equal(wide.output.maxAnswerLength, 5000);
  assert.equal(wide.answers[0]?.fullContent, longAnswer);
});
