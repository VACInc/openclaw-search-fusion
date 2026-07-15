import type { SearchResultFlag, SearchResultSourceTier, SearchResultSourceType, SourceTierMode } from "./types.js";
export declare function coerceSourceTierMode(value: unknown): SourceTierMode;
export declare function sourceTierRank(tier: SearchResultSourceTier): number;
export declare function compareSourceTierDesc(a: SearchResultSourceTier, b: SearchResultSourceTier): number;
export declare function pickHigherSourceTier(a: SearchResultSourceTier, b: SearchResultSourceTier): SearchResultSourceTier;
export declare function classifySourceTier(params: {
    sourceType: SearchResultSourceType;
    flags: readonly SearchResultFlag[];
}): SearchResultSourceTier;
export declare function sourceTierMultiplier(tier: SearchResultSourceTier, mode: SourceTierMode): number;
export declare function sourceTierMergedAdjustment(tier: SearchResultSourceTier, mode: SourceTierMode): number;
