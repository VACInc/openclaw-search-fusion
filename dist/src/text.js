const TRACKING_PARAMS = new Set([
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
]);
function isAbsoluteUrl(value) {
    try {
        new URL(value);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * URLSearchParams already percent-decodes a value once. Decoding it again
 * would turn an encoded "&", "#", or "%" inside the target URL into a real
 * delimiter and change which page it points to. Decode a second time only
 * when the value is not yet a URL, which covers double-encoded wrappers.
 */
function redirectTarget(value) {
    const candidate = value?.trim();
    if (!candidate)
        return undefined;
    if (isAbsoluteUrl(candidate))
        return candidate;
    try {
        const decoded = decodeURIComponent(candidate);
        return isAbsoluteUrl(decoded) ? decoded : candidate;
    }
    catch {
        return candidate;
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
// Zero-width and soft-hyphen characters can split a marker word so it no longer
// matches a plain-text pattern while still reading the same to a model.
const INVISIBLE_CHARS = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
// Match one ASCII letter plus its fullwidth forms, case-insensitively.
function letterClass(letter) {
    const upper = letter.toUpperCase();
    const lower = letter.toLowerCase();
    const fwUpper = String.fromCharCode(upper.charCodeAt(0) + 0xfee0);
    const fwLower = String.fromCharCode(lower.charCodeAt(0) + 0xfee0);
    return `[${upper}${lower}${fwUpper}${fwLower}]`;
}
function wordPattern(word) {
    return [...word].map(letterClass).join("");
}
const MARKER_GAP = "[\\s_\\-\\uff3f\\uff0d]*";
const MARKER_CORE = [wordPattern("EXTERNAL"), wordPattern("UNTRUSTED"), wordPattern("CONTENT")].join(MARKER_GAP);
const OPEN_ANGLES = "[<\\uff1c\\u2039\\u00ab\\u3008\\u27e8\\u226a]";
const CLOSE_ANGLES = "[>\\uff1e\\u203a\\u00bb\\u3009\\u27e9\\u226b]";
// Any begin/end boundary lookalike: any case, fullwidth letters, and
// separators. Only the marker words are replaced, never brackets or a trailing
// id attribute, so this never consumes a quote or backslash and is safe on
// serialized JSON; angle-bracket runs are broken up separately (keeping the
// brackets out of this pattern also keeps it linear on long bracket runs).
const BOUNDARY_MARKER_PATTERN = new RegExp(`(${wordPattern("END")}${MARKER_GAP})?${MARKER_CORE}`, "g");
// Runs of three or more angle brackets are the delimiter shape of the trust
// boundary; break them up so leftover fragments cannot be reassembled.
const ANGLE_RUN_PATTERN = new RegExp(`${OPEN_ANGLES}{3,}|${CLOSE_ANGLES}{3,}`, "g");
// The provider-side security preamble that precedes a wrapped payload.
const SECURITY_NOTICE_PATTERN = new RegExp(`${wordPattern("SECURITY")}${MARKER_GAP}${wordPattern("NOTICE")}\\s*:`, "g");
// Chat-template control tokens such as <|im_start|> or <|system|>.
const CHAT_TEMPLATE_TOKEN_PATTERN = /<\|[^|<>"\\\n]{0,64}\|>/g;
const ROLE_WORDS = "system|assistant|developer|user|human|tool";
const ROLE_TAG_PATTERN = new RegExp(`<\\s*(?:\\/\\s*)?(?:${ROLE_WORDS})\\s*>|\\[\\s*(?:\\/\\s*)?(?:${ROLE_WORDS})\\s*\\]`, "gi");
// A role word acting as a speaker prefix: at the start of the text, or right
// after a sentence, bracket, quote, markdown, or escaped-newline boundary.
const ROLE_PREFIX_PATTERN = new RegExp(`(^|[.!?;:>\\])}|"'\`*#=,\\u2014\\u2013-]\\s*|\\\\[nrt]\\s*|\\n[^\\S\\n]*)(${ROLE_WORDS})\\s*:`, "gi");
// An all-caps role prefix reads as a speaker label anywhere in a line.
const SHOUTED_ROLE_PREFIX_PATTERN = /\b(?:SYSTEM|ASSISTANT|DEVELOPER|USER|HUMAN|TOOL)\s*:/g;
/**
 * Neutralize text that could impersonate the external-content trust boundary
 * or a conversation role once it reaches the model. Safe to run more than
 * once, and safe on already-serialized JSON: replacements never introduce
 * quotes or backslashes.
 */
export function neutralizeUntrustedText(value) {
    let cleaned = value.replace(INVISIBLE_CHARS, "");
    cleaned = cleaned.replace(BOUNDARY_MARKER_PATTERN, (_match, end) => end ? "[[END_MARKER_SANITIZED]]" : "[[MARKER_SANITIZED]]");
    cleaned = cleaned.replace(ANGLE_RUN_PATTERN, "[[ANGLES_SANITIZED]]");
    cleaned = cleaned.replace(SECURITY_NOTICE_PATTERN, "[[NOTICE_SANITIZED]]");
    cleaned = cleaned.replace(CHAT_TEMPLATE_TOKEN_PATTERN, "[[TOKEN_SANITIZED]]");
    cleaned = cleaned.replace(ROLE_TAG_PATTERN, "[[ROLE_SANITIZED]]");
    cleaned = cleaned.replace(ROLE_PREFIX_PATTERN, (_match, boundary) => `${boundary}[[ROLE_SANITIZED]]`);
    cleaned = cleaned.replace(SHOUTED_ROLE_PREFIX_PATTERN, "[[ROLE_SANITIZED]]");
    return cleaned;
}
// Named credential fields: redact after "=" or ":" (query strings, headers, JSON).
const SECRET_FIELD_PATTERN = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|x-api-key|x-goog-api-key|subscription-key)["']?\s*[=:]\s*)(["']?)(?!\[REDACTED\])[^\s&"',;)}\]]+/gi;
// Generic names are common words, so only redact the query-string form.
const SECRET_QUERY_PATTERN = /\b((?:key|token|secret|sig|signature|apikey|auth)=)(?!\[REDACTED\])[^\s&"',;)}\]]+/gi;
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_HEADER_PATTERN = /\b(authorization\s*[:=]\s*)[^\s,;]+(?:\s+[^\s,;]+)?/gi;
/** Redact credential values that providers sometimes echo in error text. */
export function redactSecrets(value) {
    return value
        .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]")
        .replace(BEARER_PATTERN, "$1 [REDACTED]")
        .replace(SECRET_FIELD_PATTERN, "$1$2[REDACTED]")
        .replace(SECRET_QUERY_PATTERN, "$1[REDACTED]");
}
/** Error text is provider-controlled: drop credentials and boundary lookalikes. */
export function sanitizeErrorText(value) {
    return neutralizeUntrustedText(redactSecrets(value));
}
const WRAPPER_MARKER_PATTERN = new RegExp(`<<<\\s*(?:${wordPattern("END")}${MARKER_GAP})?${MARKER_CORE}(?:\\s+id\\s*=\\s*\\\\*"[^"\\\\]*\\\\*")?\\s*>>>`, "gi");
export function stripExternalWrapper(content) {
    let cleaned = content.replace(INVISIBLE_CHARS, "");
    // Drop a provider-side security preamble up to the opening boundary marker.
    const firstMarker = cleaned.search(WRAPPER_MARKER_PATTERN);
    WRAPPER_MARKER_PATTERN.lastIndex = 0;
    if (firstMarker >= 0) {
        const preamble = cleaned.slice(0, firstMarker);
        const noticeIndex = preamble.search(/SECURITY\s+NOTICE\s*:/i);
        if (noticeIndex >= 0) {
            cleaned = preamble.slice(0, noticeIndex) + cleaned.slice(firstMarker);
        }
    }
    // A line break keeps whatever followed the marker at a line-start boundary.
    cleaned = cleaned.replace(WRAPPER_MARKER_PATTERN, "\n");
    // Drop the wrapper's own "Source: ..." header line and its separator.
    cleaned = cleaned.replace(/^\s*Source:[^\n]*\n---\n/, "");
    return cleaned.trim();
}
/** Clean one provider-returned text field for model-visible output. */
export function cleanProviderText(value) {
    if (typeof value !== "string")
        return "";
    // Neutralize before collapsing whitespace so line breaks still count as
    // role-prefix boundaries.
    return asSingleLine(neutralizeUntrustedText(stripExternalWrapper(value)));
}
function unwrapKnownRedirectUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl.trim());
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;
        if ((host === "duckduckgo.com" || host === "www.duckduckgo.com") && path.startsWith("/l/")) {
            const uddg = redirectTarget(parsed.searchParams.get("uddg"));
            if (uddg)
                return { url: uddg, unwrapped: true };
        }
        if (["www.google.com", "google.com", "l.google.com", "googleadservices.com", "www.googleadservices.com"].includes(host) &&
            (path === "/url" || path === "/pagead/aclk")) {
            const q = redirectTarget(parsed.searchParams.get("q")) ??
                redirectTarget(parsed.searchParams.get("url")) ??
                redirectTarget(parsed.searchParams.get("adurl"));
            if (q)
                return { url: q, unwrapped: true };
        }
        if ((host === "l.facebook.com" || host === "lm.facebook.com") && path === "/l.php") {
            const u = redirectTarget(parsed.searchParams.get("u"));
            if (u)
                return { url: u, unwrapped: true };
        }
    }
    catch {
        // ignore
    }
    return { url: rawUrl.trim(), unwrapped: false };
}
export function analyzeUrl(rawUrl) {
    const originalUrl = rawUrl.trim();
    const flags = new Set();
    const unwrapped = unwrapKnownRedirectUrl(originalUrl);
    if (unwrapped.unwrapped) {
        flags.add("redirect-wrapper");
    }
    try {
        const parsed = new URL(unwrapped.url);
        parsed.hash = "";
        let strippedTracking = false;
        for (const key of [...parsed.searchParams.keys()]) {
            if (TRACKING_PARAMS.has(key.toLowerCase())) {
                parsed.searchParams.delete(key);
                strippedTracking = true;
            }
        }
        if (strippedTracking) {
            flags.add("tracking-stripped");
        }
        parsed.hostname = parsed.hostname.toLowerCase();
        if (parsed.pathname !== "/") {
            parsed.pathname = parsed.pathname.replace(/\/$/, "");
        }
        const url = parsed.toString();
        // The same page can arrive with its query parameters in a different order.
        // Sorting is stable, so repeated keys keep their relative order.
        parsed.searchParams.sort();
        return {
            url,
            canonicalUrl: parsed.toString(),
            originalUrl,
            flags: [...flags].sort(),
        };
    }
    catch {
        const url = unwrapped.url.trim();
        return {
            url,
            canonicalUrl: url,
            originalUrl,
            flags: [...flags].sort(),
        };
    }
}
export function canonicalizeUrl(rawUrl) {
    return analyzeUrl(rawUrl).canonicalUrl;
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
