import type {
  DiscardedSearchResult,
  NormalizedSearchResult,
  ProviderAnswerCitation,
  ProviderAnswerDigest,
  ScoreCalibrationPoint,
  ScoreCalibrationStrategy,
  SearchResultFlag,
  SearchResultSourceType,
  SearchFusionScoreCalibrationConfig,
  SourceTierMode,
} from "./types.js";
import {
  classifySourceTier,
  coerceSourceTierMode,
  sourceTierMultiplier,
} from "./source-tier.js";
import { analyzeUrl, cleanProviderText, resolveSiteName, truncate } from "./text.js";

const DEFAULT_MAX_SNIPPET_LENGTH = 500;

function limitText(
  value: string | undefined,
  maxLength: number,
): { value?: string; truncated: boolean } {
  if (!value) return { truncated: false };
  const limited = truncate(value, maxLength);
  return { value: limited, truncated: limited !== value };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(obj: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function detectItemFlags(obj: Record<string, unknown> | null, url: string): SearchResultFlag[] {
  const flags = new Set<SearchResultFlag>();

  if (obj) {
    const sponsorKeys = ["sponsored", "is_sponsored", "isSponsored", "ad", "is_ad", "isAd"];
    if (sponsorKeys.some((key) => obj[key] === true)) {
      flags.add("sponsored");
    }
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com", "tiktok.com", "www.tiktok.com"].includes(host)) {
      flags.add("video");
    }
    if (
      [
        "reddit.com",
        "www.reddit.com",
        "old.reddit.com",
        "news.ycombinator.com",
        "lobste.rs",
        "lemmy.world",
      ].includes(host) ||
      host.startsWith("forum.") ||
      host.startsWith("forums.") ||
      host.startsWith("discuss.") ||
      host.startsWith("community.")
    ) {
      flags.add("community");
    }
  } catch {
    // ignore malformed URLs
  }

  return [...flags].sort();
}

function mergeFlags(...flagLists: Array<readonly SearchResultFlag[]>): SearchResultFlag[] {
  return [...new Set(flagLists.flatMap((flags) => [...flags]))].sort();
}

function sourceTypeWeight(sourceType: SearchResultSourceType): number {
  switch (sourceType) {
    case "results":
      return 1;
    case "sources":
      return 0.95;
    case "citations":
      return 0.72;
  }
}

function flagPenalty(flags: readonly SearchResultFlag[]): number {
  let penalty = 0;
  if (flags.includes("sponsored")) penalty += 0.65;
  if (flags.includes("redirect-wrapper")) penalty += 0.12;
  if (flags.includes("community")) penalty += 0.1;
  if (flags.includes("video")) penalty += 0.1;
  if (flags.includes("tracking-stripped")) penalty += 0.02;
  return penalty;
}

function normalizeNativeScore(value: number | undefined, index: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(2, Math.max(0.05, value));
  }
  return Math.max(0.1, 1 - index * 0.08);
}

export type ScoreCalibrationFallback =
  | "single-result"
  | "missing-or-invalid-scores"
  | "constant-scores";

export type CalibratedProviderScores = {
  scores: number[];
  strategy: ScoreCalibrationStrategy;
  fallback?: ScoreCalibrationFallback;
};

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function rankScores(results: readonly NormalizedSearchResult[]): number[] {
  return results.map((result, index) => {
    const rawRank =
      Number.isFinite(result.rawRank) && result.rawRank > 0
        ? result.rawRank
        : index + 1;
    return roundScore(1 / rawRank);
  });
}

function resolveCalibrationStrategy(
  config: SearchFusionScoreCalibrationConfig | undefined,
): ScoreCalibrationStrategy {
  if (config?.strategy) {
    if (!["minmax", "rank", "fixed", "none"].includes(config.strategy)) {
      throw new Error(`Unknown score calibration strategy: ${String(config.strategy)}`);
    }
    return config.strategy;
  }
  return config?.curve ? "fixed" : "minmax";
}

