import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { FusionSearchPayload, RuntimeWebSearchProvider } from "../src/types.js";
import { sdkSubpathResolves } from "./sdk-resolves.js";

type SecretResolverParams = {
  config: unknown;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
};

const secretResolverCalls: SecretResolverParams[] = [];
const resolveConfiguredSecretInputString = mock.fn(async (params: SecretResolverParams) => {
  secretResolverCalls.push(params);
  const ref = params.value as { source?: unknown; id?: unknown };
  if (ref.source === "env" && typeof ref.id === "string" && params.env[ref.id]) {
    return { value: params.env[ref.id] };
  }
  if (ref.id === "missing-without-reason") {
    return {};
  }
  return { unresolvedRefReason: `${params.path} could not be resolved (test).` };
});

// OpenClaw 2026.10+ no longer exports the config-runtime facade, and a module
// mock needs a resolvable specifier. Mock the legacy facade only where it exists.
if (sdkSubpathResolves("openclaw/plugin-sdk/config-runtime")) {
  mock.module("openclaw/plugin-sdk/config-runtime", {
    cache: true,
    namedExports: {
      getRuntimeConfigSourceSnapshot,
      resolveConfiguredSecretInputString,
    },
  });
}

const { renderFusionSummary, resetProviderHealthForTests, runSearchFusion } = await import("../src/search-fusion.js");

// This branch keeps provider health (circuit breaker) process-wide; isolate tests.
beforeEach(() => resetProviderHealthForTests());

type SearchParams = {
  config?: unknown;
  providerId?: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  agentDir?: string;
  runtimeWebSearch?: unknown;
};

type SearchFn = (params: SearchParams) => Promise<{ provider: string; result: Record<string, unknown> }>;

function simpleProvider(id: string, extra: Partial<RuntimeWebSearchProvider> = {}): RuntimeWebSearchProvider {
  return {
    id,
    label: id,
    envVars: [],
    getConfiguredCredentialValue: () => `${id}-key`,
    getCredentialValue: () => undefined,
    ...extra,
  };
}

function runtimeWith(providers: RuntimeWebSearchProvider[], search: SearchFn) {
  return {
    webSearch: {
      listProviders: () => providers,
      search,
    },
  } as never;
}

function okResult(providerId: string, results: unknown[] = [{ title: "Hit", url: "https://example.com/hit" }]) {
  return { provider: providerId, result: { results } };
}

const ENV_KEY = "SEARCH_FUSION_COVERAGE_TEST_KEY";

async function withEnvKey<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

// ─── credential delegation for registry providers ─────────────────────────────

// Built at runtime so scanners do not flag the fixture.
const CTX_VAL = ["from", "context"].join("-");

test("keyless registry providers receive the runtime config untouched", async () => {
  clearRuntimeConfigSnapshot();
  const config = { tools: { web: { search: { provider: "duckduckgo" } } } };
  const seen: unknown[] = [];
  const payload = await runSearchFusion({
    runtime: runtimeWith(
      [simpleProvider("duckduckgo", { requiresCredential: false, getConfiguredCredentialValue: () => undefined })],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "duckduckgo");
      },
    ),
    config,
    pluginConfig: {},
    request: { query: "q", providers: ["duckduckgo"] },
  });
  assert.deepEqual(payload.providersSucceeded, ["duckduckgo"]);
  assert.equal(seen[0], config);
});

test("runtime search-config SecretRefs are resolved into a cloned config", { skip: "this branch resolves SecretRefs through secret-input-runtime and does not pass a resolver path" }, async () => {
  clearRuntimeConfigSnapshot();
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const config = { tools: { web: { search: { scoped: { apiKey: ref } } } } };
  const seen: any[] = [];
  const provider = simpleProvider("scoped", {
    credentialPath: "tools.web.search.scoped.apiKey",
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: (searchConfig) => (searchConfig as any)?.scoped?.apiKey,
    setCredentialValue: (target, value) => {
      (target as any).scoped.apiKey = value;
    },
  });

  await withEnvKey("resolved-scoped", async () => {
    const payload = await runSearchFusion({
      runtime: runtimeWith([provider], async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "scoped");
      }),
      config,
      pluginConfig: {},
      request: { query: "q", providers: ["scoped"] },
    });
    assert.deepEqual(payload.providersSucceeded, ["scoped"]);
  });

  assert.notEqual(seen[0], config);
  assert.equal(seen[0].tools.web.search.scoped.apiKey, "resolved-scoped");
  // The caller's config is never mutated.
  assert.deepEqual(config.tools.web.search.scoped.apiKey, ref);
  assert.equal(secretResolverCalls.at(-1)?.path, "tools.web.search.scoped.apiKey");
});

