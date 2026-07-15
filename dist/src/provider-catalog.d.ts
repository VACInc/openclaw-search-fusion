import { type ProviderCapability } from "./provider-capabilities.js";
/**
 * A provider known to the OpenClaw 2026.7.2 web-search runtime.
 *
 * `keyless` means the search provider itself needs neither an API key nor an
 * authenticated account. Providers backed by account auth or endpoint config
 * therefore remain `false` even when they do not use an API-key environment
 * variable.
 */
export type KnownProviderCatalogEntry = {
    readonly id: string;
    readonly label: string;
    readonly pluginId: string;
    readonly envVars: readonly string[];
    readonly keyless: boolean;
    /** Provider can resolve credentials from an account/auth profile at runtime. */
    readonly accountAuth: boolean;
    readonly capabilities: readonly ProviderCapability[];
};
export type MissingProviderHint = {
    readonly id: string;
    readonly pluginId: string;
    readonly keyless: boolean;
    readonly envKeyDetected: boolean;
};
/**
 * OpenClaw 2026.7.2 web-search provider catalog, sorted by runtime provider id.
 * The qa-lab-only provider is intentionally excluded.
 */
export declare const KNOWN_PROVIDERS: readonly KnownProviderCatalogEntry[];
/** Whether a catalog provider's owning plugin is enabled in the live config. */
export declare function isKnownProviderPluginEnabled(provider: KnownProviderCatalogEntry, config: unknown): boolean;
/**
 * Return catalog providers whose owning plugin is disabled or not enabled in
 * the live config. Environment inspection is deliberately reduced to a
 * boolean so credential values can never escape through the tool payload.
 */
export declare function findMissingProviders(params: {
    config?: unknown;
    env?: Readonly<Record<string, string | undefined>>;
}): MissingProviderHint[];
