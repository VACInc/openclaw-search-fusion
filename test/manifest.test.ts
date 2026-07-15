import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(import.meta.dirname, "..", "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  uiHints?: Record<string, unknown>;
  configSchema?: { properties?: Record<string, unknown> };
  contracts?: { webSearchProviders?: string[]; tools?: string[] };
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

test("manifest advertises webSearch participation for runtime provider discovery", () => {
  const uiHintKeys = Object.keys(manifest.uiHints ?? {});
  const schemaProperties = Object.keys(manifest.configSchema?.properties ?? {});

  assert.equal(
    uiHintKeys.some((key) => key === "webSearch" || key.startsWith("webSearch.")) ||
      schemaProperties.includes("webSearch"),
    true,
    "search-fusion must advertise webSearch capability in openclaw.plugin.json so generic web_search can discover the provider",
  );
  assert.deepEqual(manifest.contracts?.webSearchProviders, ["search-fusion"]);
  assert.deepEqual(manifest.contracts?.tools, ["search_fusion", "search_fusion_providers"]);
});

test("manifest exposes deadline and bounded-output configuration", () => {
  const properties = manifest.configSchema?.properties ?? {};
  assert.deepEqual(asObject(properties.totalTimeoutMs), {
    type: "integer",
    minimum: 5000,
    maximum: 180000,
    description: "Whole fan-out deadline including credential preparation, retries, and backoff. Defaults to 30000ms; completed providers are returned as partial results.",
  });
  assert.equal(asObject(properties.includeRawPayloads)?.type, "boolean");
  assert.equal(asObject(properties.includeDiscarded)?.type, "boolean");
  assert.equal(asObject(properties.maxSnippetLength)?.type, "integer");
  assert.equal(asObject(properties.maxSnippetLength)?.minimum, 100);
  assert.equal(asObject(properties.maxSnippetLength)?.maximum, 5000);
});

test("manifest exposes providerConfig weight overrides", () => {
  const schemaProperties = manifest.configSchema?.properties ?? {};
  const providerConfig = asObject(schemaProperties.providerConfig);
  const providerConfigEntry = asObject(providerConfig?.additionalProperties);
  const providerProperties = asObject(providerConfigEntry?.properties);
  const weightSchema = asObject(providerProperties?.weight);

  assert.equal(weightSchema?.type, "number");
  assert.equal(weightSchema?.minimum, 0.1);
  assert.equal(weightSchema?.maximum, 5);
});