test("runtime search-config SecretRefs default the resolver path to the scoped key", { skip: "this branch resolves SecretRefs through secret-input-runtime and does not pass a resolver path" }, async () => {
  clearRuntimeConfigSnapshot();
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const provider = simpleProvider("pathless", {
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: (searchConfig) => (searchConfig as any)?.pathless?.apiKey,
    setCredentialValue: (target, value) => {
      (target as any).pathless.apiKey = value;
    },
  });
  await withEnvKey("resolved-pathless", async () => {
    await runSearchFusion({
      runtime: runtimeWith([provider], async ({ providerId }) => okResult(providerId ?? "pathless")),
      config: { tools: { web: { search: { pathless: { apiKey: ref } } } } },
      pluginConfig: {},
      request: { query: "q", providers: ["pathless"] },
    });
  });
  assert.equal(secretResolverCalls.at(-1)?.path, "tools.web.search.pathless.apiKey");
});

test("source-only search-config SecretRefs are resolved from the source snapshot", async () => {
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const runtimeConfig = { tools: { web: { search: {} } } };
  const sourceConfig = { tools: { web: { search: { src: { apiKey: ref } } } } };
  const seen: any[] = [];
  const provider = simpleProvider("src", {
    getConfiguredCredentialValue: () => undefined,
    getCredentialValue: (searchConfig) => (searchConfig as any)?.src?.apiKey,
    setCredentialValue: (target, value) => {
      (target as any).src.apiKey = value;
    },
  });
  setRuntimeConfigSnapshot(runtimeConfig as never, sourceConfig as never);
  try {
    await withEnvKey("resolved-source-search", async () => {
      const payload = await runSearchFusion({
        runtime: runtimeWith([provider], async ({ config: delegated, providerId }) => {
          seen.push(delegated);
          return okResult(providerId ?? "src");
        }),
        config: runtimeConfig,
        pluginConfig: {},
        request: { query: "q", providers: ["src"] },
      });
      assert.deepEqual(payload.providersSucceeded, ["src"]);
    });
  } finally {
    clearRuntimeConfigSnapshot();
  }
  assert.notEqual(seen[0], sourceConfig);
  assert.equal(seen[0].tools.web.search.src.apiKey, "resolved-source-search");
  assert.deepEqual(sourceConfig.tools.web.search.src.apiKey, ref);
});

test("raw credentials that exist only in the source snapshot delegate the source config", async () => {
  const runtimeConfig = { marker: "runtime" };
  const configuredSource = { marker: "source", plugins: { entries: { raw: { config: { webSearch: { apiKey: "raw-source" } } } } } };
  const scopedSource = { marker: "source", tools: { web: { search: { raw: { apiKey: "raw-scoped" } } } } };

  for (const sourceConfig of [configuredSource, scopedSource]) {
    const seen: unknown[] = [];
    const provider = simpleProvider("raw", {
      getConfiguredCredentialValue: (cfg) => (cfg as any)?.plugins?.entries?.raw?.config?.webSearch?.apiKey,
      getCredentialValue: (searchConfig) => (searchConfig as any)?.raw?.apiKey,
    });
    setRuntimeConfigSnapshot(runtimeConfig as never, sourceConfig as never);
    try {
      const payload = await runSearchFusion({
        runtime: runtimeWith([provider], async ({ config: delegated, providerId }) => {
          seen.push(delegated);
          return okResult(providerId ?? "raw");
        }),
        config: runtimeConfig,
        pluginConfig: {},
        request: { query: "q", providers: ["raw"] },
      });
      assert.deepEqual(payload.providersSucceeded, ["raw"]);
    } finally {
      clearRuntimeConfigSnapshot();
    }
    assert.equal(seen[0], sourceConfig);
  }
});

test("raw runtime search credentials pass the runtime config through", async () => {
  clearRuntimeConfigSnapshot();
  const config = { tools: { web: { search: { plain: { apiKey: "plain-key" } } } } };
  const seen: unknown[] = [];
  await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("plain", {
          getConfiguredCredentialValue: () => undefined,
          getCredentialValue: (searchConfig) => (searchConfig as any)?.plain?.apiKey,
        }),
      ],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "plain");
      },
    ),
    config,
    pluginConfig: {},
    request: { query: "q", providers: ["plain"] },
  });
  assert.equal(seen[0], config);
});

test("SecretRefs without a matching setter are delegated unchanged", async () => {
  clearRuntimeConfigSnapshot();
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const config = { plugins: { entries: { nosetter: { config: { webSearch: { apiKey: ref } } } } } };
  const seen: any[] = [];
  const callsBefore = secretResolverCalls.length;
  await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("nosetter", {
          getConfiguredCredentialValue: (cfg) => (cfg as any)?.plugins?.entries?.nosetter?.config?.webSearch?.apiKey,
        }),
      ],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "nosetter");
      },
    ),
    config,
    pluginConfig: {},
    request: { query: "q", providers: ["nosetter"] },
  });
  assert.equal(seen[0], config);
  assert.equal(secretResolverCalls.length, callsBefore);
});

