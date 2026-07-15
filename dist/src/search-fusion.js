import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { discoverProviders, resolveSelectedProviders } from "./provider-discovery.js";
import { normalizeProviderPayload } from "./result-normalizer.js";
import { compareSourceTierDesc, coerceSourceTierMode, pickHigherSourceTier, sourceTierMergedAdjustment, } from "./source-tier.js";
import { canonicalizeUrl } from "./text.js";
const DEFAULT_COUNT_PER_PROVIDER = 5;
const DEFAULT_MAX_MERGED_RESULTS = 10;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SNIPPET_LENGTH = 500;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 750;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5000;
const DEFAULT_PROVIDER_WEIGHT = 1;
const MIN_PROVIDER_WEIGHT = 0.1;
const MAX_PROVIDER_WEIGHT = 5;
const SEARCH_FUSION_PROVIDER_ID = "search-fusion";
const MERGED_RANKING_STRATEGY = "merged-score-v1";
const MERGED_SORT_ORDER = ["score:desc", "bestRank:asc", "providerCount:desc", "title:asc"];
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSecretRefLike(value) {
    if (!isRecord(value)) {
        return false;
    }
    return ((value.source === "env" || value.source === "file" || value.source === "exec") &&
        typeof value.id === "string" &&
        value.id.trim().length > 0);
}
function cloneConfigForCredentialInjection(config) {
    if (!isRecord(config)) {
        return config;
    }
    return structuredClone(config);
}
function resolveSearchConfig(config) {
    const tools = isRecord(config) ? config.tools : undefined;
    const web = isRecord(tools) ? tools.web : undefined;
    const search = isRecord(web) ? web.search : undefined;
    return isRecord(search) ? search : undefined;
}
function applySearchConfigContext(config, searchConfig) {
    if (!searchConfig || !isRecord(config))
        return config;
    if (resolveSearchConfig(config) === searchConfig)
        return config;
    const tools = isRecord(config.tools) ? config.tools : {};
    const web = isRecord(tools.web) ? tools.web : {};
    return {
        ...config,
        tools: {
            ...tools,
            web: {
                ...web,
                search: searchConfig,
            },
        },
    };
}
async function resolveRuntimeSourceConfig(fallback) {
    try {
        const runtimeConfig = await import("openclaw/plugin-sdk/config-runtime");
        const getSourceSnapshot = runtimeConfig.getRuntimeConfigSourceSnapshot;
        if (typeof getSourceSnapshot === "function") {
            return getSourceSnapshot() ?? fallback;
        }
    }
    catch {
        // Older OpenClaw SDKs do not expose source snapshots to plugins.
    }
    return fallback;
}
async function resolveSecretRefValue(params) {
    const { resolveConfiguredSecretInputString } = await import("openclaw/plugin-sdk/config-runtime");
    const resolved = await resolveConfiguredSecretInputString({
        config: params.config,
        env: process.env,
        value: params.value,
        path: params.path,
        unresolvedReasonStyle: "detailed",
    });
    if (!resolved.value) {
        throw new Error(resolved.unresolvedRefReason ?? `${params.path} SecretRef is unresolved.`);
    }
    return resolved.value;
}
async function resolveDelegatedRuntimeConfig(params) {
    const runtimeProvider = params.runtimeProviders.find((entry) => entry.id === params.provider.id);
    if (!runtimeProvider || runtimeProvider.requiresCredential === false) {
        return params.runtimeConfig;
    }
    const configuredCredential = runtimeProvider.getConfiguredCredentialValue?.(params.runtimeConfig);
    const sourceConfiguredCredential = runtimeProvider.getConfiguredCredentialValue?.(params.sourceConfig);
    if (isSecretRefLike(configuredCredential) &&
        runtimeProvider.setConfiguredCredentialValue) {
        const clonedConfig = cloneConfigForCredentialInjection(params.runtimeConfig);
        const resolvedValue = await resolveSecretRefValue({
            config: params.sourceConfig,
            value: configuredCredential,
            path: runtimeProvider.credentialPath ?? `plugins.entries.${params.provider.id}.config.webSearch.apiKey`,
        });
        runtimeProvider.setConfiguredCredentialValue(clonedConfig, resolvedValue);
        return clonedConfig;
    }
    if (configuredCredential !== undefined) {
        return params.runtimeConfig;
    }
    if (isSecretRefLike(sourceConfiguredCredential) &&
        runtimeProvider.setConfiguredCredentialValue) {
        const clonedConfig = cloneConfigForCredentialInjection(params.sourceConfig);
        const resolvedValue = await resolveSecretRefValue({
            config: params.sourceConfig,
            value: sourceConfiguredCredential,
            path: runtimeProvider.credentialPath ?? `plugins.entries.${params.provider.id}.config.webSearch.apiKey`,
        });
        runtimeProvider.setConfiguredCredentialValue(clonedConfig, resolvedValue);
        return clonedConfig;
    }
    if (sourceConfiguredCredential !== undefined) {
        return params.sourceConfig;
    }
    const searchConfig = resolveSearchConfig(params.runtimeConfig);
    const searchCredential = runtimeProvider.getCredentialValue?.(searchConfig);
    const sourceSearchConfig = resolveSearchConfig(params.sourceConfig);
    const sourceSearchCredential = runtimeProvider.getCredentialValue?.(sourceSearchConfig);
    if (isSecretRefLike(searchCredential) && runtimeProvider.setCredentialValue) {
        const clonedConfig = cloneConfigForCredentialInjection(params.runtimeConfig);
        const clonedSearchConfig = resolveSearchConfig(clonedConfig);
        if (!clonedSearchConfig) {
            return params.runtimeConfig;
        }
        const resolvedValue = await resolveSecretRefValue({
            config: params.sourceConfig,
            value: searchCredential,
            path: runtimeProvider.credentialPath ?? `tools.web.search.${params.provider.id}.apiKey`,
        });
        runtimeProvider.setCredentialValue(clonedSearchConfig, resolvedValue);
        return clonedConfig;
    }
    if (searchCredential !== undefined) {
        return params.runtimeConfig;
    }
    if (isSecretRefLike(sourceSearchCredential) && runtimeProvider.setCredentialValue) {
        const clonedConfig = cloneConfigForCredentialInjection(params.sourceConfig);
        const clonedSearchConfig = resolveSearchConfig(clonedConfig);
        if (!clonedSearchConfig) {
            return params.sourceConfig;
        }
        const resolvedValue = await resolveSecretRefValue({
            config: params.sourceConfig,
            value: sourceSearchCredential,
            path: runtimeProvider.credentialPath ?? `tools.web.search.${params.provider.id}.apiKey`,
        });
        runtimeProvider.setCredentialValue(clonedSearchConfig, resolvedValue);
        return clonedConfig;
    }
    if (sourceSearchCredential !== undefined) {
        return params.sourceConfig;
    }
    return params.runtimeConfig;
}
const EVIDENCE_TABLE_COLUMNS = [
    {
        key: "rank",
        label: "Rank",
        description: "Merged ordering position after dedupe and score computation.",
    },
    {
        key: "title",
        label: "Title",
        description: "Best available title for the merged URL.",
    },
    {
        key: "url",
        label: "URL",
        description: "Display URL for the merged hit.",
    },
    {
        key: "providers",
        label: "Providers",
        description: "Provider ids that independently surfaced this URL.",
    },
    {
        key: "providerCount",
        label: "Provider Count",
        description: "How many providers corroborated this URL.",
    },
    {
        key: "bestRank",
        label: "Best Rank",
        description: "Best raw rank observed across providers.",
    },
    {
        key: "score",
        label: "Merged Score",
        description: "Final broker score used for merged ordering.",
    },
    {
        key: "answerCitationCount",
        label: "Answer Citations",
        description: "How many answer-style provider citations referenced this URL.",
    },
    {
        key: "flags",
        label: "Flags",
        description: "Deterministic flags inferred during normalization and merge.",
    },
];
class DeadlineExceededError extends Error {
    name = "DeadlineExceededError";
    constructor() {
        super("deadline exceeded");
    }
}
class ProviderTimeoutError extends Error {
    name = "ProviderTimeoutError";
    constructor(providerId, timeoutMs) {
        super(`Provider ${providerId} timed out after ${timeoutMs}ms`);
    }
}
function createAbortError(reason) {
    if (reason instanceof Error)
        return reason;
    const error = new Error(typeof reason === "string" && reason ? reason : "Search aborted");
    error.name = "AbortError";
    return error;
}
function throwIfAborted(signal) {
    if (signal.aborted) {
        throw createAbortError(signal.reason);
    }
}
function relayAbort(source, target) {
    if (!source)
        return () => { };
    const abort = () => target.abort(createAbortError(source.reason));
    if (source.aborted) {
        abort();
        return () => { };
    }
    source.addEventListener("abort", abort, { once: true });
    return () => source.removeEventListener("abort", abort);
}
function raceWithSignal(promise, signal) {
    if (signal.aborted)
        return Promise.reject(createAbortError(signal.reason));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(createAbortError(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        void promise.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}
function sleep(ms, signal) {
    if (ms <= 0) {
        throwIfAborted(signal);
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function asConfig(pluginConfig) {
    return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
        ? pluginConfig
        : {};
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function roundScore(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
function applyProviderWeight(score, weight) {
    return Math.max(0.01, roundScore(score * weight));
}
function resolveProviderConfig(config, providerId) {
    return config.providerConfig?.[providerId] ?? {};
}
function resolveRetryConfig(config, providerId) {
    const globalRetry = config.retry ?? {};
    const legacyProviderRetry = config.providerRetries?.[providerId] ?? {};
    const providerRetry = resolveProviderConfig(config, providerId).retry ?? {};
    const merged = {
        ...globalRetry,
        ...legacyProviderRetry,
        ...providerRetry,
    };
    return {
        maxAttempts: clamp(merged.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS, 1, 10),
        backoffMs: clamp(merged.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS, 0, 30000),
        backoffMultiplier: clamp(merged.backoffMultiplier ?? DEFAULT_RETRY_BACKOFF_MULTIPLIER, 1, 10),
        maxBackoffMs: clamp(merged.maxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS, 0, 120000),
    };
}
function resolveRuntimeProviderConfig(request, config, providerId) {
    const providerConfig = resolveProviderConfig(config, providerId);
    return {
        count: clamp(request.count ?? providerConfig.count ?? config.countPerProvider ?? DEFAULT_COUNT_PER_PROVIDER, 1, 10),
        timeoutMs: clamp(providerConfig.timeoutMs ?? config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS, 1000, 120000),
        retry: resolveRetryConfig(config, providerId),
        weight: clamp(providerConfig.weight ?? DEFAULT_PROVIDER_WEIGHT, MIN_PROVIDER_WEIGHT, MAX_PROVIDER_WEIGHT),
    };
}
function buildProviderArgs(request, config, providerId) {
    const providerConfig = resolveRuntimeProviderConfig(request, config, providerId);
    return {
        query: request.query,
        count: providerConfig.count,
        country: request.country,
        language: request.language,
        freshness: request.freshness,
        date_after: request.date_after,
        date_before: request.date_before,
        search_lang: request.search_lang,
        ui_lang: request.ui_lang,
    };
}
async function runProviderAttempt(params) {
    const controller = new AbortController();
    const removeParentRelay = relayAbort(params.parentSignal, controller);
    const timer = setTimeout(() => controller.abort(new ProviderTimeoutError(params.providerId, params.timeoutMs)), params.timeoutMs);
    try {
        throwIfAborted(controller.signal);
        return await raceWithSignal(params.execute(controller.signal), controller.signal);
    }
    finally {
        clearTimeout(timer);
        removeParentRelay();
    }
}
function asErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error.length > 0) {
        return error;
    }
    if (error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.length > 0) {
        return error.message;
    }
    try {
        const rendered = String(error);
        if (rendered.length > 0 && rendered !== "[object Object]") {
            return rendered;
        }
    }
    catch {
        // Ignore stringify errors and fall back to a generic message.
    }
    return "Unknown error";
}
function isProviderRunTaskRejection(value) {
    return (value !== null &&
        typeof value === "object" &&
        "tookMs" in value &&
        typeof value.tookMs === "number" &&
        "error" in value);
}
function asUnhandledProviderFailure(params) {
    return {
        providerId: params.provider.id,
        label: params.provider.label,
        configured: params.provider.configured,
        ok: false,
        tookMs: Math.max(0, params.tookMs),
        rawCount: 0,
        attempts: 1,
        results: [],
        discardedResults: [],
        retryHistory: [],
        error: asErrorMessage(params.error),
    };
}
function isAbortError(error) {
    return (error instanceof DeadlineExceededError ||
        error instanceof ProviderTimeoutError ||
        (error instanceof Error && error.name === "AbortError"));
}
function shouldRetry(error, errorMessage) {
    if (isAbortError(error))
        return false;
    const nonRetriablePatterns = [
        /401\b/,
        /403\b/,
        /400\b/,
        /404\b/,
        /409\b/,
        /422\b/,
        /unauthorized/i,
        /forbidden/i,
        /invalid api key/i,
        /api key/i,
        /credential/i,
        /unknown provider/i,
        /unsupported/i,
        /bad request/i,
        /not found/i,
    ];
    return !nonRetriablePatterns.some((pattern) => pattern.test(errorMessage));
}
function computeBackoffDelay(policy, attempt) {
    if (policy.backoffMs <= 0)
        return 0;
    return Math.min(policy.maxBackoffMs, Math.round(policy.backoffMs * Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1))));
}
function computeRetryDelay(policy, attempt, errorMessage) {
    const configured = computeBackoffDelay(policy, attempt);
    return /429|rate limit/i.test(errorMessage) ? Math.max(2000, configured) : configured;
}
function mergeFlags(...flagLists) {
    return [...new Set(flagLists.flatMap((flags) => [...flags]))].sort();
}
function mergedFlagPenalty(flags) {
    let penalty = 0;
    if (flags.includes("sponsored"))
        penalty += 0.65;
    if (flags.includes("redirect-wrapper"))
        penalty += 0.1;
    if (flags.includes("community"))
        penalty += 0.08;
    if (flags.includes("video"))
        penalty += 0.08;
    if (flags.includes("tracking-stripped"))
        penalty += 0.02;
    return penalty;
}
function mergedSortOrder(sourceTierMode) {
    return sourceTierMode === "off"
        ? [...MERGED_SORT_ORDER]
        : ["score:desc", "bestSourceTier:desc", "bestRank:asc", "providerCount:desc", "title:asc"];
}
function computeMergedScoreBreakdown(entry, sourceTierMode) {
    const bestVariantScore = entry.variants.reduce((max, variant) => Math.max(max, variant.score), 0);
    const corroborationBonus = Math.max(0, entry.providerCount - 1) * 0.12;
    const bestRankBonus = Math.max(0, 0.35 - (entry.bestRank - 1) * 0.04);
    const tierAdjustment = sourceTierMergedAdjustment(entry.bestSourceTier, sourceTierMode);
    const flagPenalty = mergedFlagPenalty(entry.flags);
    return {
        bestVariantScore,
        corroborationBonus,
        bestRankBonus,
        tierAdjustment,
        flagPenalty,
        finalScore: Math.max(0.01, bestVariantScore + corroborationBonus + bestRankBonus + tierAdjustment - flagPenalty),
    };
}
function compareMergedCandidates(a, b, sourceTierMode) {
    if (b.score !== a.score)
        return b.score - a.score;
    if (sourceTierMode !== "off") {
        const tierDelta = compareSourceTierDesc(a.bestSourceTier, b.bestSourceTier);
        if (tierDelta !== 0)
            return tierDelta;
    }
    if (a.bestRank !== b.bestRank)
        return a.bestRank - b.bestRank;
    if (b.providerCount !== a.providerCount)
        return b.providerCount - a.providerCount;
    return a.title.localeCompare(b.title);
}
function buildRankingExplanation(params) {
    return {
        strategy: MERGED_RANKING_STRATEGY,
        rank: params.rank,
        scoreBreakdown: params.scoreBreakdown,
        tieBreakers: {
            bestSourceTier: params.bestSourceTier,
            bestRank: params.bestRank,
            providerCount: params.providerCount,
            title: params.title,
        },
    };
}
function emptyRankingMeta(sourceTierMode) {
    return {
        strategy: MERGED_RANKING_STRATEGY,
        sortOrder: mergedSortOrder(sourceTierMode),
        consideredCount: 0,
        returnedCount: 0,
        droppedCount: 0,
        dropped: [],
    };
}
function mergeResults(results, maxMergedResults, sourceTierMode) {
    const merged = new Map();
    for (const provider of results) {
        for (const item of provider.results) {
            const existing = merged.get(item.canonicalUrl);
            if (!existing) {
                merged.set(item.canonicalUrl, {
                    title: item.title,
                    url: item.url,
                    canonicalUrl: item.canonicalUrl,
                    snippet: item.snippet,
                    truncated: item.truncated,
                    siteName: item.siteName,
                    providers: [item.providerId],
                    providerCount: 1,
                    bestRank: item.rawRank,
                    bestSourceTier: item.sourceTier,
                    flags: [...item.flags],
                    rankings: [
                        {
                            providerId: item.providerId,
                            rawRank: item.rawRank,
                            score: item.score,
                            nativeScore: item.nativeScore,
                            sourceType: item.sourceType,
                            sourceTier: item.sourceTier,
                            flags: [...item.flags],
                        },
                    ],
                    variants: [item],
                });
                continue;
            }
            existing.variants.push(item);
            if (!existing.providers.includes(item.providerId)) {
                existing.providers.push(item.providerId);
            }
            existing.providerCount = existing.providers.length;
            existing.bestRank = Math.min(existing.bestRank, item.rawRank);
            existing.bestSourceTier = pickHigherSourceTier(existing.bestSourceTier, item.sourceTier);
            existing.flags = mergeFlags(existing.flags, item.flags);
            existing.rankings.push({
                providerId: item.providerId,
                rawRank: item.rawRank,
                score: item.score,
                nativeScore: item.nativeScore,
                sourceType: item.sourceType,
                sourceTier: item.sourceTier,
                flags: [...item.flags],
            });
            if ((!existing.snippet || existing.snippet.length < (item.snippet?.length ?? 0)) && item.snippet) {
                existing.snippet = item.snippet;
                existing.truncated = item.truncated;
            }
            if (existing.title.length < item.title.length) {
                existing.title = item.title;
            }
            if (!existing.siteName && item.siteName) {
                existing.siteName = item.siteName;
            }
        }
    }
    const rankedCandidates = [...merged.values()]
        .map((entry) => {
        const normalized = {
            ...entry,
            providers: [...entry.providers].sort(),
            providerCount: entry.providers.length,
            flags: [...entry.flags].sort(),
            rankings: [...entry.rankings].sort((a, b) => {
                if (a.rawRank !== b.rawRank)
                    return a.rawRank - b.rawRank;
                if (sourceTierMode !== "off") {
                    const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
                    if (tierDelta !== 0)
                        return tierDelta;
                }
                return a.providerId.localeCompare(b.providerId);
            }),
            variants: [...entry.variants].sort((a, b) => {
                if (a.rawRank !== b.rawRank)
                    return a.rawRank - b.rawRank;
                if (b.score !== a.score)
                    return b.score - a.score;
                if (sourceTierMode !== "off") {
                    const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
                    if (tierDelta !== 0)
                        return tierDelta;
                }
                return a.providerId.localeCompare(b.providerId);
            }),
        };
        const scoreBreakdown = computeMergedScoreBreakdown(normalized, sourceTierMode);
        return {
            ...normalized,
            score: scoreBreakdown.finalScore,
            scoreBreakdown,
        };
    })
        .sort((a, b) => compareMergedCandidates(a, b, sourceTierMode));
    const mergedResults = rankedCandidates
        .slice(0, maxMergedResults)
        .map((entry, index) => {
        const { scoreBreakdown, ...base } = entry;
        return {
            ...base,
            ranking: buildRankingExplanation({
                rank: index + 1,
                title: base.title,
                bestRank: base.bestRank,
                bestSourceTier: base.bestSourceTier,
                providerCount: base.providerCount,
                scoreBreakdown,
            }),
        };
    });
    const dropped = rankedCandidates.slice(maxMergedResults).map((entry, index) => ({
        rank: maxMergedResults + index + 1,
        reason: "maxMergedResults",
        title: entry.title,
        url: entry.url,
        canonicalUrl: entry.canonicalUrl,
        score: entry.score,
        bestRank: entry.bestRank,
        providerCount: entry.providerCount,
    }));
    return {
        results: mergedResults,
        ranking: rankedCandidates.length === 0
            ? emptyRankingMeta(sourceTierMode)
            : {
                strategy: MERGED_RANKING_STRATEGY,
                sortOrder: mergedSortOrder(sourceTierMode),
                consideredCount: rankedCandidates.length,
                returnedCount: mergedResults.length,
                droppedCount: dropped.length,
                dropped,
            },
    };
}
function buildEvidenceTable(results, answers) {
    const citationSupportByUrl = new Map();
    for (const answer of answers) {
        for (const citationUrl of answer.citations) {
            const canonicalCitationUrl = canonicalizeUrl(citationUrl);
            if (!canonicalCitationUrl) {
                continue;
            }
            const existing = citationSupportByUrl.get(canonicalCitationUrl);
            if (existing) {
                existing.count += 1;
                existing.providers.add(answer.providerId);
                continue;
            }
            citationSupportByUrl.set(canonicalCitationUrl, {
                count: 1,
                providers: new Set([answer.providerId]),
            });
        }
    }
    const rows = results.map((result, index) => {
        const citationSupport = citationSupportByUrl.get(result.canonicalUrl);
        const citationProviders = citationSupport ? [...citationSupport.providers].sort() : [];
        return {
            rowId: result.canonicalUrl,
            rank: index + 1,
            title: result.title,
            url: result.url,
            canonicalUrl: result.canonicalUrl,
            siteName: result.siteName,
            snippet: result.snippet,
            truncated: result.truncated,
            providers: [...result.providers],
            providerCount: result.providerCount,
            bestRank: result.bestRank,
            score: result.score,
            flags: [...result.flags],
            answerCitationSupport: {
                count: citationSupport?.count ?? 0,
                providerCount: citationProviders.length,
                providers: citationProviders,
            },
            providerEvidence: result.variants.map((variant) => ({
                providerId: variant.providerId,
                rawRank: variant.rawRank,
                score: variant.score,
                nativeScore: variant.nativeScore,
                sourceType: variant.sourceType,
                snippet: variant.snippet,
                truncated: variant.truncated,
                snippetSource: variant.snippetSource,
                flags: [...variant.flags],
            })),
        };
    });
    return {
        version: 1,
        columns: EVIDENCE_TABLE_COLUMNS.map((column) => ({ ...column })),
        rowCount: rows.length,
        rows,
    };
}
async function runProvider(params) {
    const start = Date.now();
    const providerConfig = resolveRuntimeProviderConfig(params.request, params.brokerConfig, params.provider.id);
    const retryPolicy = providerConfig.retry;
    const providerArgs = buildProviderArgs(params.request, params.brokerConfig, params.provider.id);
    const retryHistory = [];
    let lastError;
    let lastRawPayload;
    let attempts = 0;
    const failure = (error) => ({
        providerId: params.provider.id,
        label: params.provider.label,
        configured: params.provider.configured,
        ok: false,
        tookMs: Date.now() - start,
        rawCount: 0,
        attempts: Math.max(1, attempts),
        rawPayload: lastRawPayload,
        results: [],
        discardedResults: [],
        retryHistory,
        error,
    });
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        attempts = attempt;
        if (Date.now() >= params.deadlineAt) {
            return failure("deadline exceeded");
        }
        if (params.signal.aborted) {
            return failure(params.signal.reason instanceof DeadlineExceededError
                ? "deadline exceeded"
                : asErrorMessage(createAbortError(params.signal.reason)));
        }
        try {
            const remainingMs = Math.max(1, params.deadlineAt - Date.now());
            const attemptTimeoutMs = Math.min(providerConfig.timeoutMs, remainingMs);
            const response = await runProviderAttempt({
                providerId: params.provider.id,
                timeoutMs: attemptTimeoutMs,
                parentSignal: params.signal,
                execute: async (signal) => await params.runtime.webSearch.search({
                    config: params.config,
                    providerId: params.provider.id,
                    args: providerArgs,
                    signal,
                    agentDir: params.agentDir,
                    runtimeWebSearch: params.runtimeMetadata,
                }),
            });
            lastRawPayload = response.result;
            const normalized = normalizeProviderPayload({
                providerId: params.provider.id,
                payload: response.result,
                sourceTierMode: params.sourceTierMode,
                maxSnippetLength: params.maxSnippetLength,
            });
            if (normalized.error) {
                throw new Error(normalized.error);
            }
            const weightedResults = normalized.results.map((result) => ({
                ...result,
                score: applyProviderWeight(result.score, providerConfig.weight),
            }));
            return {
                providerId: params.provider.id,
                label: params.provider.label,
                configured: params.provider.configured,
                ok: true,
                tookMs: Date.now() - start,
                rawCount: normalized.results.length,
                attempts: attempt,
                rawPayload: response.result,
                results: weightedResults,
                discardedResults: normalized.discardedResults,
                answer: normalized.answer,
                retryHistory,
            };
        }
        catch (error) {
            const deadlineExceeded = error instanceof DeadlineExceededError ||
                params.signal.reason instanceof DeadlineExceededError ||
                Date.now() >= params.deadlineAt;
            lastError = deadlineExceeded ? "deadline exceeded" : asErrorMessage(error);
            const canRetry = !params.signal.aborted &&
                !deadlineExceeded &&
                attempt < retryPolicy.maxAttempts &&
                shouldRetry(error, lastError);
            if (!canRetry) {
                return failure(lastError);
            }
            const delayMs = computeRetryDelay(retryPolicy, attempt, lastError);
            if (Date.now() + delayMs >= params.deadlineAt) {
                return failure("deadline exceeded");
            }
            retryHistory.push({ attempt, error: lastError, delayMs });
            try {
                await sleep(delayMs, params.signal);
            }
            catch (sleepError) {
                return failure(params.signal.reason instanceof DeadlineExceededError
                    ? "deadline exceeded"
                    : asErrorMessage(sleepError));
            }
        }
    }
    return failure(lastError ?? "Unknown error");
}
function exposeResult(result, includeRaw) {
    if (includeRaw)
        return result;
    const { rawItem: _rawItem, ...visible } = result;
    void _rawItem;
    return visible;
}
function exposeAnswer(answer, includeRaw) {
    if (includeRaw)
        return answer;
    return {
        ...answer,
        citationDetails: answer.citationDetails.map(({ raw: _raw, ...citation }) => {
            void _raw;
            return citation;
        }),
    };
}
function exposeMergedResult(result, includeRaw) {
    return {
        ...result,
        variants: result.variants.map((variant) => exposeResult(variant, includeRaw)),
    };
}
export async function runSearchFusion(params) {
    const start = Date.now();
    const brokerConfig = asConfig(params.pluginConfig);
    const sourceTierMode = coerceSourceTierMode(brokerConfig.sourceTierMode);
    const includeRawPayloads = params.request.includeRawPayloads ?? brokerConfig.includeRawPayloads ?? false;
    const includeDiscarded = params.request.includeDiscarded ?? brokerConfig.includeDiscarded ?? false;
    const maxSnippetLength = clamp(brokerConfig.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH, 100, 5000);
    const output = { includeRawPayloads, includeDiscarded, maxSnippetLength };
    const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
    const runtimeConfig = applySearchConfigContext(runtimeConfigSnapshot ?? params.contextConfig ?? params.config, params.searchConfig);
    const sourceConfig = await resolveRuntimeSourceConfig(params.config);
    const runtimeProviders = params.runtime.webSearch.listProviders({ config: runtimeConfig });
    const availableProviders = discoverProviders({
        providers: runtimeProviders,
        config: sourceConfig,
        fallbackConfig: runtimeConfig,
        catalogConfig: runtimeConfig,
        selfId: SEARCH_FUSION_PROVIDER_ID,
    });
    const selectedProviders = resolveSelectedProviders({
        availableProviders,
        requestMode: params.request.mode,
        requestProviders: params.request.providers,
        requestIntent: params.request.intent,
        config: brokerConfig,
    });
    if (selectedProviders.length === 0) {
        return {
            query: params.request.query,
            provider: SEARCH_FUSION_PROVIDER_ID,
            tookMs: Date.now() - start,
            count: 0,
            configuredProviders: availableProviders
                .filter((provider) => provider.configured)
                .map((provider) => provider.id),
            providersQueried: [],
            providersSucceeded: [],
            providersFailed: [],
            providerDetails: [],
            providerRuns: [],
            discardedResults: [],
            answers: [],
            results: [],
            ranking: emptyRankingMeta(sourceTierMode),
            evidenceTable: buildEvidenceTable([], []),
            output,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: SEARCH_FUSION_PROVIDER_ID,
                aggregated: true,
            },
        };
    }
    const maxMergedResults = clamp(params.request.maxMergedResults ?? brokerConfig.maxMergedResults ?? DEFAULT_MAX_MERGED_RESULTS, 1, 50);
    const totalTimeoutMs = clamp(brokerConfig.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS, 5000, 180000);
    const deadlineAt = start + totalTimeoutMs;
    const runController = new AbortController();
    const removeOuterRelay = relayAbort(params.signal, runController);
    const deadlineTimer = setTimeout(() => runController.abort(new DeadlineExceededError()), Math.max(0, deadlineAt - Date.now()));
    const providerRunTasks = selectedProviders.map((provider) => {
        const startedAt = Date.now();
        return {
            provider,
            startedAt,
            promise: raceWithSignal(resolveDelegatedRuntimeConfig({
                provider,
                runtimeProviders,
                runtimeConfig,
                sourceConfig,
            }).then((providerConfig) => runProvider({
                runtime: params.runtime,
                config: providerConfig,
                brokerConfig,
                request: params.request,
                provider,
                sourceTierMode,
                maxSnippetLength,
                signal: runController.signal,
                deadlineAt,
                agentDir: params.agentDir,
                runtimeMetadata: params.runtimeMetadata,
            })), runController.signal).catch((error) => {
                const rejection = {
                    error,
                    tookMs: Math.max(0, Date.now() - startedAt),
                };
                throw rejection;
            }),
        };
    });
    let settledProviderRuns;
    try {
        settledProviderRuns = await Promise.allSettled(providerRunTasks.map((task) => task.promise));
    }
    finally {
        clearTimeout(deadlineTimer);
        removeOuterRelay();
    }
    const providerRuns = settledProviderRuns.map((settled, index) => {
        if (settled.status === "fulfilled") {
            return settled.value;
        }
        const rejection = isProviderRunTaskRejection(settled.reason) ? settled.reason : undefined;
        return asUnhandledProviderFailure({
            provider: providerRunTasks[index].provider,
            tookMs: rejection?.tookMs ?? Math.max(0, Date.now() - providerRunTasks[index].startedAt),
            error: rejection?.error ?? settled.reason,
        });
    });
    const merged = mergeResults(providerRuns.filter((run) => run.ok), maxMergedResults, sourceTierMode);
    const mergedResults = merged.results;
    const internalDiscardedResults = providerRuns.flatMap((run) => run.discardedResults);
    const internalAnswers = providerRuns
        .map((run) => run.answer)
        .filter((answer) => Boolean(answer));
    const answers = internalAnswers.map((answer) => exposeAnswer(answer, includeRawPayloads));
    const visibleMergedResults = mergedResults.map((result) => exposeMergedResult(result, includeRawPayloads));
    const discardedResults = includeDiscarded
        ? internalDiscardedResults.map((result) => exposeResult(result, includeRawPayloads))
        : [];
    return {
        query: params.request.query,
        provider: SEARCH_FUSION_PROVIDER_ID,
        tookMs: Date.now() - start,
        count: mergedResults.length,
        configuredProviders: availableProviders.filter((provider) => provider.configured).map((provider) => provider.id),
        providersQueried: selectedProviders.map((provider) => provider.id),
        providersSucceeded: providerRuns.filter((run) => run.ok).map((run) => run.providerId),
        providersFailed: providerRuns
            .filter((run) => !run.ok && run.error)
            .map((run) => ({ provider: run.providerId, error: run.error ?? "Unknown error" })),
        providerDetails: providerRuns.map((run) => ({
            provider: run.providerId,
            ok: run.ok,
            tookMs: run.tookMs,
            rawCount: run.rawCount,
            discardedCount: run.discardedResults.length,
            attempts: run.attempts,
            configured: run.configured,
            error: run.error,
        })),
        providerRuns: providerRuns.map((run) => ({
            provider: run.providerId,
            ok: run.ok,
            tookMs: run.tookMs,
            rawCount: run.rawCount,
            discardedCount: run.discardedResults.length,
            attempts: run.attempts,
            configured: run.configured,
            error: run.error,
            answer: run.answer ? exposeAnswer(run.answer, includeRawPayloads) : undefined,
            results: run.results.map((result) => exposeResult(result, includeRawPayloads)),
            discardedResults: includeDiscarded
                ? run.discardedResults.map((result) => exposeResult(result, includeRawPayloads))
                : [],
            ...(includeRawPayloads ? { rawPayload: run.rawPayload } : {}),
            retryHistory: run.retryHistory,
        })),
        discardedResults,
        answers,
        results: visibleMergedResults,
        ranking: merged.ranking,
        evidenceTable: buildEvidenceTable(visibleMergedResults, answers),
        output,
        externalContent: {
            untrusted: true,
            source: "web_search",
            provider: SEARCH_FUSION_PROVIDER_ID,
            aggregated: true,
        },
    };
}
export function renderFusionSummary(payload, includeFailures = false) {
    const lines = [];
    lines.push(`Search broker ran ${payload.providersQueried.length} provider${payload.providersQueried.length === 1 ? "" : "s"} in ${payload.tookMs}ms.`);
    if (payload.results.length > 0) {
        lines.push("");
        lines.push(`Merged results (${payload.results.length}):`);
        payload.results.forEach((result, index) => {
            lines.push(`${index + 1}. ${result.title}`);
            lines.push(`   ${result.url}`);
            lines.push(`   Providers: ${result.providers.join(", ")} • Best rank: #${result.bestRank} • Source tier: ${result.bestSourceTier}`);
            if (result.flags.length > 0) {
                lines.push(`   Flags: ${result.flags.join(", ")}`);
            }
            if (result.snippet) {
                lines.push(`   ${result.snippet}`);
            }
        });
    }
    else {
        lines.push("");
        lines.push("No merged results.");
    }
    if (payload.discardedResults.length > 0) {
        lines.push("");
        lines.push(`Preserved ${payload.discardedResults.length} non-merged item${payload.discardedResults.length === 1 ? "" : "s"} as provenance evidence.`);
    }
    if (payload.answers.length > 0) {
        lines.push("");
        lines.push("Provider answer digests:");
        for (const answer of payload.answers) {
            lines.push(`- ${answer.providerId}: ${answer.summary}`);
        }
    }
    lines.push("");
    lines.push("Provider status:");
    for (const detail of payload.providerDetails) {
        if (!includeFailures && !detail.ok) {
            continue;
        }
        const attemptText = detail.attempts > 1 ? `, ${detail.attempts} attempts` : "";
        lines.push(`- ${detail.provider}: ${detail.ok ? `ok (${detail.rawCount} hits, ${detail.tookMs}ms${attemptText})` : `failed (${detail.tookMs}ms${attemptText})${detail.error ? ` — ${detail.error}` : ""}`}`);
    }
    if (includeFailures && payload.providersFailed.length > 0) {
        lines.push("");
        lines.push("Failures:");
        for (const failure of payload.providersFailed) {
            lines.push(`- ${failure.provider}: ${failure.error}`);
        }
    }
    return lines.join("\n");
}
