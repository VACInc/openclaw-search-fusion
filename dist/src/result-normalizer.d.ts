import type { DiscardedSearchResult, NormalizedSearchResult, ProviderAnswerDigest, SourceTierMode } from "./types.js";
/** Answer digests are whole synthesized answers, so they get a larger cap than per-page snippets. */
export declare const DEFAULT_MAX_ANSWER_LENGTH = 2000;
export declare const MAX_ANSWER_LENGTH_LIMIT = 10000;
export declare function extractProviderAnswer(payload: Record<string, unknown>, providerId: string, maxAnswerLength?: number): ProviderAnswerDigest | undefined;
export declare function normalizeProviderPayload(params: {
    providerId: string;
    payload: Record<string, unknown>;
    sourceTierMode?: SourceTierMode;
    maxSnippetLength?: number;
    maxAnswerLength?: number;
}): {
    results: NormalizedSearchResult[];
    discardedResults: DiscardedSearchResult[];
    answer?: ProviderAnswerDigest;
    error?: string;
};
