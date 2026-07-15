import type { ResolvedProvider, RuntimeWebSearchProvider, SearchFusionConfig, SearchQueryIntent } from "./types.js";
/** Keyless provider variants that share an index with a higher-limit paid sibling. */
export declare const FREE_TIER_PROVIDER_SIBLINGS: Readonly<Record<string, string>>;
/**
 * Prefer a paid provider when a selection contains both it and its keyless
 * sibling. The input order is preserved and a lone free provider is retained.
 */
export declare function preferPaidProviderSiblings<T extends {
    id: string;
    configured?: boolean;
}>(providers: readonly T[]): T[];
export declare function resolveProviderConfiguration(provider: RuntimeWebSearchProvider, config: unknown): {
    configured: boolean;
    credentialSource?: string;
};
export declare function isProviderConfigured(provider: RuntimeWebSearchProvider, config: unknown): boolean;
export declare function discoverProviders(params: {
    providers: RuntimeWebSearchProvider[];
    config: unknown;
    fallbackConfig?: unknown;
    selfId: string;
}): ResolvedProvider[];
export declare function resolveSelectedProviders(params: {
    availableProviders: ResolvedProvider[];
    requestMode?: string;
    requestProviders?: string[];
    requestIntent?: SearchQueryIntent | string;
    config: SearchFusionConfig;
}): ResolvedProvider[];