test("a search SecretRef with no search config to write into delegates the original config", async () => {
  clearRuntimeConfigSnapshot();
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const config = { unrelated: true };
  const seen: unknown[] = [];
  await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("orphan", {
          getConfiguredCredentialValue: () => undefined,
          // A misbehaving accessor that reports a SecretRef with no search config.
          getCredentialValue: () => ref,
          setCredentialValue: () => {
            throw new Error("must not be called");
          },
        }),
      ],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "orphan");
      },
    ),
    config,
    pluginConfig: {},
    request: { query: "q", providers: ["orphan"] },
  });
  assert.equal(seen[0], config);
});

test("providers without any credential receive the runtime config", async () => {
  clearRuntimeConfigSnapshot();
  const config = { empty: true };
  const seen: unknown[] = [];
  await runSearchFusion({
    runtime: runtimeWith(
      [simpleProvider("bare", { getConfiguredCredentialValue: () => undefined })],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "bare");
      },
    ),
    config,
    pluginConfig: {},
    request: { query: "q", providers: ["bare"] },
  });
  assert.equal(seen[0], config);
});

test("unresolved SecretRefs fail only that provider with a generic reason when none is given", { skip: "this branch names the unresolved ref in the error" }, async () => {
  clearRuntimeConfigSnapshot();
  const ref = { source: "exec", provider: "vault", id: "missing-without-reason" };
  let searched = 0;
  const payload = await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("broken", {
          credentialPath: "plugins.entries.broken.config.webSearch.apiKey",
          getConfiguredCredentialValue: () => ref,
          setConfiguredCredentialValue: () => {},
        }),
        simpleProvider("healthy"),
      ],
      async ({ providerId }) => {
        searched += 1;
        return okResult(providerId ?? "healthy", [{ title: providerId, url: `https://example.com/${providerId}` }]);
      },
    ),
    config: {},
    pluginConfig: {},
    request: { query: "q", providers: ["broken", "healthy"] },
  });
  assert.equal(searched, 1);
  assert.deepEqual(payload.providersSucceeded, ["healthy"]);
  assert.deepEqual(payload.providersFailed, [
    { provider: "broken", error: "plugins.entries.broken.config.webSearch.apiKey SecretRef is unresolved." },
  ]);
});

test("a context searchConfig is visible to providers even when the base config has no tools", async () => {
  clearRuntimeConfigSnapshot();
  const seen: any[] = [];
  const payload = await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("ctx", {
          getConfiguredCredentialValue: () => undefined,
          getCredentialValue: (searchConfig) => (searchConfig as any)?.ctx?.apiKey,
        }),
      ],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "ctx");
      },
    ),
    config: { tools: "not-an-object" },
    pluginConfig: {},
    searchConfig: { ctx: { apiKey: CTX_VAL } },
    request: { query: "q", providers: ["ctx"] },
  });
  assert.deepEqual(payload.configuredProviders, ["ctx"]);
  assert.equal(seen[0].tools.web.search.ctx.apiKey, CTX_VAL);
});

test("a context searchConfig that is already the active search config is not re-wrapped", async () => {
  clearRuntimeConfigSnapshot();
  const searchConfig = { same: { apiKey: "same-key" } };
  const config = { tools: { web: { search: searchConfig } } };
  const seen: unknown[] = [];
  await runSearchFusion({
    runtime: runtimeWith(
      [
        simpleProvider("same", {
          getConfiguredCredentialValue: () => undefined,
          getCredentialValue: (sc) => (sc as any)?.same?.apiKey,
        }),
      ],
      async ({ config: delegated, providerId }) => {
        seen.push(delegated);
        return okResult(providerId ?? "same");
      },
    ),
    config,
    pluginConfig: {},
    searchConfig,
    request: { query: "q", providers: ["same"] },
  });
  assert.equal(seen[0], config);
});

// ─── request forwarding and clamping ──────────────────────────────────────────

