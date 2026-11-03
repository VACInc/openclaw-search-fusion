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
export declare function analyzeUrl(rawUrl: string): UrlAnalysis;
export declare function canonicalizeUrl(rawUrl: string): string;
export declare function resolveSiteName(rawUrl: string): string | undefined;
