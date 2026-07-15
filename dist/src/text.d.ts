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
export declare function resolveSiteName(rawUrl: string): string | undefined;
