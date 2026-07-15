import type { DiscardedSearchResult, NormalizedSearchResult, ProviderAnswerDigest, SourceTierMode } from "./types.js";
export declare function extractProviderAnswer(payload: Record<string, unknown>, providerId: string, maxSnippetLength?: number): ProviderAnswerDigest | undefined;
export declare function normalizeProviderPayload(params: {
    providerId: string;
    payload: Record<string, unknown>;
    sourceTierMode?: SourceTierMode;
    maxSnippetLength?: number;
}): {
    results: NormalizedSearchResult[];
    discardedResults: DiscardedSearchResult[];
    answer?: ProviderAnswerDigest;
    error?: string;
};
