import test from "node:test";
import assert from "node:assert/strict";
import { runSearchFusion } from "../src/search-fusion.js";

type Hit = Record<string, unknown>;

async function fuse(byProvider: Record<string, Hit[]>) {
  const ids = Object.keys(byProvider);
  return await runSearchFusion({
    runtime: {
      webSearch: {
        listProviders: () =>
          ids.map((id) => ({ id, label: id, envVars: [], getConfiguredCredentialValue: () => "k", getCredentialValue: () => undefined })),
        search: async ({ providerId }: { providerId?: string }) => ({
          provider: providerId ?? "",
          result: { results: byProvider[providerId ?? ""] ?? [] },
        }),
      },
    } as never,
    config: {},
    pluginConfig: {},
    request: { query: "flags", providers: ids },
  });
}

test("a page one provider marks sponsored keeps the sponsored penalty when another returns it organically", async () => {
  const payload = await fuse({
    brave: [
      { title: "Organic A", url: "https://a.example/page" },
      { title: "Organic B", url: "https://b.example/page" },
    ],
    tavily: [{ title: "Ad A", url: "https://a.example/page", sponsored: true }],
  });
  // Agreement must not lift a page that any provider marks as an ad.
  assert.deepEqual(payload.results.map((result) => result.url), ["https://b.example/page", "https://a.example/page"]);
  const ad = payload.results.find((result) => result.url === "https://a.example/page");
  assert.equal(ad?.providerCount, 2);
  assert.equal(ad?.ranking.scoreBreakdown.flagPenalty, 0.65);
  assert.deepEqual(ad?.flags, ["sponsored"]);
});

test("a redirect-wrapped copy from one provider does not cancel the corroboration bonus", async () => {
  const target = "https://a.example/page";
  const payload = await fuse({
    brave: [{ title: "A", url: target }],
    duckduckgo: [{ title: "A", url: `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}` }],
  });
  const breakdown = payload.results[0]?.ranking.scoreBreakdown;
  assert.deepEqual(payload.results[0]?.flags, ["redirect-wrapper"]);
  assert.equal(breakdown?.flagPenalty, 0);
  assert.equal(breakdown?.corroborationBonus, 0.3);
});

test("flags shared by every variant are still penalized at merge time", async () => {
  const payload = await fuse({
    brave: [{ title: "Ad", url: "https://ads.example/x?utm_source=a", sponsored: true }],
    tavily: [{ title: "Ad", url: "https://ads.example/x?gclid=1", is_ad: true }],
  });
  const [merged] = payload.results;
  assert.deepEqual(merged?.flags, ["sponsored", "tracking-stripped"]);
  assert.equal(merged?.ranking.scoreBreakdown.flagPenalty, 0.67);
});

test("host-derived flags apply to every variant of the same URL", async () => {
  const payload = await fuse({
    brave: [{ title: "Thread", url: "https://www.reddit.com/r/x/comments/1" }],
    tavily: [{ title: "Thread", url: "https://www.reddit.com/r/x/comments/1/" }],
  });
  assert.equal(payload.results[0]?.ranking.scoreBreakdown.flagPenalty, 0.08);
});
