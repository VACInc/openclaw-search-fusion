import test from "node:test";
import assert from "node:assert/strict";
import { runSearchFusion } from "../src/search-fusion.js";
import { redactSecrets } from "../src/text.js";

// Build credential-shaped strings at runtime so secret scanners stay quiet.
function fakeValue(label: string): string {
  return ["fake", label, "0123456789abcdef"].join("-");
}

function assertRedacted(input: string, secret: string): string {
  const output = redactSecrets(input);
  assert.ok(!output.includes(secret), `leaked: ${output}`);
  assert.match(output, /\[REDACTED\]/, output);
  return output;
}

test("credentials embedded in URL userinfo are redacted", () => {
  const userPass = fakeValue("pw");
  const output = assertRedacted(`fetch failed for https://admin:${userPass}@searx.example.com/search?q=x`, userPass);
  assert.match(output, /https:\/\/\[REDACTED\]@searx\.example\.com\/search\?q=x/);
  const token = fakeValue("tok");
  assertRedacted(`git clone https://${token}@git.example.com/repo.git`, token);
});

test("subscription token headers (Brave Search) are redacted", () => {
  const token = fakeValue("brave");
  assertRedacted(`request headers X-Subscription-Token: ${token} rejected`, token);
  assertRedacted(JSON.stringify({ "X-Subscription-Token": token }), token);
  assertRedacted(`subscription_token=${token}`, token);
});

test("quoted credential values are redacted in full, including spaces", () => {
  const words = ["correct", "horse", "battery", fakeValue("staple")];
  const phrase = words.join(" ");
  for (const input of [
    JSON.stringify({ password: phrase }),
    `password='${phrase}'`,
    `client_secret: "${phrase}"`,
  ]) {
    const output = redactSecrets(input);
    for (const word of words) {
      assert.ok(!output.includes(word), `leaked ${word}: ${output}`);
    }
  }
  // Escaped quotes inside a JSON string do not end the value early.
  const tail = fakeValue("tail");
  const escaped = redactSecrets(JSON.stringify({ api_key: `ab"cd ${tail}` }));
  assert.ok(!escaped.includes(tail), escaped);
});

test("authorization keys in JSON are redacted even without a scheme", () => {
  const token = fakeValue("authz");
  const output = assertRedacted(JSON.stringify({ headers: { Authorization: token } }), token);
  // The JSON stays parseable after redaction.
  assert.deepEqual(JSON.parse(output), { headers: { Authorization: "[REDACTED]" } });
});

test("new redactions keep JSON valid and stay idempotent", () => {
  const input = JSON.stringify({
    password: "two words",
    url: `https://u:${fakeValue("p")}@h.example/x`,
    "x-subscription-token": fakeValue("s"),
  });
  const once = redactSecrets(input);
  assert.doesNotThrow(() => JSON.parse(once), once);
  assert.equal(redactSecrets(once), once);
});

test("plain prose that merely mentions these words is untouched", () => {
  for (const text of [
    "Visit https://example.com/path for details",
    "email me at someone@example.com",
    "the subscription token count is low",
    "authorization failed",
  ]) {
    assert.equal(redactSecrets(text), text);
  }
});

test("provider failures never surface userinfo credentials", async () => {
  const userPass = fakeValue("searx");
  const payload = await runSearchFusion({
    runtime: {
      webSearch: {
        listProviders: () => [
          { id: "searxng", label: "SearXNG", envVars: [], getConfiguredCredentialValue: () => "k", getCredentialValue: () => undefined },
        ],
        search: async () => {
          throw new Error(`HTTP 401 from https://admin:${userPass}@searx.internal/search`);
        },
      },
    } as never,
    config: {},
    pluginConfig: {},
    request: { query: "q", providers: ["searxng"] },
  });
  assert.ok(!JSON.stringify(payload).includes(userPass));
  assert.match(payload.providersFailed[0]?.error ?? "", /https:\/\/\[REDACTED\]@searx\.internal/);
});

test("new redaction patterns stay linear on long adversarial inputs", () => {
  const n = 200_000;
  for (const input of [
    "x://" + "a".repeat(n),
    "a://".repeat(n / 4),
    'password: "' + "a".repeat(n),
    'password="'.repeat(n / 10),
    'api_key: "' + "\\a".repeat(n / 2),
    "authorization: ".repeat(n / 15),
    "a://" + "b@".repeat(n / 2),
  ]) {
    const started = performance.now();
    redactSecrets(input);
    assert.ok(performance.now() - started < 1000, `slow on input starting ${JSON.stringify(input.slice(0, 20))}`);
  }
});
