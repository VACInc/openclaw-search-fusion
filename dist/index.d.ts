import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { KNOWN_PROVIDERS } from "./src/provider-catalog.js";
import { ALL_PROVIDER_CAPABILITIES, filterByAnyCapability, filterByCapabilities, hasCapability, resolveProviderCapabilities, type ProviderCapability } from "./src/provider-capabilities.js";
export { ALL_PROVIDER_CAPABILITIES, filterByAnyCapability, filterByCapabilities, hasCapability, resolveProviderCapabilities, KNOWN_PROVIDERS, };
export type { ProviderCapability };
export type { KnownProviderCatalogEntry, MissingProviderHint } from "./src/provider-catalog.js";
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
};
export default plugin;
