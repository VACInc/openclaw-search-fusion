import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeUrl,
  asSingleLine,
  canonicalizeUrl,
  cleanProviderText,
  redactSecrets,
  resolveSiteName,
  stripExternalWrapper,
  truncate,
} from "../src/text.js";

// Build credential-shaped strings at runtime so secret scanners stay quiet.
function fakeValue(label: string): string {
  return ["fake", label, "0123456789abcdef"].join("-");
}

test("asSingleLine collapses every whitespace run and trims the ends", () => {
  assert.equal(asSingleLine("  a\n\tb   c \r\n"), "a b c");
  assert.equal(asSingleLine(""), "");
});

test("truncate keeps short text, marks long text, and normalizes whitespace first", () => {
  assert.equal(truncate("short"), "short");
  assert.equal(truncate("exactly10!", 10), "exactly10!");
  assert.equal(truncate("abcdefghijk", 10), "abcdefghi…");
  // Whitespace is collapsed before measuring, so this fits.
  assert.equal(truncate("a   b   c", 5), "a b c");
  // The cut never leaves a dangling space before the ellipsis.
  assert.equal(truncate("abcd efgh", 6), "abcd…");
  // Degenerate limits still return a marker rather than throwing.
  assert.equal(truncate("abc", 0), "…");
  assert.equal(truncate("x".repeat(300)).length, 220);
});

test("analyzeUrl strips tracking parameters case-insensitively and flags it", () => {
  const analyzed = analyzeUrl(
    "https://Example.COM/Path/?UTM_Source=x&b=2&gclid=abc&a=1&fbclid=z&mc_cid=1&mc_eid=2&ref=hn&utm_id=7#frag",
  );
  assert.equal(analyzed.url, "https://example.com/Path?b=2&a=1");
  assert.equal(analyzed.canonicalUrl, "https://example.com/Path?a=1&b=2");
  assert.equal(analyzed.originalUrl.startsWith("https://Example.COM"), true);
  assert.deepEqual(analyzed.flags, ["tracking-stripped"]);
});

test("analyzeUrl keeps the root path slash, drops fragments, and trims input", () => {
  assert.deepEqual(analyzeUrl("  https://example.com/#top  "), {
    url: "https://example.com/",
    canonicalUrl: "https://example.com/",
    originalUrl: "https://example.com/#top",
    flags: [],
  });
  assert.equal(analyzeUrl("https://example.com/docs/").url, "https://example.com/docs");
  // Path case is significant and preserved; only the host is lowercased.
  assert.equal(analyzeUrl("https://EXAMPLE.com/Docs").url, "https://example.com/Docs");
});

test("analyzeUrl keeps repeated keys in their relative order when sorting", () => {
  const analyzed = analyzeUrl("https://example.com/s?z=1&tag=b&a=0&tag=a");
  assert.equal(analyzed.url, "https://example.com/s?z=1&tag=b&a=0&tag=a");
  assert.equal(analyzed.canonicalUrl, "https://example.com/s?a=0&tag=b&tag=a&z=1");
});

test("analyzeUrl falls back to the trimmed input for unparseable URLs", () => {
  assert.deepEqual(analyzeUrl("  not a url  "), {
    url: "not a url",
    canonicalUrl: "not a url",
    originalUrl: "not a url",
    flags: [],
  });
  assert.equal(canonicalizeUrl(""), "");
});

test("analyzeUrl unwraps each known redirect wrapper", () => {
  const target = "https://example.com/article";
  const cases = [
    `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`,
    `https://www.duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`,
    `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`,
    `https://google.com/url?url=${encodeURIComponent(target)}`,
    `https://l.google.com/url?q=${encodeURIComponent(target)}`,
    `https://www.googleadservices.com/pagead/aclk?adurl=${encodeURIComponent(target)}`,
    `https://googleadservices.com/pagead/aclk?adurl=${encodeURIComponent(target)}`,
    `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0`,
    `https://lm.facebook.com/l.php?u=${encodeURIComponent(target)}`,
  ];
  for (const wrapped of cases) {
    const analyzed = analyzeUrl(wrapped);
    assert.equal(analyzed.url, target, wrapped);
    assert.equal(analyzed.originalUrl, wrapped, wrapped);
    assert.deepEqual(analyzed.flags, ["redirect-wrapper"], wrapped);
  }
});

test("analyzeUrl combines redirect and tracking flags in sorted order", () => {
  const analyzed = analyzeUrl(
    `https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/a?utm_medium=x&id=1")}`,
  );
  assert.equal(analyzed.url, "https://example.com/a?id=1");
  assert.deepEqual(analyzed.flags, ["redirect-wrapper", "tracking-stripped"]);
});

