# Search Fusion — offline result-quality eval

An offline, deterministic evaluation of Search Fusion's merge, dedupe, and
ranking. Each fixture replays **recorded provider payloads** (the objects an
OpenClaw web-search provider returns) through the real `runSearchFusion`
pipeline with a mocked runtime, then scores the merged output against
hand-written relevance judgments.

No network access and no API keys are needed.

```bash
pnpm run eval                  # all sets, summary table
pnpm run eval -- --set dev     # one set
pnpm run eval -- --per-query   # per-fixture metrics
pnpm run eval -- --json        # machine-readable output
```

`test/eval.test.ts` runs the same harness under `npm test` and fails if any
aggregate metric drops below the recorded floor in `eval/baseline.json`.

## Fixture sets

| Set | Purpose |
|-----|---------|
| `eval/fixtures/dev` | Used while developing ranking changes. |
| `eval/fixtures/heldout` | Written independently of the ranking changes, by an author who did not see the ranking code. Pick parameters on dev; use heldout only to confirm that a dev-set gain generalizes, and reject changes that do not. Every look at heldout makes it less blind, so say in the commit message when a change was motivated by a heldout result. |

## Fixture format

One JSON file per query:

```jsonc
{
  "id": "kebab-case-id",
  "query": "the user query",
  "notes": "what makes this case interesting",
  "request": { },          // optional extra ProviderSelectionRequest fields
  "pluginConfig": { },     // optional Search Fusion plugin config
  "providers": {
    "brave":  { "payload": { "results": [ ... ] } },
    "gemini": { "payload": { "content": "...", "citations": [ ... ] } },
    "exa":    { "error": "Exa API returned 503" }  // provider throws
  },
  "pages": [
    { "id": "mdn-fetch", "grade": 3, "urls": ["https://developer.mozilla.org/en-US/docs/Web/API/fetch"] }
  ],
  "answer": { "mustMention": ["..."] }   // optional
}
```

- `providers.<id>.payload` is what the provider's `execute()` returns. Text
  fields (`title`, `description`, `snippet`, `content`, `answer`, `summary`)
  are wrapped in OpenClaw external-content markers by the harness, the same
  way real providers wrap them, unless `"wrap": false` is set. The harness
  honors the per-provider `count` argument by slicing `results`.
- `pages` lists every distinct document that appears in any payload. Each
  page has a relevance `grade` and every **exact URL string** used for it
  across payloads. Two URL strings in the same page are the same document,
  which is how duplicates are judged independently of Search Fusion's own
  canonicalization. A URL that is not listed is treated as grade 0 and
  reported as unjudged.

Grades: `3` authoritative / primary source that directly answers the query,
`2` relevant and useful, `1` marginal, `0` irrelevant, spam, or an ad.

## Metrics

All metrics are computed on the merged `results` list (top 10 unless noted)
and macro-averaged over fixtures.

| Metric | Meaning |
|--------|---------|
| `ndcg@5`, `ndcg@10` | Graded nDCG. A result whose page already appeared higher up earns no gain, so undeduped duplicates cost score. |
| `p@5` | Fraction of the top 5 that are distinct pages with grade ≥ 2. |
| `mrr` | Reciprocal rank of the first grade-3 page. |
| `dup@10` | Fraction of top-10 slots taken by a page already shown higher up. Lower is better. |
| `junk@5` | Fraction of the top 5 with grade 0. Lower is better. |
| `domains@5` | Distinct hosts (minus `www.`) in the top 5. Informational. |
| `snippetFallback` | Fraction of returned results whose snippet is a copy of an answer digest although some provider returned a real page snippet for that URL. Lower is better. |
| `answerRecall` | Fraction of `answer.mustMention` strings found in the provider answer digests. |
