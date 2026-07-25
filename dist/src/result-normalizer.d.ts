import type { DiscardedSearchResult, NormalizedSearchResult, ProviderAnswerDigest, SourceTierMode } from "./types.js";
import { type FuzzyUrlOptions } from "./text.js";
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