test("analyzeUrl leaves wrapper-shaped URLs alone when they carry no target", () => {
  for (const url of [
    "https://duckduckgo.com/l/?rut=abc",
    "https://duckduckgo.com/?q=openclaw",
    "https://www.google.com/search?q=openclaw",
    "https://www.google.com/url?sa=U",
    "https://l.facebook.com/other.php?u=https%3A%2F%2Fexample.com",
    "https://evil.example/url?q=https%3A%2F%2Fexample.com",
  ]) {
    assert.deepEqual(analyzeUrl(url).flags, [], url);
  }
});

test("resolveSiteName strips a leading www and tolerates bad input", () => {
  assert.equal(resolveSiteName("https://www.example.com/a"), "example.com");
  assert.equal(resolveSiteName("https://docs.example.com/a"), "docs.example.com");
  assert.equal(resolveSiteName("nope"), undefined);
});

test("stripExternalWrapper drops a provider security preamble before the marker", () => {
  const wrapped = [
    "SECURITY NOTICE: The following content is from an external source.",
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>',
    "Source: Web Search",
    "---",
    "Actual snippet text",
    '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc">>>',
  ].join("\n");
  assert.equal(stripExternalWrapper(wrapped), "Actual snippet text");
});

test("stripExternalWrapper keeps text before the marker when no notice is present", () => {
  const wrapped = 'Lead in <<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>> body <<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc">>>';
  assert.equal(stripExternalWrapper(wrapped), "Lead in \n body");
  assert.equal(stripExternalWrapper("  plain text  "), "plain text");
});

test("cleanProviderText returns empty text for non-string values", () => {
  for (const value of [undefined, null, 42, { text: "x" }, ["x"]]) {
    assert.equal(cleanProviderText(value), "");
  }
  assert.equal(cleanProviderText("  multi\nline\ttext "), "multi line text");
});

test("redactSecrets covers every named credential field", () => {
  const names = [
    "api_key",
    "api-key",
    "apiKey",
    "access_token",
    "refresh-token",
    "auth_token",
    "id_token",
    "client_secret",
    "secret_key",
    "private_key",
    "password",
    "passwd",
    "x-api-key",
    "x-goog-api-key",
    "subscription-key",
  ];
  for (const name of names) {
    const value = fakeValue(name.replace(/[^a-z]/gi, ""));
    for (const separator of ["=", ": ", ":"]) {
      const output = redactSecrets(`failed with ${name}${separator}${value} end`);
      assert.ok(!output.includes(value), `${name}${separator} leaked: ${output}`);
      assert.match(output, /\[REDACTED\] end$/, output);
    }
    const json = redactSecrets(JSON.stringify({ [name]: value }));
    assert.ok(!json.includes(value), `${name} leaked from JSON: ${json}`);
  }
});

test("redactSecrets redacts generic query names only in query-string form", () => {
  for (const name of ["key", "token", "secret", "sig", "signature", "apikey", "auth"]) {
    const value = fakeValue(name);
    const output = redactSecrets(`GET https://api.example.com/x?q=1&${name}=${value}&page=2`);
    assert.ok(!output.includes(value), `${name} leaked: ${output}`);
    assert.match(output, /page=2/);
  }
  // Generic words in prose are not credentials.
  assert.equal(redactSecrets("the key: insight is a token gesture"), "the key: insight is a token gesture");
  // "monkey=" is not "key=".
  assert.equal(redactSecrets("monkey=banana"), "monkey=banana");
});

test("redactSecrets handles bearer and basic schemes and short tokens", () => {
  const bearer = fakeValue("bearer");
  const basic = Buffer.from("user:pass-for-test").toString("base64");
  const output = redactSecrets(`upstream said Bearer ${bearer} and Basic ${basic}`);
  assert.ok(!output.includes(bearer));
  assert.ok(!output.includes(basic));
  assert.match(output, /Bearer \[REDACTED\]/);
  assert.match(output, /Basic \[REDACTED\]/);
  // Words after "bearer" that are too short to be a credential are kept.
  assert.equal(redactSecrets("the bearer of bad news"), "the bearer of bad news");
});

test("redactSecrets redacts authorization headers in any separator style", () => {
  const value = fakeValue("authz");
  for (const input of [
    `Authorization: Token ${value}`,
    `authorization=${value}`,
    `AUTHORIZATION : ${value}, next`,
  ]) {
    const output = redactSecrets(input);
    assert.ok(!output.includes(value), output);
    assert.match(output, /\[REDACTED\]/);
  }
});

test("redactSecrets is idempotent", () => {
  const input = `api_key=${fakeValue("a")} token=${fakeValue("b")} Authorization: Bearer ${fakeValue("c")}`;
  const once = redactSecrets(input);
  assert.equal(redactSecrets(once), once);
  assert.doesNotMatch(once, /\[REDACTED\]\]/);
});
