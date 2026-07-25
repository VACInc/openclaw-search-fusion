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
    url: string;
    originalUrl: string;
    flags: string[];
};
export declare function asSingleLine(value: string): string;
export declare function truncate(value: string, max?: number): string;
export declare function stripExternalWrapper(content: string): string;
export declare function cleanProviderText(value: unknown): string;
export declare function analyzeUrl(rawUrl: string): UrlAnalysis;
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