function validateCalibrationCurve(
  curve: readonly ScoreCalibrationPoint[] | undefined,
): readonly ScoreCalibrationPoint[] {
  if (!curve || curve.length < 2) {
    throw new Error("Fixed score calibration requires at least two curve points.");
  }

  curve.forEach((point, index) => {
    if (!Number.isFinite(point.input) || !Number.isFinite(point.output)) {
      throw new Error(`Score calibration curve point ${index + 1} must contain finite numbers.`);
    }
    if (point.output < 0 || point.output > 1) {
      throw new Error(
        `Score calibration curve point ${index + 1} output must be between 0 and 1.`,
      );
    }
    if (index > 0 && point.input <= curve[index - 1]!.input) {
      throw new Error("Score calibration curve inputs must be strictly increasing.");
    }
    if (index > 0 && point.output < curve[index - 1]!.output) {
      throw new Error("Score calibration curve outputs must be non-decreasing.");
    }
  });

  return curve;
}

export function validateScoreCalibrationConfig(
  config: SearchFusionScoreCalibrationConfig | undefined,
): void {
  const strategy = resolveCalibrationStrategy(config);
  if (strategy === "fixed") {
    validateCalibrationCurve(config?.curve);
  }
}

function applyCalibrationCurve(
  score: number,
  curve: readonly ScoreCalibrationPoint[],
): number {
  if (score <= curve[0]!.input) {
    return curve[0]!.output;
  }

  const last = curve.at(-1)!;
  if (score >= last.input) {
    return last.output;
  }

  for (let index = 1; index < curve.length; index += 1) {
    const upper = curve[index]!;
    if (score > upper.input) {
      continue;
    }

    const lower = curve[index - 1]!;
    const progress = (score - lower.input) / (upper.input - lower.input);
    return lower.output + progress * (upper.output - lower.output);
  }

  return last.output;
}

/**
 * Calibrate one provider's native relevance scores before cross-provider merge.
 *
 * Missing, non-finite, negative, constant, and singleton score sets use rank
 * fallback as a complete set. Falling back as a set avoids mixing incomparable
 * native and synthetic scores within one provider run.
 */
export function calibrateProviderScores(
  results: readonly NormalizedSearchResult[],
  config?: SearchFusionScoreCalibrationConfig,
): CalibratedProviderScores {
  const configuredStrategy = resolveCalibrationStrategy(config);
  const fixedCurve =
    configuredStrategy === "fixed" ? validateCalibrationCurve(config?.curve) : undefined;
  if (results.length === 0) {
    return { scores: [], strategy: configuredStrategy };
  }

  if (configuredStrategy === "rank") {
    return { scores: rankScores(results), strategy: "rank" };
  }

  const nativeScores = results.map((result) => result.nativeScore);
  if (
    nativeScores.some(
      (score) => typeof score !== "number" || !Number.isFinite(score) || score < 0,
    )
  ) {
    return {
      scores: rankScores(results),
      strategy: "rank",
      fallback: "missing-or-invalid-scores",
    };
  }

  const finiteScores = nativeScores as number[];
  if (configuredStrategy === "none") {
    return {
      scores: finiteScores.map((score) => roundScore(Math.min(1, score))),
      strategy: "none",
    };
  }

  if (configuredStrategy === "fixed") {
    return {
      scores: finiteScores.map((score) =>
        roundScore(applyCalibrationCurve(score, fixedCurve!)),
      ),
      strategy: "fixed",
    };
  }

  if (results.length === 1) {
    return {
      scores: rankScores(results),
      strategy: "rank",
      fallback: "single-result",
    };
  }

  const minimum = Math.min(...finiteScores);
  const maximum = Math.max(...finiteScores);
  if (maximum === minimum) {
    return {
      scores: rankScores(results),
      strategy: "rank",
      fallback: "constant-scores",
    };
  }

  return {
    scores: finiteScores.map((score) =>
      roundScore((score - minimum) / (maximum - minimum)),
    ),
    strategy: "minmax",
  };
}

export function applySearchResultQuality(params: {
  relevanceScore: number;
  sourceType: SearchResultSourceType;
  sourceTier: NormalizedSearchResult["sourceTier"];
  flags: readonly SearchResultFlag[];
  sourceTierMode: SourceTierMode;
  normalizeHighTier?: boolean;
}): number {
  const boundedRelevance = params.normalizeHighTier
    ? Math.min(1, Math.max(0, params.relevanceScore))
    : Math.max(0, params.relevanceScore);
  const preTierScore = Math.max(
    params.normalizeHighTier ? 0 : 0.05,
    boundedRelevance * sourceTypeWeight(params.sourceType) - flagPenalty(params.flags),
  );
  const tierMultiplier = sourceTierMultiplier(params.sourceTier, params.sourceTierMode);
  const highTierMultiplier = params.normalizeHighTier
    ? sourceTierMultiplier("high", params.sourceTierMode)
    : 1;
  const qualityScore = preTierScore * (tierMultiplier / highTierMultiplier);
  return params.normalizeHighTier
    ? Math.min(1, Math.max(0, qualityScore))
    : Math.max(0.01, qualityScore);
}