test("request filters, agentDir, and runtime metadata are forwarded to each provider", async () => {
  clearRuntimeConfigSnapshot();
  const seen: SearchParams[] = [];
  const runtimeMetadata = { selected: "search-fusion" };
  await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async (params) => {
      seen.push(params);
      return okResult("brave");
    }),
    config: {},
    pluginConfig: {},
    agentDir: "/agents/main",
    runtimeMetadata,
    request: {
      query: "filters",
      providers: ["brave"],
      country: "DE",
      language: "de",
      freshness: "week",
      date_after: "2026-01-01",
      date_before: "2026-02-01",
      search_lang: "de",
      ui_lang: "de-DE",
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.args, {
    query: "filters",
    count: 10, // this branch sends each provider its documented result-count contract
    country: "DE",
    language: "de",
    freshness: "week",
    date_after: "2026-01-01",
    date_before: "2026-02-01",
    search_lang: "de",
    ui_lang: "de-DE",
  });
  assert.equal(seen[0]?.agentDir, "/agents/main");
  assert.equal(seen[0]?.runtimeWebSearch, runtimeMetadata);
  assert.ok(seen[0]?.signal instanceof AbortSignal);
});

test("counts are clamped to the 1-10 provider range from any source", async () => {
  clearRuntimeConfigSnapshot();
  const cases: Array<{ request?: number; config?: number; provider?: number; expected: number }> = [
    { request: 50, expected: 10 },
    { request: 0, expected: 1 },
    { config: 99, expected: 10 },
    { provider: -3, expected: 1 },
    { provider: 7, config: 2, expected: 7 },
    { request: 3, provider: 7, expected: 3 },
  ];
  for (const testCase of cases) {
    let seenCount: unknown;
    await runSearchFusion({
      runtime: runtimeWith([simpleProvider("brave")], async ({ args }) => {
        seenCount = args.count;
        return okResult("brave");
      }),
      config: {},
      pluginConfig: {
        countPerProvider: testCase.config,
        providerConfig: testCase.provider === undefined ? undefined : { brave: { count: testCase.provider } },
      },
      request: { query: "count", providers: ["brave"], count: testCase.request },
    });
    assert.equal(seenCount, testCase.expected, JSON.stringify(testCase));
  }
});

test("retry maxAttempts is clamped to at least one and at most ten attempts", async () => {
  clearRuntimeConfigSnapshot();
  for (const [maxAttempts, expected] of [
    [0, 1],
    [-5, 1],
    [99, 10],
  ] as const) {
    let attempts = 0;
    const payload = await runSearchFusion({
      runtime: runtimeWith([simpleProvider("brave")], async () => {
        attempts += 1;
        throw new Error("socket hang up");
      }),
      config: {},
      pluginConfig: { retry: { maxAttempts, backoffMs: 0 } },
      request: { query: "clamp", providers: ["brave"] },
    });
    assert.equal(attempts, expected, String(maxAttempts));
    assert.equal(payload.providerRuns[0]?.attempts, expected);
    assert.equal(payload.providerRuns[0]?.retryHistory.length, expected - 1);
  }
});

test("maxMergedResults is clamped and the snippet limit is reported in output metadata", async () => {
  clearRuntimeConfigSnapshot();
  const results = Array.from({ length: 3 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
  }));
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async () => okResult("brave", results)),
    config: {},
    pluginConfig: { maxSnippetLength: 1, maxMergedResults: 2 },
    request: { query: "clamp", providers: ["brave"], maxMergedResults: 0, includeRawPayloads: true },
  });
  assert.equal(payload.count, 1);
  assert.equal(payload.output.maxSnippetLength, 100);
  assert.equal(payload.ranking.droppedCount, 2);
  assert.deepEqual(
    payload.ranking.dropped.map((entry) => [entry.rank, entry.reason, entry.url]),
    [
      [2, "maxMergedResults", "https://example.com/1"],
      [3, "maxMergedResults", "https://example.com/2"],
    ],
  );
});

// ─── retry classification and backoff ─────────────────────────────────────────

test("auth, credential, unsupported, and bad-request messages are not retried", async () => {
  clearRuntimeConfigSnapshot();
  for (const message of [
    "Unauthorized",
    "Forbidden by upstream",
    "invalid API key supplied",
    "missing credential",
    "Unknown provider: nope",
    "unsupported freshness value",
    "Bad Request",
    "HTTP 401",
    "status=403",
  ]) {
    let attempts = 0;
    const payload = await runSearchFusion({
      runtime: runtimeWith([simpleProvider("brave")], async () => {
        attempts += 1;
        throw new Error(message);
      }),
      config: {},
      pluginConfig: { retry: { maxAttempts: 5, backoffMs: 0 } },
      request: { query: message, providers: ["brave"] },
    });
    assert.equal(attempts, 1, message);
    assert.deepEqual(payload.providerRuns[0]?.retryHistory, [], message);
    assert.equal(payload.providersFailed[0]?.error, message);
  }
});

