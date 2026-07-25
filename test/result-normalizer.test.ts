import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";

test("normalizeProviderPayload maps structured results", () => {
  const normalized = normalizeProviderPayload({
    providerId: "brave",
    payload: {
      results: [
        {
          title: "OpenClaw Docs",
          url: "https://docs.openclaw.ai/tools/web?utm_source=test",
          description: "Web search docs",
          extra: { provider: "brave" },
        },
      ],
    },
  });

  assert.equal(normalized.error, undefined);
  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(normalized.results[0]?.originalUrl, "https://docs.openclaw.ai/tools/web?utm_source=test");
  assert.equal(normalized.results[0]?.title, "OpenClaw Docs");
  assert.equal(normalized.results[0]?.snippet, "Web search docs");
  assert.equal(normalized.results[0]?.snippetSource, "provider");
  assert.deepEqual(normalized.results[0]?.flags, ["tracking-stripped"]);
  assert.equal(normalized.results[0]?.sourceTier, "high");
  assert.deepEqual((normalized.results[0]?.rawItem as { extra?: { provider?: string } })?.extra, {
    provider: "brave",
  });
});

test("normalizeProviderPayload unwraps redirect wrappers without losing original URLs", () => {
  const normalized = normalizeProviderPayload({
    providerId: "duckduckgo",
    payload: {
      results: [
        {
          title: "Wrapped link",
          url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dddg",
          description: "Wrapped result",
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.url, "https://example.com/article");
  assert.equal(
    normalized.results[0]?.originalUrl,
    "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dddg",
  );
  assert.deepEqual(normalized.results[0]?.flags, ["redirect-wrapper", "tracking-stripped"]);
  assert.equal(normalized.results[0]?.sourceTier, "low");
});

test("normalizeProviderPayload preserves full answer content and citation details", () => {
  const normalized = normalizeProviderPayload({
    providerId: "gemini",
    payload: {
      content:
        "SECURITY NOTICE: ignored\n\n<<<EXTERNAL_CONTENT_START id=\"1\">>>\nSource: Web Search\n---\nA synthetic answer about OpenClaw that is deliberately long enough to force truncation in the summary layer while keeping the full content intact for downstream consumers.\n<<<EXTERNAL_CONTENT_END id=\"1\">>>",
      citations: [
        "https://docs.openclaw.ai/",
        { url: "https://github.com/openclaw/openclaw", title: "GitHub" },
      ],
    },
  });

  assert.equal(normalized.answer?.providerId, "gemini");
  assert.match(normalized.answer?.summary ?? "", /synthetic answer/i);
  assert.match(normalized.answer?.fullContent ?? "", /full content intact/i);
  assert.equal(normalized.answer?.citationDetails[1]?.title, "GitHub");
  assert.equal(normalized.results.length, 2);
  assert.equal(normalized.results[0]?.sourceType, "citations");
  assert.equal(normalized.results[0]?.sourceTier, "low");
  assert.equal(normalized.results[0]?.snippetSource, "answer-fallback");
  assert.equal(normalized.results[1]?.title, "GitHub");
});

test("normalizeProviderPayload preserves configured meaningful parameters in results and citations", () => {
  const normalized = normalizeProviderPayload({
    providerId: "gemini",
    payload: {
      content: "Grounded answer.",
      results: [
        {
          title: "Referenced story",
          url: "https://example.com/story?ref=one",
        },
      ],
      citations: ["https://example.com/source?ref=answer"],
    },
    urlOptions: {
      trackingParams: [],
      trackingParamMode: "override",
    },
  });

  assert.equal(normalized.results[0]?.url, "https://example.com/story?ref=one");
  assert.equal(normalized.results[0]?.canonicalUrl, "https://example.com/story?ref=one");
  assert.deepEqual(normalized.results[0]?.flags, []);
  assert.deepEqual(normalized.answer?.citations, [
    "https://example.com/source?ref=answer",
  ]);
  assert.equal(
    normalized.answer?.citationDetails[0]?.url,
    "https://example.com/source?ref=answer",
  );
});

test("normalizeProviderPayload tags sponsored/video/community items deterministically", () => {
  const normalized = normalizeProviderPayload({
    providerId: "tavily",
    payload: {
      results: [
        {
          title: "Ad result",
          url: "https://example.com/ad",
          description: "sponsor",
          sponsored: true,
        },
        {
          title: "Reddit thread",
          url: "https://www.reddit.com/r/openclaw/comments/abc123/test/",
          description: "community",
        },
        {
          title: "Video review",
          url: "https://www.youtube.com/watch?v=123",
          description: "video",
        },
      ],
    },
  });

  assert.deepEqual(normalized.results[0]?.flags, ["sponsored"]);
  assert.deepEqual(normalized.results[1]?.flags, ["community"]);
  assert.deepEqual(normalized.results[2]?.flags, ["video"]);
  assert.equal(normalized.results[0]?.sourceTier, "suppressed");
  assert.equal(normalized.results[1]?.sourceTier, "low");
  assert.equal(normalized.results[2]?.sourceTier, "low");
});


test("normalizeProviderPayload preserves missing-url items as discarded provenance", () => {
  const missingUrlItem = {
    title: "Knowledge panel",
    description: "Entity summary with no outbound URL",
    kind: "infobox",
  };

  const normalized = normalizeProviderPayload({
    providerId: "tavily",
    payload: {
      results: [
        missingUrlItem,
        {
          title: "Real result",
          url: "https://docs.openclaw.ai/tools/web",
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(normalized.discardedResults.length, 1);
  assert.equal(normalized.discardedResults[0]?.reason, "missing-url");
  assert.equal(normalized.discardedResults[0]?.rawRank, 1);
  assert.equal(normalized.discardedResults[0]?.title, "Knowledge panel");
  assert.equal(normalized.discardedResults[0]?.snippet, "Entity summary with no outbound URL");
  assert.deepEqual(normalized.discardedResults[0]?.rawItem, missingUrlItem);
});

test("normalizeProviderPayload surfaces provider error when nothing usable returned", () => {
  const normalized = normalizeProviderPayload({
    providerId: "grok",
    payload: {
      error: "missing_xai_api_key",
      message: "Set XAI_API_KEY",
    },
  });

  assert.equal(normalized.results.length, 0);
  assert.match(normalized.error ?? "", /missing_xai_api_key/);
});

test("normalizeProviderPayload handles Exa-style structured results", () => {
  const normalized = normalizeProviderPayload({
    providerId: "exa",
    payload: {
      results: [
        {
          title: "OpenClaw Web Search",
          url: "https://docs.openclaw.ai/tools/web?utm_campaign=exa",
          description: "Neural result summary",
          summary: "Longer summary that should be ignored in favor of description",
          highlightScores: [0.9, 0.7],
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(normalized.results[0]?.snippet, "Neural result summary");
});

test("normalizeProviderPayload handles answer-first providers like Kimi/Grok/Perplexity sonar", () => {
  const normalized = normalizeProviderPayload({
    providerId: "kimi",
    payload: {
      content: "Grounded synthesis about OpenClaw search.",
      citations: [
        { url: "https://docs.openclaw.ai/tools/web", title: "Docs" },
        "https://github.com/openclaw/openclaw",
      ],
    },
  });

  assert.equal(normalized.answer?.providerId, "kimi");
  assert.equal(normalized.answer?.fullContent, "Grounded synthesis about OpenClaw search.");
  assert.equal(normalized.results.length, 2);
  assert.ok(normalized.results.every((result) => result.sourceType === "citations"));
});

test("normalizeProviderPayload handles nested web.results payloads", () => {
  const normalized = normalizeProviderPayload({
    providerId: "perplexity",
    payload: {
      web: {
        results: [
          {
            title: "OpenClaw Docs",
            url: "https://docs.openclaw.ai/tools/web",
            snippet: "Nested web result",
          },
        ],
      },
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.sourceType, "results");
  assert.equal(normalized.results[0]?.snippet, "Nested web result");
});

test("normalizeProviderPayload handles sources arrays from research-style providers", () => {
  const normalized = normalizeProviderPayload({
    providerId: "firecrawl",
    payload: {
      sources: [
        {
          title: "Firecrawl blog",
          url: "https://www.firecrawl.dev/blog/openclaw-web-search",
          description: "Search pipeline article",
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.sourceType, "sources");
  assert.equal(normalized.results[0]?.sourceTier, "standard");
  assert.equal(normalized.results[0]?.title, "Firecrawl blog");
});

test("normalizeProviderPayload applies sourceTierMode scoring deterministically", () => {
  const payload = {
    results: [{ title: "Direct result", url: "https://example.com/direct", score: 0.3 }],
    citations: [{ title: "Citation result", url: "https://example.com/citation", score: 2 }],
  };

  const off = normalizeProviderPayload({
    providerId: "gemini",
    payload,
    sourceTierMode: "off",
  });
  const strict = normalizeProviderPayload({
    providerId: "gemini",
    payload,
    sourceTierMode: "strict",
  });

  const offCitation = off.results.find((result) => result.canonicalUrl === "https://example.com/citation");
  const strictCitation = strict.results.find((result) => result.canonicalUrl === "https://example.com/citation");

  assert.equal(offCitation?.sourceTier, "low");
  assert.equal(strictCitation?.sourceTier, "low");
  assert.ok((offCitation?.score ?? 0) > (strictCitation?.score ?? 0));
});
