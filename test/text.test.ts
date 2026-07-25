import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFuzzyUrl,
  canonicalizeUrlForDedupe,
  normalizeTitle,
} from "../src/text.js";

const canonicalizationCases = [
  {
    name: "lowercases scheme and host and folds HTTP into HTTPS",
    input: "HTTP://EXAMPLE.COM/Story",
    expected: "https://example.com/Story",
  },
  {
    name: "strips the default HTTP port before HTTPS folding",
    input: "http://example.com:80/story",
    expected: "https://example.com/story",
  },
  {
    name: "strips the default HTTPS port",
    input: "https://example.com:443/story",
    expected: "https://example.com/story",
  },
  {
    name: "preserves a non-default port",
    input: "https://example.com:8443/story",
    expected: "https://example.com:8443/story",
  },
  {
    name: "normalizes trailing slashes",
    input: "https://example.com/story///",
    expected: "https://example.com/story",
  },
  {
    name: "removes fragments",
    input: "https://example.com/story#comments",
    expected: "https://example.com/story",
  },
  {
    name: "folds www into the apex host",
    input: "https://www.example.com/story",
    expected: "https://example.com/story",
  },
  {
    name: "folds mobile subdomains",
    input: "https://m.example.com/story",
    expected: "https://example.com/story",
  },
  {
    name: "folds AMP subdomains",
    input: "https://amp.example.com/story",
    expected: "https://example.com/story",
  },
  {
    name: "folds a terminal AMP path",
    input: "https://example.com/story/amp",
    expected: "https://example.com/story",
  },
  {
    name: "folds a terminal AMP path with a slash",
    input: "https://example.com/story/AMP/",
    expected: "https://example.com/story",
  },
  {
    name: "folds a terminal AMP HTML path",
    input: "https://example.com/story/amp.html",
    expected: "https://example.com/story",
  },
  {
    name: "folds a terminal AMP index path",
    input: "https://example.com/story/amp/index.html",
    expected: "https://example.com/story",
  },
] as const;

for (const { name, input, expected } of canonicalizationCases) {
  test(`canonicalizeUrlForDedupe ${name}`, () => {
    assert.equal(canonicalizeUrlForDedupe(input), expected);
  });
}

const defaultTrackingParams = [
  "utm_source",
  "utm_new_campaign_dimension",
  "fbclid",
  "gclid",
  "ref",
  "mc_cid",
  "mc_eid",
  "igshid",
] as const;

for (const trackingParam of defaultTrackingParams) {
  test(`canonicalizeUrlForDedupe strips default tracking parameter ${trackingParam}`, () => {
    assert.equal(
      canonicalizeUrlForDedupe(
        `https://example.com/story?id=42&${trackingParam}=tracking-value`,
      ),
      "https://example.com/story?id=42",
    );
  });
}

test("canonicalizeUrlForDedupe preserves and sorts meaningful query parameters", () => {
  assert.equal(
    canonicalizeUrlForDedupe("https://example.com/story?z=last&id=2&a=first"),
    "https://example.com/story?a=first&id=2&z=last",
  );
});

test("canonicalizeUrlForDedupe preserves order for repeated meaningful parameters", () => {
  assert.notEqual(
    canonicalizeUrlForDedupe("https://example.com/story?step=one&step=two"),
    canonicalizeUrlForDedupe("https://example.com/story?step=two&step=one"),
  );
});

test("canonicalizeUrlForDedupe extends the tracking list with names and wildcard prefixes", () => {
  assert.equal(
    canonicalizeUrlForDedupe(
      "https://example.com/story?id=2&campaign_id=abc&pk_source=email",
      {
        trackingParams: ["campaign_id", "pk_*"],
      },
    ),
    "https://example.com/story?id=2",
  );
});

test("canonicalizeUrlForDedupe can override the default tracking list", () => {
  assert.equal(
    canonicalizeUrlForDedupe(
      "https://example.com/story?ref=homepage&campaign_id=abc",
      {
        trackingParams: ["campaign_id"],
        trackingParamMode: "override",
      },
    ),
    "https://example.com/story?ref=homepage",
  );
});

test("canonicalizeUrlForDedupe does not fold meaningful AMP-looking path segments", () => {
  assert.equal(
    canonicalizeUrlForDedupe("https://example.com/amp-guides/article"),
    "https://example.com/amp-guides/article",
  );
});

test("analyzeFuzzyUrl exposes the canonical host and remaining query guard", () => {
  assert.deepEqual(
    analyzeFuzzyUrl("http://m.Example.com/story/amp/?utm_source=x&id=2#fragment"),
    {
      canonicalUrl: "https://example.com/story?id=2",
      host: "example.com",
      meaningfulQuery: "?id=2",
    },
  );
});

test("normalizeTitle folds case, compatibility characters, punctuation, and whitespace", () => {
  assert.equal(normalizeTitle("  Ｑ2 Results: What's New?  "), "q2 results what s new");
});
