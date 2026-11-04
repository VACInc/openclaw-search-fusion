import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";

function flagsFor(url: string): string[] {
  const normalized = normalizeProviderPayload({
    providerId: "brave",
    payload: { results: [{ title: "t", url }] },
  });
  return normalized.results[0]?.flags ?? [];
}

test("mobile and app subdomains of video hosts are flagged as video", () => {
  for (const url of [
    "https://m.youtube.com/watch?v=abc",
    "https://music.youtube.com/watch?v=abc",
    "https://player.vimeo.com/video/1",
    "https://vm.tiktok.com/ZM123/",
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
  ]) {
    assert.deepEqual(flagsFor(url), ["video"], url);
  }
});

test("reddit and other community subdomains are flagged as community", () => {
  for (const url of [
    "https://new.reddit.com/r/x/comments/1",
    "https://np.reddit.com/r/x/comments/1",
    "https://old.reddit.com/r/x/comments/1",
    "https://reddit.com/r/x",
    "https://news.ycombinator.com/item?id=1",
    "https://forum.example.com/t/1",
  ]) {
    assert.deepEqual(flagsFor(url), ["community"], url);
  }
});

test("lookalike hosts that only end with the same letters are not flagged", () => {
  for (const url of [
    "https://notyoutube.com/watch",
    "https://myreddit.com/r/x",
    "https://youtube.com.example.net/",
    "https://ycombinator.com/companies",
  ]) {
    assert.deepEqual(flagsFor(url), [], url);
  }
});
