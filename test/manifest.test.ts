import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";

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
  assert.equal(asObject(properties.countPerProvider)?.maximum, 100);
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
  assert.equal(asObject(properties.maxAnswerLength)?.type, "integer");
  assert.equal(asObject(properties.maxAnswerLength)?.minimum, 100);
  assert.equal(asObject(properties.maxAnswerLength)?.maximum, 10000);
});

test("manifest exposes providerConfig result ceilings and weight overrides", () => {
  const schemaProperties = manifest.configSchema?.properties ?? {};
  const providerConfig = asObject(schemaProperties.providerConfig);
  const providerConfigEntry = asObject(providerConfig?.additionalProperties);
  const providerProperties = asObject(providerConfigEntry?.properties);
  const maxResultsSchema = asObject(providerProperties?.maxResults);
  const weightSchema = asObject(providerProperties?.weight);

  assert.equal(maxResultsSchema?.type, "integer");
  assert.equal(maxResultsSchema?.minimum, 1);
  assert.equal(maxResultsSchema?.maximum, 100);
  assert.equal(weightSchema?.type, "number");
  assert.equal(weightSchema?.minimum, 0.1);
  assert.equal(weightSchema?.maximum, 5);
});

test("manifest exposes per-provider score calibration", () => {
  const schemaProperties = manifest.configSchema?.properties ?? {};
  const providerConfig = asObject(schemaProperties.providerConfig);
  const providerConfigEntry = asObject(providerConfig?.additionalProperties);
  const providerProperties = asObject(providerConfigEntry?.properties);
  const scoreCalibration = asObject(providerProperties?.scoreCalibration);
  const calibrationProperties = asObject(scoreCalibration?.properties);
  const strategy = asObject(calibrationProperties?.strategy);
  const curve = asObject(calibrationProperties?.curve);
  const curveItem = asObject(curve?.items);
  const pointProperties = asObject(curveItem?.properties);

  assert.equal(scoreCalibration?.additionalProperties, false);
  assert.deepEqual(strategy?.enum, ["minmax", "rank", "fixed", "none"]);
  assert.equal(curve?.minItems, 2);
  assert.deepEqual(curveItem?.required, ["input", "output"]);
  assert.equal(asObject(pointProperties?.output)?.minimum, 0);
  assert.equal(asObject(pointProperties?.output)?.maximum, 1);
});

test("manifest requires a curve when fixed calibration is selected", () => {
  const schema = manifest.configSchema;
  assert.ok(schema);

  const fixedWithoutCurve = validateJsonSchemaValue({
    schema: schema as never,
    cacheKey: "search-fusion-manifest-score-calibration",
    value: {
      providerConfig: {
        brave: {
          scoreCalibration: {
            strategy: "fixed",
          },
        },
      },
    },
  });
  const fixedWithCurve = validateJsonSchemaValue({
    schema: schema as never,
    cacheKey: "search-fusion-manifest-score-calibration",
    value: {
      providerConfig: {
        brave: {
          scoreCalibration: {
            strategy: "fixed",
            curve: [
              { input: 0, output: 0 },
              { input: 1, output: 1 },
            ],
          },
        },
      },
    },
  });

  assert.equal(fixedWithoutCurve.ok, false);
  if (!fixedWithoutCurve.ok) {
    assert.match(
      fixedWithoutCurve.errors.map((error) => error.text).join("\n"),
      /scoreCalibration\.curve: must have required property 'curve'/,
    );
  }
  assert.equal(fixedWithCurve.ok, true);
});

test("manifest exposes configurable fuzzy dedupe and tracking parameters", () => {
  const properties = manifest.configSchema?.properties ?? {};
  assert.equal(asObject(properties.fuzzyDedupe)?.type, "boolean");
  assert.equal(asObject(properties.trackingParams)?.type, "array");
  assert.deepEqual(asObject(properties.trackingParamMode)?.enum, ["extend", "override"]);
});
