import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";
import { truncate } from "../src/text.js";

function hasLoneSurrogate(value: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

test("truncate never cuts an astral character in half", () => {
  const text = "ab" + "😀".repeat(10);
  for (let max = 1; max <= text.length; max += 1) {
    const output = truncate(text, max);
    assert.ok(!hasLoneSurrogate(output), `max=${max}: ${JSON.stringify(output)}`);
    assert.ok(output.length <= max, `max=${max} produced ${output.length} code units`);
  }
  assert.equal(truncate("ab😀😀", 4), "ab…");
  assert.equal(truncate("ab😀😀", 5), "ab😀…");
});

test("truncate keeps CJK and accented text intact", () => {
  assert.equal(truncate("日本語のテキストです", 5), "日本語の…");
  assert.equal(truncate("café crème brûlée", 8), "café cr…");
});

test("truncated snippets serialize without escaped lone surrogates", () => {
  const description = "🔍".repeat(400);
  const normalized = normalizeProviderPayload({
    providerId: "brave",
    payload: { results: [{ title: "Emoji", url: "https://example.com/e", description }] },
    maxSnippetLength: 102,
  });
  const snippet = normalized.results[0]?.snippet ?? "";
  assert.equal(normalized.results[0]?.truncated, true);
  assert.ok(!hasLoneSurrogate(snippet), JSON.stringify(snippet));
  assert.doesNotMatch(JSON.stringify(snippet), /\\ud[89ab][0-9a-f]{2}/i);
});
