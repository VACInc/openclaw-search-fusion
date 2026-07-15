import { resolveProviderCapabilities, } from "./provider-capabilities.js";
function catalogEntry(params) {
    return {
        id: params.id,
        pluginId: params.pluginId,
        envVars: params.envVars ?? [],
        keyless: params.keyless ?? false,
        capabilities: resolveProviderCapabilities(params.id),
    };
}
/**
 * OpenClaw 2026.7.2 web-search provider catalog, sorted by runtime provider id.
 * The qa-lab-only provider is intentionally excluded.
 */
export const KNOWN_PROVIDERS = [
    catalogEntry({ id: "brave", pluginId: "brave", envVars: ["BRAVE_API_KEY"] }),
    catalogEntry({ id: "codex", pluginId: "codex" }),
    catalogEntry({ id: "duckduckgo", pluginId: "duckduckgo", keyless: true }),
    catalogEntry({ id: "exa", pluginId: "exa", envVars: ["EXA_API_KEY"] }),
    catalogEntry({ id: "firecrawl", pluginId: "firecrawl", envVars: ["FIRECRAWL_API_KEY"] }),
    catalogEntry({ id: "firecrawl-free", pluginId: "firecrawl", keyless: true }),
    catalogEntry({ id: "gemini", pluginId: "google", envVars: ["GEMINI_API_KEY"] }),
    catalogEntry({ id: "grok", pluginId: "xai", envVars: ["XAI_API_KEY"] }),
    catalogEntry({
        id: "kimi",
        pluginId: "moonshot",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    }),
    catalogEntry({
        id: "minimax",
        pluginId: "minimax",
        envVars: [
            "MINIMAX_CODE_PLAN_KEY",
            "MINIMAX_CODING_API_KEY",
            "MINIMAX_OAUTH_TOKEN",
            "MINIMAX_API_KEY",
        ],
    }),
    catalogEntry({ id: "ollama", pluginId: "ollama", envVars: ["OLLAMA_API_KEY"] }),
    catalogEntry({ id: "parallel", pluginId: "parallel", envVars: ["PARALLEL_API_KEY"] }),
    catalogEntry({ id: "parallel-free", pluginId: "parallel", keyless: true }),
    catalogEntry({
        id: "perplexity",
        pluginId: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    }),
    catalogEntry({ id: "searxng", pluginId: "searxng", envVars: ["SEARXNG_BASE_URL"] }),
    catalogEntry({ id: "tavily", pluginId: "tavily", envVars: ["TAVILY_API_KEY"] }),
];
function hasDetectedEnvKey(value) {
    return typeof value === "string" && value.trim().length > 0;
}
/**
 * Return catalog providers absent from the runtime provider list. Environment
 * inspection is deliberately reduced to a boolean so credential values can
 * never escape through the tool payload.
 */
export function findMissingProviders(params) {
    const runtimeProviderIds = new Set(params.runtimeProviderIds.map((id) => id.toLowerCase()));
    const env = params.env ?? process.env;
    return KNOWN_PROVIDERS
        .filter((provider) => !runtimeProviderIds.has(provider.id))
        .map((provider) => ({
        id: provider.id,
        pluginId: provider.pluginId,
        keyless: provider.keyless,
        envKeyDetected: provider.envVars.some((envVar) => hasDetectedEnvKey(env[envVar])),
    }));
}