function mapResultArray(params: {
  items: unknown[];
  providerId: string;
  sourceType: SearchResultSourceType;
  sourceTierMode: SourceTierMode;
  fallbackSnippet?: string;
  fallbackTruncated?: boolean;
  maxSnippetLength: number;
}): {
  results: NormalizedSearchResult[];
  discardedResults: DiscardedSearchResult[];
} {
  const results: NormalizedSearchResult[] = [];
  const discardedResults: DiscardedSearchResult[] = [];

  params.items.forEach((item, index) => {
    const stringItem = typeof item === "string" ? item.trim() : "";
    const obj = asObject(item);
    const rawUrl = stringItem || firstString(obj, ["url", "link", "href"]);
    const cleanedProviderSnippet = cleanProviderText(
      firstString(obj, ["description", "snippet", "content", "body", "text", "summary"]),
    );
    const providerSnippet = limitText(cleanedProviderSnippet || undefined, params.maxSnippetLength);
    const fallbackSnippet = limitText(params.fallbackSnippet, params.maxSnippetLength);
    const snippet = providerSnippet.value ?? fallbackSnippet.value;
    const snippetTruncated = providerSnippet.value
      ? providerSnippet.truncated
      : fallbackSnippet.truncated || params.fallbackTruncated === true;

    if (!rawUrl) {
      discardedResults.push({
        providerId: params.providerId,
        sourceType: params.sourceType,
        rawRank: index + 1,
        reason: "missing-url",
        title: firstString(obj, ["title", "name", "headline", "label"]),
        snippet,
        ...(snippetTruncated ? { truncated: true as const } : {}),
        rawItem: item,
      } satisfies DiscardedSearchResult);
      return;
    }

    const analyzedUrl = analyzeUrl(rawUrl);
    const itemFlags = detectItemFlags(obj, analyzedUrl.url);
    const flags = mergeFlags(analyzedUrl.flags as SearchResultFlag[], itemFlags);
    const sourceTier = classifySourceTier({ sourceType: params.sourceType, flags });
    const title = firstString(obj, ["title", "name", "headline", "label"]) ?? titleFromUrl(analyzedUrl.url);
    const nativeScore = firstNumber(obj, ["score", "confidence", "relevance"]);
    const baseScore = normalizeNativeScore(nativeScore, index);
    const score = applySearchResultQuality({
      relevanceScore: baseScore,
      sourceType: params.sourceType,
      sourceTier,
      flags,
      sourceTierMode: params.sourceTierMode,
    });

    results.push({
      title,
      url: analyzedUrl.url,
      originalUrl: analyzedUrl.originalUrl,
      canonicalUrl: analyzedUrl.url,
      snippet,
      ...(snippetTruncated ? { truncated: true as const } : {}),
      siteName: firstString(obj, ["siteName", "site", "domain"]) ?? resolveSiteName(analyzedUrl.url),
      providerId: params.providerId,
      score,
      nativeScore,
      rawRank: index + 1,
      sourceType: params.sourceType,
      sourceTier,
      snippetSource: providerSnippet.value ? "provider" : params.fallbackSnippet ? "answer-fallback" : undefined,
      flags,
      rawItem: item,
    } satisfies NormalizedSearchResult);
  });

  return { results, discardedResults };
}

function buildCitationDetails(citationsRaw: unknown[]): ProviderAnswerCitation[] {
  return citationsRaw.flatMap<ProviderAnswerCitation>((entry) => {
    if (typeof entry === "string") {
      const analyzed = analyzeUrl(entry.trim());
      return analyzed.url ? [{ url: analyzed.url, raw: entry }] : [];
    }

    const obj = asObject(entry);
    const url = firstString(obj, ["url", "link", "href"]);
    if (!url) return [];
    const analyzed = analyzeUrl(url);

    return [
      {
        url: analyzed.url,
        title: firstString(obj, ["title", "name", "headline", "label"]),
        raw: entry,
      } satisfies ProviderAnswerCitation,
    ];
  });
}

