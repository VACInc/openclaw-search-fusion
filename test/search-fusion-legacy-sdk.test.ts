import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { sdkSubpathResolves } from "./sdk-resolves.js";

// Older OpenClaw SDKs expose config-runtime without source snapshots. Search
// Fusion must then treat the plugin's own config as the source config.
// The legacy facade only exists in OpenClaw SDKs before 2026.10; a module mock
// needs a resolvable specifier, so this path is only testable on those SDKs.
const legacySdk = sdkSubpathResolves("openclaw/plugin-sdk/config-runtime");
if (legacySdk) {
  mock.module("openclaw/plugin-sdk/config-runtime", {
    cache: true,
    namedExports: {
      resolveConfiguredSecretInputString: async () => ({ unresolvedRefReason: "unused" }),
    },
  });
}

const { runSearchFusion } = await import("../src/search-fusion.js");

test("without source snapshots the plugin config is used for discovery and delegation", { skip: legacySdk ? false : "installed OpenClaw SDK has no config-runtime facade" }, async () => {
  const config = { plugins: { entries: { legacy: { config: { webSearch: { apiKey: "legacy-key" } } } } } };
  const seen: unknown[] = [];
  const payload = await runSearchFusion({
    runtime: {
      webSearch: {
        listProviders: () => [
          {
            id: "legacy",
            label: "Legacy",
            envVars: [],
            getConfiguredCredentialValue: (cfg: any) => cfg?.plugins?.entries?.legacy?.config?.webSearch?.apiKey,
            getCredentialValue: () => undefined,
          },
        ],
        search: async ({ config: delegated }: { config?: unknown }) => {
          seen.push(delegated);
          return { provider: "legacy", result: { results: [{ title: "Legacy", url: "https://example.com/legacy" }] } };
        },
      },
    } as never,
    config,
    pluginConfig: {},
    request: { query: "legacy sdk" },
  });
  assert.deepEqual(payload.configuredProviders, ["legacy"]);
  assert.deepEqual(payload.providersSucceeded, ["legacy"]);
  assert.equal(seen[0], config);
});
