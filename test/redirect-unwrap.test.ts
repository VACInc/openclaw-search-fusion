import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";
import { analyzeUrl } from "../src/text.js";

const ddg = (target: string) => `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=x`;
const google = (target: string) => `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`;
const facebook = (target: string) => `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}`;

test("redirect targets keep percent-encoded delimiters from the original URL", () => {
  for (const target of [
    "https://example.com/search?q=a%26b&page=2",
    "https://example.com/wiki/C%23_(language)",
    "https://example.com/discount/100%25-off",
    "https://example.com/path%3Fnot-a-query",
  ]) {
    for (const wrap of [ddg, google, facebook]) {
      const analyzed = analyzeUrl(wrap(target));
      assert.equal(analyzed.url, target, wrap(target));
      assert.deepEqual(analyzed.flags, ["redirect-wrapper"]);
    }
  }
});

test("different pages behind redirect wrappers do not collapse into one canonical URL", () => {
  const encodedAmpersand = analyzeUrl(ddg("https://example.com/s?q=a%26b"));
  const separateParams = analyzeUrl(ddg("https://example.com/s?q=a&b="));
  assert.notEqual(encodedAmpersand.canonicalUrl, separateParams.canonicalUrl);

  const hashInPath = analyzeUrl(google("https://example.com/notes/%23tag"));
  const plainPath = analyzeUrl(google("https://example.com/notes/"));
  assert.notEqual(hashInPath.canonicalUrl, plainPath.canonicalUrl);
});

test("double-encoded redirect targets are still unwrapped", () => {
  const target = "https://example.com/article?id=7";
  const doubleEncoded = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(encodeURIComponent(target))}`;
  assert.equal(analyzeUrl(doubleEncoded).url, target);
});

test("blank redirect targets leave the wrapper URL in place", () => {
  const wrapper = "https://duckduckgo.com/l/?uddg=%20%20";
  const analyzed = analyzeUrl(wrapper);
  assert.deepEqual(analyzed.flags, []);
  assert.equal(analyzed.originalUrl, wrapper);
});

test("normalized results from wrapped URLs keep their real target", () => {
  const target = "https://example.com/search?q=rock%26roll";
  const normalized = normalizeProviderPayload({
    providerId: "duckduckgo",
    payload: { results: [{ title: "Rock and roll", url: ddg(target) }] },
  });
  assert.equal(normalized.results[0]?.url, target);
  assert.equal(normalized.results[0]?.canonicalUrl, target);
  assert.equal(normalized.results[0]?.originalUrl, ddg(target));
});
