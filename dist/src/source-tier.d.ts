import type { SearchResultFlag, SearchResultSourceTier, SearchResultSourceType, SourceTierMode } from "./types.js";
export declare function coerceSourceTierMode(value: unknown): SourceTierMode;
export declare function sourceTierRank(tier: SearchResultSourceTier): number;
export declare function compareSourceTierDesc(a: SearchResultSourceTier, b: SearchResultSourceTier): number;
export declare function pickHigherSourceTier(a: SearchResultSourceTier, b: SearchResultSourceTier): SearchResultSourceTier;
export declare function classifySourceTier(params: {
    sourceType: SearchResultSourceType;
    flags: readonly SearchResultFlag[];
}): SearchResultSourceTier;
/**
 * Highest tier a merged page may hold given flags that describe the page
 * itself (any provider marking it sponsored, a video, or a forum thread).
 * Link-level flags such as redirect-wrapper do not cap the page.
 */
export declare function pageFlagTierCap(flags: readonly SearchResultFlag[]): SearchResultSourceTier;
/** The lower of two tiers. */
export declare function pickLowerSourceTier(a: SearchResultSourceTier, b: SearchResultSourceTier): SearchResultSourceTier;
export declare function sourceTierMultiplier(tier: SearchResultSourceTier, mode: SourceTierMode): number;
export declare function sourceTierMergedAdjustment(tier: SearchResultSourceTier, mode: SourceTierMode): number;
