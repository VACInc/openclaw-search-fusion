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
    readonly pluginId: string;
    readonly envVars: readonly string[];
    readonly keyless: boolean;
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
/**
 * Return catalog providers absent from the runtime provider list. Environment
 * inspection is deliberately reduced to a boolean so credential values can
 * never escape through the tool payload.
 */
export declare function findMissingProviders(params: {
    runtimeProviderIds: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
}): MissingProviderHint[];
