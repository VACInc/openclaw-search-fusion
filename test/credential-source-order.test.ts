import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviders, resolveProviderConfiguration } from "../src/provider-discovery.js";

const ENV_KEY = "SEARCH_FUSION_ORDER_TEST_XAI_KEY";

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

const grok = { id: "grok", label: "Grok", authProviderId: "xai", envVars: [ENV_KEY] };

test("a detected env credential is reported ahead of unverified account auth", () => {
  assert.deepEqual(
    withEnv("set", () => resolveProviderConfiguration(grok, {})),
    { configured: true, credentialSource: `environment (${ENV_KEY})` },
  );
});

test("account auth is still reported when no env credential is present", () => {
  assert.deepEqual(
    withEnv(undefined, () => resolveProviderConfiguration(grok, {})),
    { configured: true, credentialSource: "account-auth (unverified)" },
  );
});

test("registry and catalog entries agree on env-before-account-auth ordering", () => {
  const registry = withEnv("set", () =>
    discoverProviders({ providers: [grok], config: {}, env: {}, selfId: "search-fusion" }),
  );
  assert.equal(registry[0]?.credentialSource, `environment (${ENV_KEY})`);

  const catalog = discoverProviders({
    providers: [],
    config: { plugins: { entries: { xai: {} } } },
    env: { XAI_API_KEY: "set" },
    selfId: "search-fusion",
  });
  assert.equal(catalog.find((entry) => entry.id === "grok")?.credentialSource, "environment (XAI_API_KEY)");
});