export function extractProviderAnswer(
  payload: Record<string, unknown>,
  providerId: string,
  maxSnippetLength = DEFAULT_MAX_SNIPPET_LENGTH,
): ProviderAnswerDigest | undefined {
  const rawFullContent = cleanProviderText(payload.content ?? payload.answer);
  if (!rawFullContent) return undefined;
  const fullContent = truncate(rawFullContent, maxSnippetLength);
  const summaryMaxLength = Math.min(320, maxSnippetLength);

  const citationsRaw = Array.isArray(payload.citations) ? payload.citations : [];
  const citationDetails = buildCitationDetails(citationsRaw);

  return {
    providerId,
    summary: truncate(rawFullContent, summaryMaxLength),
    fullContent,
    summaryTruncated: rawFullContent.length > summaryMaxLength,
    ...(rawFullContent.length > maxSnippetLength ? { truncated: true as const } : {}),
    citations: citationDetails.map((entry) => entry.url),
    citationDetails,
  };
}

export function normalizeProviderPayload(params: {
  providerId: string;
  payload: Record<string, unknown>;
  sourceTierMode?: SourceTierMode;
  maxSnippetLength?: number;
}): {
  results: NormalizedSearchResult[];
  discardedResults: DiscardedSearchResult[];
  answer?: ProviderAnswerDigest;
  error?: string;
} {
  const payload = params.payload;
  const maxSnippetLength = Math.max(
    100,
    Math.min(5000, params.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH),
  );
  const answer = extractProviderAnswer(payload, params.providerId, maxSnippetLength);
  const sourceTierMode = coerceSourceTierMode(params.sourceTierMode);

  const resultArrays: NormalizedSearchResult[] = [];
  const discardedArrays: DiscardedSearchResult[] = [];
  const topLevelResults = Array.isArray(payload.results) ? payload.results : [];
  if (topLevelResults.length > 0) {
    const mapped = mapResultArray({
      items: topLevelResults,
      providerId: params.providerId,
      sourceType: "results",
      sourceTierMode,
      fallbackSnippet: answer?.fullContent,
      fallbackTruncated: answer?.truncated,
      maxSnippetLength,
    });
    resultArrays.push(...mapped.results);
    discardedArrays.push(...mapped.discardedResults);
  }

  const topLevelSources = Array.isArray(payload.sources) ? payload.sources : [];
  if (topLevelSources.length > 0) {
    const mapped = mapResultArray({
      items: topLevelSources,
      providerId: params.providerId,
      sourceType: "sources",
      sourceTierMode,
      fallbackSnippet: answer?.fullContent,
      fallbackTruncated: answer?.truncated,
      maxSnippetLength,
    });
    resultArrays.push(...mapped.results);
    discardedArrays.push(...mapped.discardedResults);
  }

  const nestedWebResults = Array.isArray(asObject(payload.web)?.results)
    ? (asObject(payload.web)?.results as unknown[])
    : [];
  if (nestedWebResults.length > 0) {
    const mapped = mapResultArray({
      items: nestedWebResults,
      providerId: params.providerId,
      sourceType: "results",
      sourceTierMode,
      fallbackSnippet: answer?.fullContent,
      fallbackTruncated: answer?.truncated,
      maxSnippetLength,
    });
    resultArrays.push(...mapped.results);
    discardedArrays.push(...mapped.discardedResults);
  }

  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  if (citations.length > 0) {
    const mapped = mapResultArray({
      items: citations,
      providerId: params.providerId,
      sourceType: "citations",
      sourceTierMode,
      fallbackSnippet: answer?.fullContent,
      fallbackTruncated: answer?.truncated,
      maxSnippetLength,
    });
    resultArrays.push(...mapped.results);
    discardedArrays.push(...mapped.discardedResults);
  }

  const errorParts = [payload.error, payload.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const error =
    errorParts.length > 0 && resultArrays.length === 0 && discardedArrays.length === 0 && !answer
      ? errorParts.join(": ")
      : undefined;

  return { results: resultArrays, discardedResults: discardedArrays, answer, error };
}
