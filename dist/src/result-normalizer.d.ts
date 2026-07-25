import type { DiscardedSearchResult, NormalizedSearchResult, ProviderAnswerDigest, ScoreCalibrationStrategy, SearchResultFlag, SearchResultSourceType, SearchFusionScoreCalibrationConfig, SourceTierMode } from "./types.js";
import { type FuzzyUrlOptions } from "./text.js";
export type ScoreCalibrationFallback = "single-result" | "missing-or-invalid-scores" | "constant-scores";
export type CalibratedProviderScores = {
    scores: number[];
    strategy: ScoreCalibrationStrategy;
    fallback?: ScoreCalibrationFallback;
};
export declare function validateScoreCalibrationConfig(config: SearchFusionScoreCalibrationConfig | undefined): void;
/**
 * Calibrate one provider's native relevance scores before cross-provider merge.
 *
 * Missing, non-finite, negative, constant, and singleton score sets use rank
 * fallback as a complete set. Falling back as a set avoids mixing incomparable
 * native and synthetic scores within one provider run.
 */
export declare function calibrateProviderScores(results: readonly NormalizedSearchResult[], config?: SearchFusionScoreCalibrationConfig): CalibratedProviderScores;
export declare function applySearchResultQuality(params: {
    relevanceScore: number;
    sourceType: SearchResultSourceType;
    sourceTier: NormalizedSearchResult["sourceTier"];
    flags: readonly SearchResultFlag[];
    sourceTierMode: SourceTierMode;
    normalizeHighTier?: boolean;
}): number;
export declare function extractProviderAnswer(payload: Record<string, unknown>, providerId: string, maxSnippetLength?: number, urlOptions?: FuzzyUrlOptions): ProviderAnswerDigest | undefined;
export declare function normalizeProviderPayload(params: {
    providerId: string;
    payload: Record<string, unknown>;
    sourceTierMode?: SourceTierMode;
    maxSnippetLength?: number;
    urlOptions?: FuzzyUrlOptions;
}): {
    results: NormalizedSearchResult[];
    discardedResults: DiscardedSearchResult[];
    answer?: ProviderAnswerDigest;
    error?: string;
};
