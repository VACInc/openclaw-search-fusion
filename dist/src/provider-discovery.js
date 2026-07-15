import { resolveProviderCapabilities, } from "./provider-capabilities.js";
import { isKnownProviderPluginEnabled, KNOWN_PROVIDERS, } from "./provider-catalog.js";
/** Keyless provider variants that share an index with a higher-limit paid sibling. */
export const FREE_TIER_PROVIDER_SIBLINGS = {
    "firecrawl-free": "firecrawl",
    "parallel-free": "parallel",
};
const BUILT_IN_INTENT_CAPABILITIES = {
    research: ["academic", "extract", "neural"],
    keyword: ["results"],
    answer: ["answer"],
    news: ["news"],
    local: ["local"],
};
function asSearchConfig(config) {
    const maybe = config?.tools?.web
        ?.search;
    return maybe && typeof maybe === "object" && !Array.isArray(maybe) ? maybe : undefined;
}
function hasValue(value) {
    if (value == null)
        return false;
    if (typeof value === "string")
        return value.trim().length > 0;
    if (typeof value === "number" || typeof value === "boolean")
        return true;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === "object")
        return Object.keys(value).length > 0;
    return false;
}
function hasCredentialValue(value) {
    if (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.source === "env" &&
        typeof value.id === "string") {
        return hasValue(process.env[value.id]);
    }
    return hasValue(value);
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function resolveDeclaredPluginApiKey(config, pluginId) {
    const root = asRecord(config);
    const plugins = asRecord(root?.plugins);
    const entries = asRecord(plugins?.entries);
    const entry = asRecord(entries?.[pluginId]);
    const pluginConfig = asRecord(entry?.config);
    const webSearch = asRecord(pluginConfig?.webSearch);
    return webSearch?.apiKey;
}
function hasDeclaredPluginApiKey(value) {
    if (typeof value === "string")
        return value.trim().length > 0;
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function buildUnconfiguredCatalogHint(provider) {
    const configPath = `plugins.entries.${provider.pluginId}.config.webSearch.apiKey`;
    return provider.envVars.length > 0
        ? `Configure ${configPath} or ${provider.envVars.join(" / ")}.`
        : `Configure credentials for ${provider.label}.`;
}
function resolveCatalogProviderConfiguration(params) {
    if (params.provider.keyless) {
        return { configured: true, credentialSource: "keyless" };
    }
    const declaredApiKey = resolveDeclaredPluginApiKey(params.config, params.provider.pluginId);
    const fallbackDeclaredApiKey = resolveDeclaredPluginApiKey(params.fallbackConfig, params.provider.pluginId);
    if (hasDeclaredPluginApiKey(declaredApiKey) ||
        hasDeclaredPluginApiKey(fallbackDeclaredApiKey)) {
        return { configured: true, credentialSource: "plugin-config (declared)" };
    }
    const detectedEnvVar = params.provider.envVars.find((envVar) => hasValue(params.env[envVar]));
    if (detectedEnvVar) {
        return { configured: true, credentialSource: `environment (${detectedEnvVar})` };
    }
    if (params.provider.accountAuth) {
        // Runtime credential resolution can still succeed through an account/auth
        // profile the plugin owns; report it configured but flag the uncertainty.
        return {
            configured: true,
            credentialSource: params.provider.id === "codex" ? "account-auth" : "account-auth (unverified)",
        };
    }
    return {
        configured: false,
        hint: buildUnconfiguredCatalogHint(params.provider),
    };
}
function normalizeName(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized : undefined;
}
function normalizeIdList(values) {
    if (!Array.isArray(values))
        return [];
    return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
function normalizeModes(modes) {
    const entries = Object.entries(modes ?? {});
    return new Map(entries
        .map(([name, providers]) => [normalizeName(name), normalizeIdList(providers)])
        .filter((entry) => Boolean(entry[0])));
}
function normalizeIntent(value) {
    const normalized = normalizeName(value);
    const valid = ["research", "keyword", "answer", "news", "local"];
    return valid.includes(normalized) ? normalized : undefined;
}
function buildStarterModes(providers) {
    const providerIds = providers.map((provider) => provider.id);
    const starterEntries = [
        ["fast", providerIds.slice(0, 1)],
        ["balanced", providerIds.slice(0, 2)],
        ["deep", providerIds],
    ];
    return new Map(starterEntries.filter((entry) => entry[1].length > 0));
}
function resolveModes(params) {
    const customModes = normalizeModes(params.configModes);
    if (customModes.size > 0) {
        return customModes;
    }
    const pool = params.configuredProviders.length > 0
        ? params.configuredProviders
        : params.availableProviders;
    return buildStarterModes(pool);
}
function resolveModeProviders(params) {
    const providerIds = params.modes.get(params.mode);
    if (!providerIds)
        return undefined;
    return providerIds
        .map((id) => params.byId.get(id))
        .filter((provider) => Boolean(provider));
}
function resolveIntentProviders(params) {
    const ids = params.intentMap[params.intent];
    if (!ids || ids.length === 0)
        return undefined;
    const normalized = normalizeIdList(ids);
    const providers = normalized
        .map((id) => params.byId.get(id))
        .filter((provider) => Boolean(provider));
    return providers.length > 0 ? providers : undefined;
}
function resolveBuiltInIntentProviders(params) {
    const pool = params.configuredProviders.length > 0
        ? params.configuredProviders
        : params.availableProviders;
    const preferredCapabilities = BUILT_IN_INTENT_CAPABILITIES[params.intent];
    const providers = pool.filter((provider) => {
        const capabilities = resolveProviderCapabilities(provider.id);
        // Keyword intent deliberately means classic index-style results, not an
        // answer-synthesis provider that happens to expose citation results too.
        if (params.intent === "keyword") {
            return capabilities.includes("results") && !capabilities.includes("answer");
        }
        return preferredCapabilities.some((capability) => capabilities.includes(capability));
    });
    return providers.length > 0 ? providers : undefined;
}
/**
 * Prefer a paid provider when a selection contains both it and its keyless
 * sibling. The input order is preserved and a lone free provider is retained.
 */
export function preferPaidProviderSiblings(providers) {
    const selectedById = new Map(providers.map((provider) => [provider.id.toLowerCase(), provider]));
    return providers.filter((provider) => {
        const providerId = provider.id.toLowerCase();
        const paidSibling = FREE_TIER_PROVIDER_SIBLINGS[providerId];
        if (paidSibling) {
            const paid = selectedById.get(paidSibling);
            return !paid || paid.configured !== true;
        }
        const freeSibling = Object.entries(FREE_TIER_PROVIDER_SIBLINGS).find(([, paidId]) => paidId === providerId)?.[0];
        return !freeSibling || !selectedById.has(freeSibling) || provider.configured === true;
    });
}
export function resolveProviderConfiguration(provider, config) {
    if (provider.requiresCredential === false) {
        return { configured: true, credentialSource: "keyless" };
    }
    try {
        if (hasCredentialValue(provider.getConfiguredCredentialValue?.(config))) {
            return { configured: true, credentialSource: "provider-config" };
        }
    }
    catch {
        // ignore provider accessor errors
    }
    try {
        if (hasCredentialValue(provider.getCredentialValue?.(asSearchConfig(config)))) {
            return { configured: true, credentialSource: "search-config" };
        }
    }
    catch {
        // ignore provider accessor errors
    }
    // Plugin contexts do not expose the auth-profile store. Match core's
    // account-auth route conservatively and make the uncertainty explicit.
    if (provider.authProviderId) {
        return { configured: true, credentialSource: "account-auth (unverified)" };
    }
    for (const envVar of provider.envVars ?? []) {
        if (hasValue(process.env[envVar])) {
            return { configured: true, credentialSource: `environment (${envVar})` };
        }
    }
    try {
        const fallback = provider.getConfiguredCredentialFallback?.(config);
        if (hasCredentialValue(fallback?.value)) {
            return {
                configured: true,
                credentialSource: fallback?.path
                    ? `configured fallback (${fallback.path})`
                    : "configured fallback",
            };
        }
    }
    catch {
        // ignore provider fallback accessor errors
    }
    return { configured: false };
}
export function isProviderConfigured(provider, config) {
    return resolveProviderConfiguration(provider, config).configured;
}
export function discoverProviders(params) {
    const registryProviders = params.providers
        .filter((provider) => provider.id !== params.selfId)
        .map((provider) => {
        const primaryConfiguration = resolveProviderConfiguration(provider, params.config);
        const configuration = primaryConfiguration.configured || params.fallbackConfig === undefined
            ? primaryConfiguration
            : resolveProviderConfiguration(provider, params.fallbackConfig);
        return {
            id: provider.id,
            label: provider.label,
            hint: provider.hint,
            autoDetectOrder: provider.autoDetectOrder,
            ...configuration,
            capabilities: [...resolveProviderCapabilities(provider.id)],
        };
    });
    const registryProviderIds = new Set(registryProviders.map((provider) => provider.id.toLowerCase()));
    const catalogConfig = params.catalogConfig ?? params.fallbackConfig ?? params.config;
    const env = params.env ?? process.env;
    const catalogProviders = KNOWN_PROVIDERS
        .filter((provider) => provider.id !== params.selfId)
        .filter((provider) => !registryProviderIds.has(provider.id))
        .filter((provider) => isKnownProviderPluginEnabled(provider, catalogConfig))
        .map((provider) => ({
        id: provider.id,
        label: provider.label,
        ...resolveCatalogProviderConfiguration({
            provider,
            config: params.config,
            fallbackConfig: params.fallbackConfig,
            env,
        }),
        capabilities: [...provider.capabilities],
    }));
    return [...registryProviders, ...catalogProviders]
        .sort((a, b) => {
        const orderA = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB)
            return orderA - orderB;
        return a.id.localeCompare(b.id);
    });
}
export function resolveSelectedProviders(params) {
    const excluded = new Set(normalizeIdList(params.config.excludeProviders));
    const allAvailable = params.availableProviders;
    const available = allAvailable.filter((provider) => !excluded.has(provider.id));
    const explicitById = new Map(allAvailable.map((provider) => [provider.id, provider]));
    const byId = new Map(available.map((provider) => [provider.id, provider]));
    const configured = available.filter((provider) => provider.configured);
    const requested = normalizeIdList(params.requestProviders);
    const requestMode = normalizeName(params.requestMode);
    const modes = resolveModes({
        configuredProviders: configured,
        availableProviders: available,
        configModes: params.config.modes,
    });
    // 1. Explicit provider list (including "all" / "*")
    const unknown = requested.filter((id) => id !== "all" && id !== "*" && !explicitById.has(id));
    if (unknown.length > 0) {
        const validIds = allAvailable.map((provider) => provider.id).sort();
        throw new Error(`Unknown Search Fusion provider${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Valid provider ids: ${validIds.join(", ")}.`);
    }
    const expandAll = requested.includes("all") || requested.includes("*");
    if (expandAll) {
        const allConfigured = allAvailable.filter((provider) => provider.configured);
        return preferPaidProviderSiblings(allConfigured.length > 0 ? allConfigured : allAvailable);
    }
    if (requested.length > 0) {
        return preferPaidProviderSiblings(requested
            .map((id) => explicitById.get(id))
            .filter((provider) => Boolean(provider)));
    }
    // 2. Explicit mode
    if (requestMode) {
        const selectedForMode = resolveModeProviders({ mode: requestMode, modes, byId: explicitById });
        if (!selectedForMode) {
            throw new Error(`Unknown Search Fusion mode: ${params.requestMode}`);
        }
        if (selectedForMode.length === 0) {
            throw new Error(`Search Fusion mode "${params.requestMode}" resolved to no available providers.`);
        }
        return preferPaidProviderSiblings(selectedForMode);
    }
    // 3. Intent hint → configured map, or capability defaults when no map exists
    const intent = normalizeIntent(typeof params.requestIntent === "string" ? params.requestIntent : undefined);
    if (intent && params.config.intentProviders) {
        const selectedForIntent = resolveIntentProviders({
            intent,
            intentMap: params.config.intentProviders,
            byId,
        });
        if (selectedForIntent && selectedForIntent.length > 0) {
            return preferPaidProviderSiblings(selectedForIntent);
        }
    }
    else if (intent) {
        const selectedForIntent = resolveBuiltInIntentProviders({
            intent,
            configuredProviders: configured,
            availableProviders: available,
        });
        if (selectedForIntent && selectedForIntent.length > 0) {
            return preferPaidProviderSiblings(selectedForIntent);
        }
    }
    // 4. Configured defaultMode
    const defaultMode = normalizeName(params.config.defaultMode);
    if (defaultMode) {
        const selectedForDefaultMode = resolveModeProviders({ mode: defaultMode, modes, byId });
        if (selectedForDefaultMode && selectedForDefaultMode.length > 0) {
            return preferPaidProviderSiblings(selectedForDefaultMode);
        }
    }
    // 5. Legacy defaultProviders
    const defaults = normalizeIdList(params.config.defaultProviders)
        .map((id) => byId.get(id))
        .filter((provider) => Boolean(provider));
    if (defaults.length > 0) {
        return preferPaidProviderSiblings(defaults);
    }
    // 6. All configured providers
    return preferPaidProviderSiblings(configured.length > 0 ? configured : available);
}
