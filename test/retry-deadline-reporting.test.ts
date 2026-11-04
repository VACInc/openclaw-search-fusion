import test from "node:test";
import assert from "node:assert/strict";
import { runSearchFusion } from "../src/search-fusion.js";

function runtime(search: () => Promise<{ provider: string; result: Record<string, unknown> }>) {
  return {
    webSearch: {
      listProviders: () => [
        { id: "brave", label: "Brave", envVars: [], getConfiguredCredentialValue: () => "k", getCredentialValue: () => undefined },
      ],
      search,
    },
  } as never;
}

test("a retry that cannot fit before the deadline reports the provider's real error", async () => {
  let attempts = 0;
  const started = Date.now();
  const payload = await runSearchFusion({
    runtime: runtime(async () => {
      attempts += 1;
      throw new Error("HTTP 503 upstream unavailable");
    }),
    config: {},
    pluginConfig: { totalTimeoutMs: 5000, retry: { maxAttempts: 3, backoffMs: 6000, maxBackoffMs: 6000 } },
    request: { query: "no time to retry", providers: ["brave"] },
  });
  assert.equal(attempts, 1);
  // The provider finished well inside the deadline; nothing actually timed out.
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(payload.providersFailed, [{ provider: "brave", error: "HTTP 503 upstream unavailable" }]);
  assert.equal(payload.providerRuns[0]?.attempts, 1);
  assert.deepEqual(payload.providerRuns[0]?.retryHistory, []);
});

test("attempts cut off by the deadline still report deadline exceeded", async () => {
  const payload = await runSearchFusion({
    runtime: runtime(() => new Promise(() => {})),
    config: {},
    pluginConfig: { totalTimeoutMs: 5000, providerTimeoutMs: 120000 },
    request: { query: "hangs", providers: ["brave"] },
  });
  assert.deepEqual(payload.providersFailed, [{ provider: "brave", error: "deadline exceeded" }]);
});