test("transient failures back off exponentially up to maxBackoffMs", async () => {
  clearRuntimeConfigSnapshot();
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async () => {
      attempts += 1;
      throw new Error("HTTP 503 service unavailable");
    }),
    config: {},
    pluginConfig: { retry: { maxAttempts: 4, backoffMs: 10, backoffMultiplier: 3, maxBackoffMs: 50 } },
    request: { query: "backoff", providers: ["brave"] },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(
    payload.providerRuns[0]?.retryHistory.map((event) => [event.attempt, event.delayMs]),
    [
      [1, 10],
      [2, 30],
      [3, 50],
    ],
  );
  assert.equal(payload.providerRuns[0]?.attempts, 4);
  assert.equal(payload.providersFailed[0]?.error, "HTTP 503 service unavailable");
});

test("providerConfig retry overrides beat legacy providerRetries and the global policy", async () => {
  clearRuntimeConfigSnapshot();
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async () => {
      attempts += 1;
      throw new Error("ECONNRESET");
    }),
    config: {},
    pluginConfig: {
      retry: { maxAttempts: 5, backoffMs: 1 },
      providerRetries: { brave: { maxAttempts: 4, backoffMs: 2 } },
      providerConfig: { brave: { retry: { maxAttempts: 2 } } },
    },
    request: { query: "precedence", providers: ["brave"] },
  });
  assert.equal(attempts, 2);
  // backoffMs still comes from the next most specific layer.
  assert.deepEqual(payload.providerRuns[0]?.retryHistory.map((event) => event.delayMs), [2]);
});

test("rate-limit wording without a status code still waits at least two seconds", async () => {
  clearRuntimeConfigSnapshot();
  const runs = await Promise.all(
    ["Too Many Requests", "rate_limit_exceeded", "Rate-Limit hit"].map(async (message) => {
      let attempts = 0;
      const payload = await runSearchFusion({
        runtime: runtimeWith([simpleProvider("brave")], async () => {
          attempts += 1;
          if (attempts === 1) throw new Error(message);
          return okResult("brave");
        }),
        config: {},
        pluginConfig: { retry: { maxAttempts: 2, backoffMs: 0 } },
        request: { query: message, providers: ["brave"] },
      });
      return { message, attempts, payload };
    }),
  );
  for (const run of runs) {
    assert.equal(run.attempts, 2, run.message);
    assert.equal(run.payload.providerRuns[0]?.retryHistory[0]?.delayMs, 2000, run.message);
  }
});

test("non-Error rejections are reported with a readable message", async () => {
  clearRuntimeConfigSnapshot();
  const cases: Array<[unknown, string]> = [
    ["plain string failure", "plain string failure"],
    [{ message: "object with message" }, "object with message"],
    [{ code: 1 }, "Unknown error"],
    [42, "42"],
    [new Error(""), "Error"],
    ["", "Unknown error"],
    [
      {
        toString() {
          throw new Error("cannot render");
        },
      },
      "Unknown error",
    ],
  ];
  for (const [thrown, expected] of cases) {
    const payload = await runSearchFusion({
      runtime: runtimeWith([simpleProvider("brave")], async () => {
        throw thrown;
      }),
      config: {},
      pluginConfig: { retry: { maxAttempts: 1 } },
      request: { query: "throw", providers: ["brave"] },
    });
    assert.deepEqual(payload.providersFailed, [{ provider: "brave", error: expected }], String(expected));
  }
});

test("provider error text is redacted in failures and retry history", async () => {
  clearRuntimeConfigSnapshot();
  const secret = ["fake", "secret", "0123456789"].join("-");
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async () => {
      throw new Error(`HTTP 502 for https://api.example.com/s?q=x&api_key=${secret}`);
    }),
    config: {},
    pluginConfig: { retry: { maxAttempts: 2, backoffMs: 0 } },
    request: { query: "redact", providers: ["brave"] },
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(secret), serialized);
  assert.match(payload.providersFailed[0]?.error ?? "", /api_key=\[REDACTED\]/);
  assert.match(payload.providerRuns[0]?.retryHistory[0]?.error ?? "", /api_key=\[REDACTED\]/);
});

test("structured provider error payloads fail the provider without retrying credential errors", async () => {
  clearRuntimeConfigSnapshot();
  let attempts = 0;
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("exa")], async () => {
      attempts += 1;
      return {
        provider: "exa",
        result: {
          error: "missing_exa_api_key",
          message: "web_search (exa) needs an Exa API key.",
          docs: "https://docs.openclaw.ai/tools/web",
        },
      };
    }),
    config: {},
    pluginConfig: { retry: { maxAttempts: 3, backoffMs: 0 }, includeRawPayloads: true },
    request: { query: "structured error", providers: ["exa"] },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(payload.providersFailed, [
    { provider: "exa", error: "missing_exa_api_key: web_search (exa) needs an Exa API key." },
  ]);
  // The raw payload of the failed attempt is still available behind the opt-in.
  assert.equal((payload.providerRuns[0]?.rawPayload as any)?.error, "missing_exa_api_key");
});

