export declare const DEFAULT_TRACKING_PARAMS: readonly ["utm_*", "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "igshid"];
export type TrackingParamMode = "extend" | "override";
export type FuzzyUrlOptions = {
    trackingParams?: readonly string[];
    trackingParamMode?: TrackingParamMode;
};
export type FuzzyUrlAnalysis = {
    canonicalUrl: string;
    host?: string;
    meaningfulQuery: string;
};
export type UrlAnalysis = {
    /** Display URL: redirect-unwrapped, tracking-stripped, query order kept. */
    url: string;
    /** Dedupe key: `url` with query parameters in a stable sorted order. */
    canonicalUrl: string;
    originalUrl: string;
    flags: string[];
};
export declare function asSingleLine(value: string): string;
export declare function truncate(value: string, max?: number): string;
/**
 * Neutralize text that could impersonate the external-content trust boundary
 * or a conversation role once it reaches the model. Safe to run more than
 * once, and safe on already-serialized JSON: replacements never introduce
 * quotes or backslashes.
 */
export declare function neutralizeUntrustedText(value: string): string;
/** Redact credential values that providers sometimes echo in error text. */
export declare function redactSecrets(value: string): string;
/** Error text is provider-controlled: drop credentials and boundary lookalikes. */
export declare function sanitizeErrorText(value: string): string;
export declare function stripExternalWrapper(content: string): string;
/** Clean one provider-returned text field for model-visible output. */
export declare function cleanProviderText(value: unknown): string;
/** Multi-line variant of cleanProviderText, kept for passage splitting. */
export declare function cleanProviderTextKeepLines(value: unknown): string;
export declare function analyzeUrl(rawUrl: string, trackingOptions?: FuzzyUrlOptions): UrlAnalysis;
export declare function canonicalizeUrl(rawUrl: string): string;
/**
 * Builds the conservative identity used for fuzzy result deduplication.
 *
 * Meaningful query parameters remain part of the identity. Tracking parameters
 * can be extended or replaced by configuration, while HTTP(S), common host
 * variants, and terminal AMP paths fold to one canonical URL.
 */
export declare function analyzeFuzzyUrl(rawUrl: string, options?: FuzzyUrlOptions): FuzzyUrlAnalysis;
export declare function canonicalizeUrlForDedupe(rawUrl: string, options?: FuzzyUrlOptions): string;
export declare function normalizeTitle(value: string): string;
export declare function resolveSiteName(rawUrl: string): string | undefined;
