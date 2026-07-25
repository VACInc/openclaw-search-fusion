import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import publishedPlugin from "../dist/index.js";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
) as {
  main?: string;
  exports?: { "."?: { import?: string } };
  openclaw?: { extensions?: string[] };
};

test("declared package and OpenClaw entrypoint ships provider-native count behavior", async (t) => {
  clearRuntimeConfigSnapshot();
  t.after(() => clearRuntimeConfigSnapshot());
  const registeredTools: Array<{
    name: string;
    parameters?: {
      properties?: {
        count?: { maximum?: number };
      };
    };
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  }> = [];
  const observedCounts: unknown[] = [];
  const pluginConfig: Record<string, unknown> = {};

  assert.equal(packageJson.main, "./dist/index.js");
  assert.equal(packageJson.exports?.["."]?.import, "./dist/index.js");
  assert.deepEqual(packageJson.openclaw?.extensions, ["./dist/index.js"]);

  publishedPlugin.register({
    config: {},
    pluginConfig,
    runtime: {
      webSearch: {
        listProviders: () => [
          {
            id: "exa",
            label: "Exa",
            autoDetectOrder: 10,
            envVars: [],
            getConfiguredCredentialValue: () => "test-key",
            getCredentialValue: () => undefined,
          },
        ],
        search: async ({ providerId, args }: {
          providerId?: string;
          args: Record<string, unknown>;
        }) => {
          observedCounts.push(args.count);
          return {
            provider: providerId ?? "exa",
            result: { results: [] },
          };
        },
      },
    },
    registerTool(tool: (typeof registeredTools)[number]) {
      registeredTools.push(tool);
    },
    registerWebSearchProvider() {},
  } as never);

  const fusionTool = registeredTools.find((tool) => tool.name === "search_fusion");
  assert.ok(fusionTool);
  assert.equal(fusionTool.parameters?.properties?.count?.maximum, 100);

  await fusionTool.execute("published-count", {
    query: "provider-native entrypoint",
    providers: ["exa"],
  });
  pluginConfig.providerConfig = {
    exa: { maxResults: 17 },
  };
  await fusionTool.execute("published-override", {
    query: "configured published entrypoint",
    providers: ["exa"],
  });

  assert.deepEqual(observedCounts, [100, 17]);
});
