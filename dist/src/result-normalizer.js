import { classifySourceTier, coerceSourceTierMode, sourceTierMultiplier, } from "./source-tier.js";
import { analyzeUrl, canonicalDedupeHost, cleanProviderText, isWebUrl, resolveSiteName, truncate } from "./text.js";
const DEFAULT_MAX_SNIPPET_LENGTH = 500;
/** Answer digests are whole synthesized answers, so they get a larger cap than per-page snippets. */
export const DEFAULT_MAX_ANSWER_LENGTH = 2000;
export const MAX_ANSWER_LENGTH_LIMIT = 10000;
function limitText(value, maxLength) {
    if (!value)
        return { truncated: false };
    const limited = truncate(value, maxLength);
    return { value: limited, truncated: limited !== value };
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function firstString(obj, keys) {
    if (!obj)
        return undefined;
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}
function firstNumber(obj, keys) {
    if (!obj)
        return undefined;
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}
/**
 * First provider text field that still has usable text after cleaning for
 * model-visible output. Empty, whitespace-only, non-string, or wrapper-only
 * fields are skipped so a later field can supply the value.
 */
function firstCleanText(obj, keys) {
    if (!obj)
        return undefined;
    for (const key of keys) {
        const cleaned = cleanProviderText(obj[key]);
        if (cleaned)
            return cleaned;
    }
    return undefined;
}
function titleFromUrl(url) {
    try {
        return new URL(url).hostname.replace(/^www\./i, "");
    }
    catch {
        return url;
    }
}
// Matched with every subdomain (m., music., new., np., player., vm., ...).
const VIDEO_DOMAINS = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com"];
const COMMUNITY_DOMAINS = ["reddit.com", "lobste.rs", "lemmy.world"];
function isHostOrSubdomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}
function detectItemFlags(obj, url) {
    const flags = new Set();
    if (obj) {
        const sponsorKeys = ["sponsored", "is_sponsored", "isSponsored", "ad", "is_ad", "isAd"];
        if (sponsorKeys.some((key) => obj[key] === true)) {
            flags.add("sponsored");
        }
    }
    try {
        // Classify on the dedupe host so m.youtube.com, np.reddit.com and similar
        // spellings get the same flags as the host they merge with.
        const host = canonicalDedupeHost(new URL(url).hostname);
        if (VIDEO_DOMAINS.some((domain) => isHostOrSubdomain(host, domain))) {
            flags.add("video");
        }
        if (COMMUNITY_DOMAINS.some((domain) => isHostOrSubdomain(host, domain)) ||
            host === "news.ycombinator.com" ||
            host.startsWith("forum.") ||
            host.startsWith("forums.") ||
            host.startsWith("discuss.") ||
            host.startsWith("community.")) {
            flags.add("community");
        }
    }
    catch {
        // ignore malformed URLs
    }
    return [...flags].sort();
}
function mergeFlags(...flagLists) {
    return [...new Set(flagLists.flatMap((flags) => [...flags]))].sort();
}
function sourceTypeWeight(sourceType) {
    switch (sourceType) {
        case "results":
            return 1;
        case "sources":
            return 0.95;
        case "citations":
            return 0.72;
    }
}
function flagPenalty(flags) {
    let penalty = 0;
    if (flags.includes("sponsored"))
        penalty += 0.65;
    if (flags.includes("redirect-wrapper"))
        penalty += 0.12;
    if (flags.includes("community"))
        penalty += 0.1;
    if (flags.includes("video"))
        penalty += 0.1;
    if (flags.includes("tracking-stripped"))
        penalty += 0.02;
    return penalty;
}
function normalizeNativeScore(value, index) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.min(2, Math.max(0.05, value));
    }
    return Math.max(0.1, 1 - index * 0.08);
}
function mapResultArray(params) {
    const results = [];
    const discardedResults = [];
    params.items.forEach((item, index) => {
        const stringItem = typeof item === "string" ? item.trim() : "";
        const obj = asObject(item);
        const rawUrl = stringItem || firstString(obj, ["url", "link", "href"]);
        const cleanedProviderSnippet = cleanProviderText(firstString(obj, ["description", "snippet", "content", "body", "text", "summary"]));
        const providerSnippet = limitText(cleanedProviderSnippet || undefined, params.maxSnippetLength);
        const fallbackSnippet = limitText(params.fallbackSnippet, params.maxSnippetLength);
        const snippet = providerSnippet.value ?? fallbackSnippet.value;
        const snippetTruncated = providerSnippet.value
            ? providerSnippet.truncated
            : fallbackSnippet.truncated || params.fallbackTruncated === true;
        const analyzedUrl = rawUrl ? analyzeUrl(rawUrl) : undefined;
        // Only http(s) pages become results. Other schemes (javascript:, data:,
        // file:, ...) and free text, including targets unwrapped from a redirect
        // link, would otherwise reach UIs and models as clickable result links.
        if (!analyzedUrl || !isWebUrl(analyzedUrl.url)) {
            discardedResults.push({
                providerId: params.providerId,
                sourceType: params.sourceType,
                rawRank: index + 1,
                reason: analyzedUrl ? "unsupported-url" : "missing-url",
                title: firstCleanText(obj, ["title", "name", "headline", "label"]),
                snippet,
                ...(snippetTruncated ? { truncated: true } : {}),
                rawItem: item,
            });
            return;
        }
        const itemFlags = detectItemFlags(obj, analyzedUrl.url);
        const flags = mergeFlags(analyzedUrl.flags, itemFlags);
        const sourceTier = classifySourceTier({ sourceType: params.sourceType, flags });
        const title = firstCleanText(obj, ["title", "name", "headline", "label"]) ??
            cleanProviderText(titleFromUrl(analyzedUrl.url));
        const nativeScore = firstNumber(obj, ["score", "confidence", "relevance"]);
        const baseScore = normalizeNativeScore(nativeScore, index);
        const preTierScore = Math.max(0.05, baseScore * sourceTypeWeight(params.sourceType) - flagPenalty(flags));
        const score = Math.max(0.01, preTierScore * sourceTierMultiplier(sourceTier, params.sourceTierMode));
        results.push({
            title,
            url: analyzedUrl.url,
            originalUrl: analyzedUrl.originalUrl,
            canonicalUrl: analyzedUrl.canonicalUrl,
            snippet,
            ...(snippetTruncated ? { truncated: true } : {}),
            siteName: firstCleanText(obj, ["siteName", "site", "domain"]) ?? resolveSiteName(analyzedUrl.url),
            providerId: params.providerId,
            score,
            nativeScore,
            rawRank: index + 1,
            sourceType: params.sourceType,
            sourceTier,
            snippetSource: providerSnippet.value ? "provider" : params.fallbackSnippet ? "answer-fallback" : undefined,
            flags,
            rawItem: item,
        });
    });
    return { results, discardedResults };
}
function buildCitationDetails(citationsRaw) {
    return citationsRaw.flatMap((entry) => {
        if (typeof entry === "string") {
            const analyzed = analyzeUrl(entry.trim());
            return isWebUrl(analyzed.url) ? [{ url: analyzed.url, raw: entry }] : [];
        }
        const obj = asObject(entry);
        const url = firstString(obj, ["url", "link", "href"]);
        if (!url)
            return [];
        const analyzed = analyzeUrl(url);
        if (!isWebUrl(analyzed.url))
            return [];
        return [
            {
                url: analyzed.url,
                title: firstCleanText(obj, ["title", "name", "headline", "label"]),
                raw: entry,
            },
        ];
    });
}
export function extractProviderAnswer(payload, providerId, maxAnswerLength = DEFAULT_MAX_ANSWER_LENGTH) {
    const rawFullContent = firstCleanText(payload, ["content", "answer"]);
    if (!rawFullContent)
        return undefined;
    const fullContent = truncate(rawFullContent, maxAnswerLength);
    const summaryMaxLength = Math.min(320, maxAnswerLength);
    const citationsRaw = Array.isArray(payload.citations) ? payload.citations : [];
    const citationDetails = buildCitationDetails(citationsRaw);
    return {
        providerId,
        summary: truncate(rawFullContent, summaryMaxLength),
        fullContent,
        summaryTruncated: rawFullContent.length > summaryMaxLength,
        ...(rawFullContent.length > maxAnswerLength ? { truncated: true } : {}),
        citations: citationDetails.map((entry) => entry.url),
        citationDetails,
    };
}
export function normalizeProviderPayload(params) {
    const payload = params.payload;
    const maxSnippetLength = Math.max(100, Math.min(5000, params.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH));
    const maxAnswerLength = Math.max(100, Math.min(MAX_ANSWER_LENGTH_LIMIT, params.maxAnswerLength ?? DEFAULT_MAX_ANSWER_LENGTH));
    const answer = extractProviderAnswer(payload, params.providerId, maxAnswerLength);
    const sourceTierMode = coerceSourceTierMode(params.sourceTierMode);
    const resultArrays = [];
    const discardedArrays = [];
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
        ? asObject(payload.web)?.results
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
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
    const error = errorParts.length > 0 && resultArrays.length === 0 && discardedArrays.length === 0 && !answer
        ? errorParts.join(": ")
        : undefined;
    return { results: resultArrays, discardedResults: discardedArrays, answer, error };
}