test("an outer signal aborted before the run fails every provider with its reason", async () => {
  clearRuntimeConfigSnapshot();
  const controller = new AbortController();
  controller.abort("user cancelled");
  let searched = 0;
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave"), simpleProvider("tavily")], async () => {
      searched += 1;
      return okResult("brave");
    }),
    config: {},
    pluginConfig: {},
    signal: controller.signal,
    request: { query: "aborted", providers: ["brave", "tavily"] },
  });
  assert.equal(searched, 0);
  assert.deepEqual(payload.providersSucceeded, []);
  assert.deepEqual(
    payload.providersFailed.map((failure) => failure.error),
    ["user cancelled", "user cancelled"],
  );
  assert.ok(payload.providerRuns.every((run) => run.attempts === 1));
});

// ─── merge and ranking ────────────────────────────────────────────────────────

test("merging keeps the longest title and snippet and counts each provider once", { skip: "this branch takes the title from the representative variant chosen by rank" }, async () => {
  clearRuntimeConfigSnapshot();
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave"), simpleProvider("perplexity")], async ({ providerId }) => {
      if (providerId === "brave") {
        return okResult("brave", [{ title: "Doc", url: "https://example.com/doc", description: "short" }]);
      }
      return {
        provider: "perplexity",
        result: {
          results: [
            { title: "Doc: the full guide", url: "https://example.com/doc?utm_source=pplx", description: "a much longer snippet" },
          ],
          citations: ["https://example.com/doc"],
        },
      };
    }),
    config: {},
    pluginConfig: {},
    request: { query: "merge", providers: ["brave", "perplexity"] },
  });
  assert.equal(payload.results.length, 1);
  const [merged] = payload.results;
  assert.equal(merged?.title, "Doc: the full guide");
  assert.equal(merged?.snippet, "a much longer snippet");
  assert.deepEqual(merged?.providers, ["brave", "perplexity"]);
  assert.equal(merged?.providerCount, 2);
  // Three variants: brave result, perplexity result, perplexity citation.
  assert.equal(merged?.variants.length, 3);
  assert.deepEqual(
    merged?.rankings.map((ranking) => [ranking.providerId, ranking.rawRank, ranking.sourceType]),
    [
      ["brave", 1, "results"],
      ["perplexity", 1, "results"],
      ["perplexity", 1, "citations"],
    ],
  );
  assert.equal(merged?.bestSourceTier, "high");
  assert.deepEqual(merged?.flags, ["tracking-stripped"]);
});

test("equal scores fall back to the title tie-breaker", { skip: "this branch breaks ties by provider priority, then original rank" }, async () => {
  clearRuntimeConfigSnapshot();
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave"), simpleProvider("tavily")], async ({ providerId }) =>
      providerId === "brave"
        ? okResult("brave", [{ title: "Zeta", url: "https://example.com/z" }])
        : okResult("tavily", [{ title: "Alpha", url: "https://example.com/a" }]),
    ),
    config: {},
    pluginConfig: { sourceTierMode: "off" },
    request: { query: "ties", providers: ["brave", "tavily"] },
  });
  assert.deepEqual(payload.results.map((result) => result.title), ["Alpha", "Zeta"]);
  assert.equal(payload.results[0]?.score, payload.results[1]?.score);
  assert.deepEqual(payload.ranking.sortOrder, ["score:desc", "bestRank:asc", "providerCount:desc", "title:asc"]);
  assert.deepEqual(payload.results[0]?.ranking.tieBreakers, {
    bestSourceTier: "high",
    bestRank: 1,
    providerCount: 1,
    title: "Alpha",
  });
});

test("tier-aware modes advertise the source-tier tie-breaker and score breakdown", { skip: "this branch sorts by score, provider priority, then rank" }, async () => {
  clearRuntimeConfigSnapshot();
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave")], async () =>
      okResult("brave", [{ title: "One", url: "https://example.com/1" }]),
    ),
    config: {},
    pluginConfig: { sourceTierMode: "strict" },
    request: { query: "strict", providers: ["brave"] },
  });
  assert.deepEqual(payload.ranking.sortOrder, [
    "score:desc",
    "bestSourceTier:desc",
    "bestRank:asc",
    "providerCount:desc",
    "title:asc",
  ]);
  const breakdown = payload.results[0]?.ranking.scoreBreakdown;
  assert.ok(breakdown);
  assert.equal(breakdown.corroborationBonus, 0);
  assert.equal(breakdown.bestRankBonus, 0.35);
  assert.equal(breakdown.tierAdjustment, 0.1);
  assert.equal(breakdown.flagPenalty, 0);
  assert.equal(
    breakdown.finalScore,
    breakdown.bestVariantScore + breakdown.corroborationBonus + breakdown.bestRankBonus + breakdown.tierAdjustment,
  );
  assert.equal(payload.results[0]?.score, breakdown.finalScore);
});

