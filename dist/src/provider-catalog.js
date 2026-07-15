import { resolveProviderCapabilities, } from "./provider-capabilities.js";
function catalogEntry(params) {
    return {
        id: params.id,
        label: params.label,
        pluginId: params.pluginId,
        envVars: params.envVars ?? [],
        keyless: params.keyless ?? false,
        accountAuth: params.accountAuth ?? false,
        capabilities: resolveProviderCapabilities(params.id),
    };
}
/**
 * OpenClaw 2026.7.2 web-search provider catalog, sorted by runtime provider id.
 * The qa-lab-only provider is intentionally excluded.
 */
export const KNOWN_PROVIDERS = [
    catalogEntry({ id: "brave", label: "Brave Search", pluginId: "brave", envVars: ["BRAVE_API_KEY"] }),
    catalogEntry({ id: "codex", label: "Codex Hosted Search", pluginId: "codex", accountAuth: true }),
    catalogEntry({ id: "duckduckgo", label: "DuckDuckGo Search (experimental)", pluginId: "duckduckgo", keyless: true }),
    catalogEntry({ id: "exa", label: "Exa Search", pluginId: "exa", envVars: ["EXA_API_KEY"] }),
    catalogEntry({ id: "firecrawl", label: "Firecrawl Search", pluginId: "firecrawl", envVars: ["FIRECRAWL_API_KEY"] }),
    catalogEntry({ id: "firecrawl-free", label: "Firecrawl Search (Free)", pluginId: "firecrawl", keyless: true }),
    catalogEntry({ id: "gemini", label: "Gemini (Google Search)", pluginId: "google", envVars: ["GEMINI_API_KEY"] }),
    catalogEntry({
        id: "grok",
        label: "Grok (xAI)",
        pluginId: "xai",
        envVars: ["XAI_API_KEY"],
        accountAuth: true,
    }),
    catalogEntry({
        id: "kimi",
        label: "Kimi (Moonshot)",
        pluginId: "moonshot",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    }),
    catalogEntry({
        id: "minimax",
        label: "MiniMax Search",
        pluginId: "minimax",
        envVars: [
            "MINIMAX_CODE_PLAN_KEY",
            "MINIMAX_CODING_API_KEY",
            "MINIMAX_OAUTH_TOKEN",
            "MINIMAX_API_KEY",
        ],
    }),
    catalogEntry({ id: "ollama", label: "Ollama Web Search", pluginId: "ollama", envVars: ["OLLAMA_API_KEY"] }),
    catalogEntry({ id: "parallel", label: "Parallel Search", pluginId: "parallel", envVars: ["PARALLEL_API_KEY"] }),
    catalogEntry({ id: "parallel-free", label: "Parallel Search (Free)", pluginId: "parallel", keyless: true }),
    catalogEntry({
        id: "perplexity",
        label: "Perplexity Search",
        pluginId: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    }),
    catalogEntry({ id: "searxng", label: "SearXNG Search", pluginId: "searxng", envVars: ["SEARXNG_BASE_URL"] }),
    catalogEntry({ id: "tavily", label: "Tavily Search", pluginId: "tavily", envVars: ["TAVILY_API_KEY"] }),
];
function hasDetectedEnvKey(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function resolveConfiguredProviderPluginId(config) {
    const root = asRecord(config);
    const tools = asRecord(root?.tools);
    const web = asRecord(tools?.web);
    const search = asRecord(web?.search);
    const providerId = typeof search?.provider === "string"
        ? search.provider.trim().toLowerCase()
        : undefined;
    if (!providerId)
        return undefined;
    return KNOWN_PROVIDERS.find((provider) => provider.id === providerId)?.pluginId;
}
/** Whether a catalog provider's owning plugin is enabled in the live config. */
export function isKnownProviderPluginEnabled(provider, config) {
    const root = asRecord(config);
    const plugins = asRecord(root?.plugins);
    const entries = asRecord(plugins?.entries);
    const entry = asRecord(entries?.[provider.pluginId]);
    if (entry && entry.enabled !== false)
        return true;
    return resolveConfiguredProviderPluginId(config) === provider.pluginId;
}
/**
 * Return catalog providers whose owning plugin is disabled or not enabled in
 * the live config. Environment inspection is deliberately reduced to a
 * boolean so credential values can never escape through the tool payload.
 */
export function findMissingProviders(params) {
    const env = params.env ?? process.env;
    return KNOWN_PROVIDERS
        .filter((provider) => !isKnownProviderPluginEnabled(provider, params.config))
        .map((provider) => ({
        id: provider.id,
        pluginId: provider.pluginId,
        keyless: provider.keyless,
        envKeyDetected: provider.envVars.some((envVar) => hasDetectedEnvKey(env[envVar])),
    }));
}
