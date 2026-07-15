export type SearchFusionModeMap = Record<string, string[]>;
/**
 * Hint describing the caller's intent for a search query.
 *
 * - `"research"` — in-depth investigation; prefer academic, extraction, and neural retrieval.
 * - `"keyword"` — keyword / classic web search; prefer fast index-based providers
 *   (e.g. Brave, DuckDuckGo).
 * - `"answer"` — direct answer expected; prefer answer-style providers.
 * - `"news"` — recent news / current events; prefer freshness-optimized providers.
 * - `"local"` — location-aware query; uses an explicit `intentProviders.local`
 *   override when configured, otherwise falls through to the default chain.
 *
 * When an intent is provided it influences provider selection but never overrides
 * explicit `providers` or `mode` parameters.
 */
export type SearchQueryIntent = "research" | "keyword" | "answer" | "news" | "local";
export type SearchFusionRetryConfig = {
    maxAttempts?: number;
    backoffMs?: number;
    backoffMultiplier?: number;
    maxBackoffMs?: number;
};
export type SearchFusionProviderConfig = {
    retry?: SearchFusionRetryConfig;
    timeoutMs?: number;
    count?: number;
    weight?: number;
};
export type SourceTierMode = "off" | "balanced" | "strict";
export type SearchFusionConfig = {
    defaultMode?: string;
    modes?: SearchFusionModeMap;
    /**
     * Provider lists keyed by `SearchQueryIntent`.
     * When a request carries an `intent` hint and no explicit `providers`/`mode`,
     * Search Fusion uses this map to pick the provider set.
     * When this map is omitted entirely, Search Fusion uses built-in capability
     * rules from the provider registry. When the map exists but the intent is
     * absent or resolves to no providers, routing falls back to the normal
     * default-resolution chain.
     *
     * Example:
     * ```json
     * "intentProviders": {
     *   "research": ["exa", "parallel", "tavily"],
     *   "keyword":  ["brave", "duckduckgo", "minimax"],
     *   "answer":   ["codex", "gemini", "grok", "kimi", "perplexity"],
     *   "news":     ["brave"]
     * }
     * ```
     */
    intentProviders?: Partial<Record<SearchQueryIntent, string[]>>;
    defaultProviders?: string[];
    excludeProviders?: string[];
    sourceTierMode?: SourceTierMode;
    countPerProvider?: number;
    maxMergedResults?: number;
    providerTimeoutMs?: number;
    totalTimeoutMs?: number;
    includeRawPayloads?: boolean;
    includeDiscarded?: boolean;
    maxSnippetLength?: number;
    retry?: SearchFusionRetryConfig;
    providerConfig?: Record<string, SearchFusionProviderConfig>;
    providerRetries?: Record<string, SearchFusionRetryConfig>;
};
export type ProviderSelectionRequest = {
    query: string;
    /**
     * Optional intent hint that biases provider selection without overriding
     * explicit `providers` or `mode`.
     *
     * Resolution order:
     * 1. explicit `providers`
     * 2. explicit `mode`
     * 3. `intent` → matched against `config.intentProviders`, or built-in
     *    capability rules when that map is omitted
     * 4. configured `defaultMode`
     * 5. configured `defaultProviders`
     * 6. all configured providers
     */
    intent?: SearchQueryIntent;
    mode?: string;
    providers?: string[];
    count?: number;
    maxMergedResults?: number;
    includeRawPayloads?: boolean;
    includeDiscarded?: boolean;
    country?: string;
    language?: string;
    freshness?: string;
    date_after?: string;
    date_before?: string;
    search_lang?: string;
    ui_lang?: string;
    includeFailures?: boolean;
};
export type RuntimeWebSearchProvider = {
    id: string;
    label: string;
    hint?: string;
    autoDetectOrder?: number;
    requiresCredential?: boolean;
    envVars?: readonly string[];
    credentialPath?: string;
    getConfiguredCredentialValue?: (config?: unknown) => unknown;
    getConfiguredCredentialFallback?: (config?: unknown) => {
        path: string;
        value: unknown;
    } | undefined;
    authProviderId?: string;
    setConfiguredCredentialValue?: (configTarget: unknown, value: unknown) => void;
    getCredentialValue?: (searchConfig?: Record<string, unknown> | undefined) => unknown;
    setCredentialValue?: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
};
export type ResolvedProvider = {
    id: string;
    label: string;
    hint?: string;
    autoDetectOrder?: number;
    configured: boolean;
    credentialSource?: string;
    /**
     * Capability tags declared for this provider by the capability taxonomy.
     * An empty array means the provider is treated as general-purpose / unknown.
     * See `src/provider-capabilities.ts` for the full vocabulary.
     */
    capabilities?: import("./provider-capabilities.js").ProviderCapability[];
};
export type SearchResultFlag = "community" | "redirect-wrapper" | "sponsored" | "tracking-stripped" | "video";
export type SearchResultSourceType = "results" | "citations" | "sources";
export type SearchResultSourceTier = "high" | "standard" | "low" | "suppressed";
export type DiscardedSearchResultReason = "missing-url";
export type DiscardedSearchResult = {
    providerId: string;
    sourceType: SearchResultSourceType;
    rawRank: number;
    reason: DiscardedSearchResultReason;
    title?: string;
    snippet?: string;
    truncated?: true;
    rawItem?: unknown;
};
export type NormalizedSearchResult = {
    title: string;
    url: string;
    originalUrl: string;
    canonicalUrl: string;
    snippet?: string;
    truncated?: true;
    siteName?: string;
    providerId: string;
    score: number;
    nativeScore?: number;
    rawRank: number;
    sourceType: SearchResultSourceType;
    sourceTier: SearchResultSourceTier;
    snippetSource?: "provider" | "answer-fallback";
    flags: SearchResultFlag[];
    rawItem?: unknown;
};
export type ProviderAnswerCitation = {
    url: string;
    title?: string;
    raw?: unknown;
};
export type ProviderAnswerDigest = {
    providerId: string;
    summary: string;
    fullContent: string;
    summaryTruncated: boolean;
    truncated?: true;
    citations: string[];
    citationDetails: ProviderAnswerCitation[];
};
export type ProviderRetryEvent = {
    attempt: number;
    error: string;
    delayMs: number;
};
export type ProviderRunResult = {
    providerId: string;
    label: string;
    configured: boolean;
    ok: boolean;
    tookMs: number;
    rawCount: number;
    attempts: number;
    rawPayload?: Record<string, unknown>;
    results: NormalizedSearchResult[];
    discardedResults: DiscardedSearchResult[];
    answer?: ProviderAnswerDigest;
    retryHistory: ProviderRetryEvent[];
    error?: string;
};
export type SearchResultRanking = {
    providerId: string;
    rawRank: number;
    score: number;
    nativeScore?: number;
    sourceType: SearchResultSourceType;
    sourceTier: SearchResultSourceTier;
    flags: SearchResultFlag[];
};
export type FusionScoreBreakdown = {
    bestVariantScore: number;
    corroborationBonus: number;
    bestRankBonus: number;
    tierAdjustment: number;
    flagPenalty: number;
    finalScore: number;
};
export type FusionRankingExplanation = {
    strategy: "merged-score-v1";
    rank: number;
    scoreBreakdown: FusionScoreBreakdown;
    tieBreakers: {
        bestSourceTier: SearchResultSourceTier;
        bestRank: number;
        providerCount: number;
        title: string;
    };
};
export type FusionDroppedResult = {
    rank: number;
    reason: "maxMergedResults";
    title: string;
    url: string;
    canonicalUrl: string;
    score: number;
    bestRank: number;
    providerCount: number;
};
export type FusionRankingMeta = {
    strategy: "merged-score-v1";
    sortOrder: string[];
    consideredCount: number;
    returnedCount: number;
    droppedCount: number;
    dropped: FusionDroppedResult[];
};
export type FusionMergedResult = {
    title: string;
    url: string;
    canonicalUrl: string;
    snippet?: string;
    truncated?: true;
    siteName?: string;
    providers: string[];
    providerCount: number;
    score: number;
    bestRank: number;
    bestSourceTier: SearchResultSourceTier;
    flags: SearchResultFlag[];
    rankings: SearchResultRanking[];
    variants: NormalizedSearchResult[];
    ranking: FusionRankingExplanation;
};
export type EvidenceTableColumnKey = "rank" | "title" | "url" | "providers" | "providerCount" | "bestRank" | "score" | "answerCitationCount" | "flags";
export type EvidenceTableColumn = {
    key: EvidenceTableColumnKey;
    label: string;
    description: string;
};
export type FusionEvidenceProvider = {
    providerId: string;
    rawRank: number;
    score: number;
    nativeScore?: number;
    sourceType: SearchResultSourceType;
    snippet?: string;
    truncated?: true;
    snippetSource?: "provider" | "answer-fallback";
    flags: SearchResultFlag[];
};
export type FusionEvidenceCitationSupport = {
    count: number;
    providerCount: number;
    providers: string[];
};
export type FusionEvidenceRow = {
    rowId: string;
    rank: number;
    title: string;
    url: string;
    canonicalUrl: string;
    siteName?: string;
    snippet?: string;
    truncated?: true;
    providers: string[];
    providerCount: number;
    bestRank: number;
    score: number;
    flags: SearchResultFlag[];
    answerCitationSupport: FusionEvidenceCitationSupport;
    providerEvidence: FusionEvidenceProvider[];
};
export type FusionEvidenceTable = {
    version: 1;
    columns: EvidenceTableColumn[];
    rowCount: number;
    rows: FusionEvidenceRow[];
};
export type SearchRuntime = {
    webSearch: {
        listProviders: (params?: {
            config?: unknown;
        }) => RuntimeWebSearchProvider[];
        search: (params: {
            config?: unknown;
            providerId?: string;
            args: Record<string, unknown>;
            signal?: AbortSignal;
            agentDir?: string;
            runtimeWebSearch?: unknown;
        }) => Promise<{
            provider: string;
            result: Record<string, unknown>;
        }>;
    };
};
export type FusionSearchPayload = {
    query: string;
    provider: "search-fusion";
    tookMs: number;
    count: number;
    configuredProviders: string[];
    providersQueried: string[];
    providersSucceeded: string[];
    providersFailed: Array<{
        provider: string;
        error: string;
    }>;
    providerDetails: Array<{
        provider: string;
        ok: boolean;
        tookMs: number;
        rawCount: number;
        discardedCount: number;
        attempts: number;
        configured: boolean;
        error?: string;
    }>;
    providerRuns: Array<{
        provider: string;
        ok: boolean;
        tookMs: number;
        rawCount: number;
        discardedCount: number;
        attempts: number;
        configured: boolean;
        error?: string;
        answer?: ProviderAnswerDigest;
        results: NormalizedSearchResult[];
        discardedResults: DiscardedSearchResult[];
        rawPayload?: Record<string, unknown>;
        retryHistory: ProviderRetryEvent[];
    }>;
    discardedResults: DiscardedSearchResult[];
    answers: ProviderAnswerDigest[];
    results: FusionMergedResult[];
    ranking: FusionRankingMeta;
    evidenceTable: FusionEvidenceTable;
    output: {
        includeRawPayloads: boolean;
        includeDiscarded: boolean;
        maxSnippetLength: number;
    };
    externalContent: {
        untrusted: true;
        source: "web_search";
        provider: "search-fusion";
        aggregated: true;
    };
};
