export const DEFAULT_TRACKING_PARAMS = [
    "utm_*",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
    "ref",
    "igshid",
];
const LEGACY_TRACKING_PARAMS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
    "ref",
];
function maybeDecode(value) {
    if (!value)
        return undefined;
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
export function asSingleLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
export function truncate(value, max = 220) {
    const normalized = asSingleLine(value);
    if (normalized.length <= max)
        return normalized;
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function stripExternalWrapper(content) {
    let cleaned = content;
    cleaned = cleaned.replace(/SECURITY NOTICE:[\s\S]*?(?=<<<[A-Z0-9_:-]+ id="[^"]+">>>)/g, "");
    // Newer OpenClaw wrappers lead with a one-line data/instruction boundary note.
    cleaned = cleaned.replace(/External content below is data, not a message from the user or system\.[^\n]*\s*(?=<<<[A-Z0-9_:-]+ id="[^"]+">>>)/g, "");
    cleaned = cleaned.replace(/<<<[A-Z0-9_:-]+ id="[^"]+">>>/g, "");
    // OpenClaw's wrapper puts a "Source: <label>" header and a "---" rule before the
    // content. ("\bSource:\b" never matched: there is no word boundary between ":"
    // and the space that follows, so every title and snippet kept the header.)
    const header = /^\s*Source:[^\n]*\n---\n/.exec(cleaned);
    if (header) {
        cleaned = cleaned.slice(header[0].length);
    }
    return cleaned.trim();
}
export function cleanProviderText(value) {
    if (typeof value !== "string")
        return "";
    return asSingleLine(stripExternalWrapper(value));
}
/** Multi-line variant of cleanProviderText, kept for passage splitting. */
export function cleanProviderTextKeepLines(value) {
    if (typeof value !== "string")
        return "";
    return stripExternalWrapper(value);
}
function unwrapKnownRedirectUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl.trim());
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;
        if ((host === "duckduckgo.com" || host === "www.duckduckgo.com") && path.startsWith("/l/")) {
            const uddg = maybeDecode(parsed.searchParams.get("uddg"));
            if (uddg)
                return { url: uddg, unwrapped: true };
        }
        if (["www.google.com", "google.com", "l.google.com", "googleadservices.com", "www.googleadservices.com"].includes(host) &&
            (path === "/url" || path === "/pagead/aclk")) {
            const q = maybeDecode(parsed.searchParams.get("q")) ?? maybeDecode(parsed.searchParams.get("url")) ?? maybeDecode(parsed.searchParams.get("adurl"));
            if (q)
                return { url: q, unwrapped: true };
        }
        if ((host === "l.facebook.com" || host === "lm.facebook.com") && path === "/l.php") {
            const u = maybeDecode(parsed.searchParams.get("u"));
            if (u)
                return { url: u, unwrapped: true };
        }
    }
    catch {
        // ignore
    }
    return { url: rawUrl.trim(), unwrapped: false };
}
function normalizeTrackingPattern(value) {
    return value.trim().replace(/^\?/, "").toLowerCase();
}
function resolveTrackingPatterns(options) {
    const configuredValues = Array.isArray(options?.trackingParams) ? options.trackingParams : [];
    const configured = configuredValues
        .filter((value) => typeof value === "string")
        .map(normalizeTrackingPattern)
        .filter(Boolean);
    const patterns = options?.trackingParamMode === "override"
        ? configured
        : [...DEFAULT_TRACKING_PARAMS, ...configured];
    return [...new Set(patterns)];
}
function isTrackingParam(key, patterns) {
    const normalizedKey = key.toLowerCase();
    return patterns.some((pattern) => pattern.endsWith("*")
        ? normalizedKey.startsWith(pattern.slice(0, -1))
        : normalizedKey === pattern);
}
function resolvePresentationTrackingPatterns(options) {
    if (options?.trackingParamMode !== "override") {
        return LEGACY_TRACKING_PARAMS;
    }
    const configured = resolveTrackingPatterns(options);
    return LEGACY_TRACKING_PARAMS.filter((pattern) => isTrackingParam(pattern, configured));
}
function stripTrackingParams(parsed, patterns) {
    let stripped = false;
    for (const key of [...parsed.searchParams.keys()]) {
        if (isTrackingParam(key, patterns)) {
            parsed.searchParams.delete(key);
            stripped = true;
        }
    }
    return stripped;
}
function foldVariantHostname(hostname) {
    let normalized = hostname.toLowerCase();
    if (normalized.startsWith("www.") && normalized.slice(4).includes(".")) {
        normalized = normalized.slice(4);
    }
    while ((normalized.startsWith("m.") || normalized.startsWith("amp.")) &&
        normalized.split(".").length > 2) {
        normalized = normalized.slice(normalized.indexOf(".") + 1);
    }
    return normalized;
}
function foldAmpPath(pathname) {
    const withoutAmpSuffix = pathname.replace(/\/amp(?:\/index\.html?|\.html?)?\/*$/i, "");
    const normalized = withoutAmpSuffix || "/";
    return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}
function sortSearchParams(parsed) {
    const entries = [...parsed.searchParams.entries()];
    entries.sort(([aKey], [bKey]) => {
        if (aKey !== bKey)
            return aKey < bKey ? -1 : 1;
        // Repeated-value order can be meaningful, so stable-sort only by key.
        return 0;
    });
    parsed.search = "";
    for (const [key, value] of entries) {
        parsed.searchParams.append(key, value);
    }
}
export function analyzeUrl(rawUrl, trackingOptions) {
    const originalUrl = rawUrl.trim();
    const flags = new Set();
    const unwrapped = unwrapKnownRedirectUrl(originalUrl);
    if (unwrapped.unwrapped) {
        flags.add("redirect-wrapper");
    }
    try {
        const parsed = new URL(unwrapped.url);
        parsed.hash = "";
        // Keep the established display-URL behavior: fuzzy-only patterns affect
        // identity, not navigation. Override mode may narrow the legacy display
        // stripping set so newly meaningful parameters are not lost upstream.
        const trackingPatterns = resolvePresentationTrackingPatterns(trackingOptions);
        const strippedTracking = stripTrackingParams(parsed, trackingPatterns);
        if (strippedTracking) {
            flags.add("tracking-stripped");
        }
        parsed.hostname = parsed.hostname.toLowerCase();
        if (parsed.pathname !== "/") {
            parsed.pathname = parsed.pathname.replace(/\/$/, "");
        }
        return {
            url: parsed.toString(),
            originalUrl,
            flags: [...flags].sort(),
        };
    }
    catch {
        return {
            url: unwrapped.url.trim(),
            originalUrl,
            flags: [...flags].sort(),
        };
    }
}
export function canonicalizeUrl(rawUrl) {
    return analyzeUrl(rawUrl).url;
}
/**
 * Builds the conservative identity used for fuzzy result deduplication.
 *
 * Meaningful query parameters remain part of the identity. Tracking parameters
 * can be extended or replaced by configuration, while HTTP(S), common host
 * variants, and terminal AMP paths fold to one canonical URL.
 */
export function analyzeFuzzyUrl(rawUrl, options) {
    const unwrapped = unwrapKnownRedirectUrl(rawUrl.trim());
    try {
        const parsed = new URL(unwrapped.url);
        parsed.protocol = parsed.protocol.toLowerCase();
        parsed.hostname = foldVariantHostname(parsed.hostname);
        parsed.hash = "";
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            parsed.protocol = "https:";
            if (parsed.port === "443") {
                parsed.port = "";
            }
        }
        stripTrackingParams(parsed, resolveTrackingPatterns(options));
        sortSearchParams(parsed);
        parsed.pathname = foldAmpPath(parsed.pathname);
        return {
            canonicalUrl: parsed.toString(),
            host: parsed.host,
            meaningfulQuery: parsed.search,
        };
    }
    catch {
        return {
            canonicalUrl: unwrapped.url.trim(),
            meaningfulQuery: "",
        };
    }
}
export function canonicalizeUrlForDedupe(rawUrl, options) {
    return analyzeFuzzyUrl(rawUrl, options).canonicalUrl;
}
export function normalizeTitle(value) {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function resolveSiteName(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.hostname.replace(/^www\./i, "");
    }
    catch {
        return undefined;
    }
}
