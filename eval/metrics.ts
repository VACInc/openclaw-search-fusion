/**
 * Pure result-quality metrics for the offline Search Fusion eval.
 *
 * Page identity comes from the fixture's `pages` judgments (exact URL
 * strings), never from Search Fusion's own canonicalization, so dedupe
 * changes are measured against an independent notion of "same document".
 */

import type { FusionMergedResult, FusionSearchPayload } from "../src/types.js";

export type JudgedPage = {
  id: string;
  grade: number;
  urls: string[];
  note?: string;
};

export type QueryMetrics = {
  "ndcg@5": number;
  "ndcg@10": number;
  "p@5": number;
  /** Undefined when no grade-3 page was retrievable for the query. */
  mrr: number | undefined;
  "dup@10": number;
  "junk@5": number;
  "domains@5": number;
  snippetFallback: number;
  falseMerge: number;
  /** Undefined when the fixture has no answer expectations. */
  answerRecall: number | undefined;
};

export type MetricName = keyof QueryMetrics;

/** Metrics where a smaller value is better. */
export const LOWER_IS_BETTER: ReadonlySet<MetricName> = new Set([
  "dup@10",
  "junk@5",
  "snippetFallback",
  "falseMerge",
]);

/** Reported but not gated: more domains is not automatically better. */
export const INFORMATIONAL: ReadonlySet<MetricName> = new Set(["domains@5"]);

export const METRIC_NAMES: readonly MetricName[] = [
  "ndcg@5",
  "ndcg@10",
  "p@5",
  "mrr",
  "dup@10",
  "junk@5",
  "domains@5",
  "snippetFallback",
  "falseMerge",
  "answerRecall",
];

export type PageIndex = Map<string, JudgedPage>;

export function buildPageIndex(pages: readonly JudgedPage[]): PageIndex {
  const index: PageIndex = new Map();
  for (const page of pages) {
    for (const url of page.urls) {
      index.set(url.trim(), page);
    }
  }
  return index;
}

/** Judged pages each variant of a merged result maps to (unjudged → undefined). */
export function variantPages(result: FusionMergedResult, index: PageIndex): Array<JudgedPage | undefined> {
  return result.variants.map(
    (variant) => index.get(variant.originalUrl.trim()) ?? index.get(variant.url.trim()),
  );
}

/**
 * The page a merged result represents: the page most of its variants map to,
 * ties broken by the first variant. Unjudged results map to undefined.
 */
export function resolveResultPage(result: FusionMergedResult, index: PageIndex): JudgedPage | undefined {
  const counts = new Map<string, { page: JudgedPage; count: number; first: number }>();
  variantPages(result, index).forEach((page, position) => {
    if (!page) return;
    const entry = counts.get(page.id);
    if (entry) entry.count += 1;
    else counts.set(page.id, { page, count: 1, first: position });
  });
  let best: { page: JudgedPage; count: number; first: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.first < best.first)) {
      best = entry;
    }
  }
  return best?.page;
}

function gain(grade: number): number {
  return Math.pow(2, grade) - 1;
}

function discount(position: number): number {
  return 1 / Math.log2(position + 2);
}

/** Grade sequence actually shown, with repeats of an already-shown page zeroed. */
export function dedupedGrades(pages: Array<JudgedPage | undefined>): number[] {
  const seen = new Set<string>();
  return pages.map((page) => {
    if (!page) return 0;
    if (seen.has(page.id)) return 0;
    seen.add(page.id);
    return page.grade;
  });
}

export function ndcgAt(shown: Array<JudgedPage | undefined>, retrievable: readonly JudgedPage[], k: number): number {
  const grades = dedupedGrades(shown).slice(0, k);
  const dcg = grades.reduce((sum, grade, position) => sum + gain(grade) * discount(position), 0);
  const ideal = [...retrievable]
    .map((page) => page.grade)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, position) => sum + gain(grade) * discount(position), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function computeQueryMetrics(params: {
  payload: FusionSearchPayload;
  pages: readonly JudgedPage[];
  /** Pages that some successful provider actually served (after count slicing). */
  retrievable: readonly JudgedPage[];
  mustMention?: readonly string[];
}): QueryMetrics {
  const index = buildPageIndex(params.pages);
  const results = params.payload.results.slice(0, 10);
  const shown = results.map((result) => resolveResultPage(result, index));
  const top5 = shown.slice(0, 5);
  const seen = new Set<string>();

  let duplicates = 0;
  for (const page of shown) {
    if (page && seen.has(page.id)) duplicates += 1;
    if (page) seen.add(page.id);
  }

  const distinctGood = new Set(top5.filter((page) => page && page.grade >= 2).map((page) => page!.id));
  const junk = top5.filter((page) => !page || page.grade === 0).length;

  const hasGrade3 = params.retrievable.some((page) => page.grade === 3);
  const firstGrade3 = shown.findIndex((page) => page?.grade === 3);

  let fallbackSnippets = 0;
  let falseMerges = 0;
  for (const result of results) {
    const hasProviderSnippet = result.variants.some((variant) => variant.snippetSource === "provider" && variant.snippet);
    const usesFallback = result.variants.some(
      (variant) => variant.snippetSource === "answer-fallback" && variant.snippet === result.snippet,
    ) && !result.variants.some((variant) => variant.snippetSource === "provider" && variant.snippet === result.snippet);
    if (hasProviderSnippet && usesFallback) fallbackSnippets += 1;
    const distinctPages = new Set(variantPages(result, index).filter(Boolean).map((page) => page!.id));
    if (distinctPages.size > 1) falseMerges += 1;
  }

  let answerRecall: number | undefined;
  if (params.mustMention && params.mustMention.length > 0) {
    const answerText = params.payload.answers
      .map((answer) => `${answer.fullContent} ${answer.summary}`)
      .join(" ")
      .toLowerCase();
    const hits = params.mustMention.filter((needle) => answerText.includes(needle.toLowerCase())).length;
    answerRecall = hits / params.mustMention.length;
  }

  return {
    "ndcg@5": ndcgAt(shown, params.retrievable, 5),
    "ndcg@10": ndcgAt(shown, params.retrievable, 10),
    "p@5": distinctGood.size / 5,
    mrr: hasGrade3 ? (firstGrade3 >= 0 ? 1 / (firstGrade3 + 1) : 0) : undefined,
    "dup@10": results.length === 0 ? 0 : duplicates / results.length,
    "junk@5": top5.length === 0 ? 0 : junk / top5.length,
    "domains@5": new Set(results.slice(0, 5).map((result) => hostOf(result.url))).size,
    snippetFallback: results.length === 0 ? 0 : fallbackSnippets / results.length,
    falseMerge: results.length === 0 ? 0 : falseMerges / results.length,
    answerRecall,
  };
}

/** Macro-average each metric over the queries where it is defined. */
export function aggregateMetrics(perQuery: readonly QueryMetrics[]): Record<MetricName, number> {
  const out = {} as Record<MetricName, number>;
  for (const name of METRIC_NAMES) {
    const values = perQuery
      .map((metrics) => metrics[name])
      .filter((value): value is number => typeof value === "number");
    out[name] = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return out;
}
