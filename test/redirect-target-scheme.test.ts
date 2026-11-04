import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";
import { analyzeUrl } from "../src/text.js";

const wrappers = [
  (target: string) => `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`,
  (target: string) => `https://www.google.com/url?q=${encodeURIComponent(target)}`,
  (target: string) => `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}`,
];

test("redirect wrappers are never unwrapped to script, data, or local targets", () => {
  for (const target of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/search?q=relative",
  ]) {
    for (const wrap of wrappers) {
      const wrapped = wrap(target);
      const analyzed = analyzeUrl(wrapped);
      assert.ok(analyzed.url.startsWith("https://"), `${wrapped} -> ${analyzed.url}`);
      assert.equal(analyzed.canonicalUrl.startsWith("https://"), true);
      assert.ok(!analyzed.flags.includes("redirect-wrapper"), wrapped);
    }
  }
});

test("http and https targets are still unwrapped", () => {
  for (const target of ["https://example.com/a", "http://example.org/b"]) {
    for (const wrap of wrappers) {
      const analyzed = analyzeUrl(wrap(target));
      assert.equal(analyzed.url, target);
      assert.deepEqual(analyzed.flags, ["redirect-wrapper"]);
    }
  }
});

test("normalized results keep the wrapper URL when its target is not a web page", () => {
  const wrapped = wrappers[0]!("javascript:alert(1)");
  const normalized = normalizeProviderPayload({
    providerId: "duckduckgo",
    payload: { results: [{ title: "Click me", url: wrapped }] },
  });
  assert.equal(normalized.results[0]?.url.startsWith("https://duckduckgo.com/l?uddg="), true);
  assert.doesNotMatch(JSON.stringify(normalized.results[0]?.url), /javascript:/i);
});