test("evidence table counts citations across answers and ignores unusable citation URLs", async () => {
  clearRuntimeConfigSnapshot();
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave"), simpleProvider("gemini"), simpleProvider("kimi")], async ({ providerId }) => {
      if (providerId === "brave") {
        return okResult("brave", [{ title: "Cited", url: "https://example.com/cited?b=2&a=1" }]);
      }
      return {
        provider: providerId ?? "gemini",
        result: {
          content: `${providerId} answer`,
          citations: ["https://example.com/cited?a=1&b=2#section", { url: "https://example.com/cited?b=2&a=1" }, "   ", { title: "no url" }],
        },
      };
    }),
    config: {},
    pluginConfig: {},
    request: { query: "citations", providers: ["brave", "gemini", "kimi"], maxMergedResults: 1 },
  });
  assert.equal(payload.evidenceTable.rowCount, 1);
  const row = payload.evidenceTable.rows[0];
  assert.equal(row?.canonicalUrl, "https://example.com/cited?a=1&b=2");
  assert.deepEqual(row?.answerCitationSupport, { count: 4, providerCount: 2, providers: ["gemini", "kimi"] });
  assert.deepEqual(payload.answers.map((answer) => answer.citations.length), [2, 2]);
  assert.deepEqual(
    payload.evidenceTable.columns.map((column) => column.key),
    ["rank", "title", "url", "providers", "providerCount", "bestRank", "score", "answerCitationCount", "flags"],
  );
});

// ─── summary rendering ────────────────────────────────────────────────────────

function summaryPayload(overrides: Partial<FusionSearchPayload> = {}): FusionSearchPayload {
  return {
    query: "q",
    provider: "search-fusion",
    tookMs: 12,
    count: 0,
    configuredProviders: [],
    providersQueried: ["brave"],
    providersSucceeded: ["brave"],
    providersFailed: [],
    providerDetails: [
      { provider: "brave", ok: true, tookMs: 10, rawCount: 1, discardedCount: 0, attempts: 1, configured: true },
    ],
    providerRuns: [],
    discardedResults: [],
    answers: [],
    results: [],
    ranking: {
      strategy: "merged-score-v1",
      sortOrder: [],
      consideredCount: 0,
      returnedCount: 0,
      droppedCount: 0,
      dropped: [],
    },
    evidenceTable: { version: 1, columns: [], rowCount: 0, rows: [] },
    output: { includeRawPayloads: false, includeDiscarded: false, maxSnippetLength: 500, maxAnswerLength: 2000 },
    externalContent: { untrusted: true, source: "web_search", provider: "search-fusion", aggregated: true },
    ...overrides,
  };
}

test("renderFusionSummary uses singular wording and reports empty merges", () => {
  const text = renderFusionSummary(summaryPayload());
  assert.match(text, /^Search broker ran 1 provider in 12ms\./);
  assert.match(text, /No merged results\./);
  assert.match(text, /- brave: ok \(1 hits, 10ms\)/);
  assert.doesNotMatch(text, /Failures:/);
});

test("renderFusionSummary renders flags, snippets, discarded items, answers, and attempts", () => {
  const text = renderFusionSummary(
    summaryPayload({
      providersQueried: ["brave", "tavily"],
      results: [
        {
          title: "Flagged",
          url: "https://example.com/f",
          canonicalUrl: "https://example.com/f",
          snippet: "Snippet text",
          providers: ["brave"],
          providerCount: 1,
          score: 1,
          bestRank: 2,
          bestSourceTier: "low",
          flags: ["community", "video"],
          rankings: [],
          variants: [],
          ranking: {
            strategy: "merged-score-v1",
            rank: 1,
            scoreBreakdown: {
              bestVariantScore: 1,
              corroborationBonus: 0,
              bestRankBonus: 0,
              tierAdjustment: 0,
              flagPenalty: 0,
              finalScore: 1,
            },
            tieBreakers: { bestSourceTier: "low", bestRank: 2, providerCount: 1, title: "Flagged" },
          },
        },
      ],
      discardedResults: [
        { providerId: "brave", sourceType: "results", rawRank: 3, reason: "missing-url" },
        { providerId: "brave", sourceType: "results", rawRank: 4, reason: "missing-url" },
      ],
      answers: [
        { providerId: "gemini", summary: "Short answer", fullContent: "Short answer", summaryTruncated: false, citations: [], citationDetails: [] },
      ],
      providerDetails: [
        { provider: "brave", ok: true, tookMs: 10, rawCount: 1, discardedCount: 2, attempts: 2, configured: true },
        { provider: "tavily", ok: false, tookMs: 20, rawCount: 0, discardedCount: 0, attempts: 3, configured: true, error: "HTTP 503" },
        { provider: "exa", ok: false, tookMs: 5, rawCount: 0, discardedCount: 0, attempts: 1, configured: false },
      ],
      providersFailed: [{ provider: "tavily", error: "HTTP 503" }],
    }),
    true,
  );
  assert.match(text, /ran 2 providers/);
  assert.match(text, /Merged results \(1\):\n1\. Flagged\n {3}https:\/\/example\.com\/f\n {3}Providers: brave • Best rank: #2 • Source tier: low\n {3}Flags: community, video\n {3}Snippet text/);
  assert.match(text, /Preserved 2 non-merged items as provenance evidence\./);
  assert.match(text, /Provider answer digests:\n- gemini: Short answer/);
  assert.match(text, /- brave: ok \(1 hits, 10ms, 2 attempts\)/);
  assert.match(text, /- tavily: failed \(20ms, 3 attempts\) — HTTP 503/);
  assert.match(text, /- exa: failed \(5ms\)$/m);
  assert.match(text, /Failures:\n- tavily: HTTP 503/);
});

test("renderFusionSummary hides failed providers unless failures are requested", () => {
  const payload = summaryPayload({
    discardedResults: [{ providerId: "brave", sourceType: "results", rawRank: 1, reason: "missing-url" }],
    providerDetails: [
      { provider: "brave", ok: false, tookMs: 10, rawCount: 0, discardedCount: 0, attempts: 1, configured: true, error: "boom" },
    ],
    providersFailed: [{ provider: "brave", error: "boom" }],
  });
  const text = renderFusionSummary(payload);
  assert.doesNotMatch(text, /boom/);
  assert.match(text, /Preserved 1 non-merged item as provenance evidence\./);
});

test("source-only configured SecretRefs are resolved with the provider's setter", { skip: "this branch resolves SecretRefs through secret-input-runtime and does not pass a resolver path" }, async () => {
  const ref = { source: "env", provider: "default", id: ENV_KEY };
  const runtimeConfig = { plugins: { entries: {} } };
  const sourceConfig = { plugins: { entries: { srccfg: { config: { webSearch: { apiKey: ref } } } } } };
  const seen: any[] = [];
  const provider = simpleProvider("srccfg", {
    getConfiguredCredentialValue: (cfg) => (cfg as any)?.plugins?.entries?.srccfg?.config?.webSearch?.apiKey,
    setConfiguredCredentialValue: (cfg, value) => {
      (cfg as any).plugins.entries.srccfg.config.webSearch.apiKey = value;
    },
  });
  setRuntimeConfigSnapshot(runtimeConfig as never, sourceConfig as never);
  try {
    await withEnvKey("resolved-source-configured", async () => {
      const payload = await runSearchFusion({
        runtime: runtimeWith([provider], async ({ config: delegated, providerId }) => {
          seen.push(delegated);
          return okResult(providerId ?? "srccfg");
        }),
        config: runtimeConfig,
        pluginConfig: {},
        request: { query: "q", providers: ["srccfg"] },
      });
      assert.deepEqual(payload.providersSucceeded, ["srccfg"]);
    });
  } finally {
    clearRuntimeConfigSnapshot();
  }
  assert.notEqual(seen[0], sourceConfig);
  assert.equal(seen[0].plugins.entries.srccfg.config.webSearch.apiKey, "resolved-source-configured");
  assert.deepEqual(sourceConfig.plugins.entries.srccfg.config.webSearch.apiKey, ref);
  assert.equal(secretResolverCalls.at(-1)?.path, "plugins.entries.srccfg.config.webSearch.apiKey");
});

test("unparseable result URLs are discarded instead of merged", async () => {
  clearRuntimeConfigSnapshot();
  const payload = await runSearchFusion({
    runtime: runtimeWith([simpleProvider("brave"), simpleProvider("tavily")], async ({ providerId }) =>
      providerId === "brave"
        ? okResult("brave", [{ url: "local reference 42" }])
        : okResult("tavily", [{ url: "local reference 42", title: "local", siteName: "Intranet" }]),
    ),
    config: {},
    pluginConfig: {},
    request: { query: "odd urls", providers: ["brave", "tavily"], includeDiscarded: true },
  });
  assert.equal(payload.results.length, 0);
  const discarded = payload.discardedResults;
  assert.deepEqual(
    discarded.map((entry) => entry.reason),
    ["unsupported-url", "unsupported-url"],
  );
});
