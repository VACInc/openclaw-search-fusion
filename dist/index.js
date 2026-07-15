import { Type } from "@sinclair/typebox";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { discoverProviders } from "./src/provider-discovery.js";
import { findMissingProviders, KNOWN_PROVIDERS } from "./src/provider-catalog.js";
import { ALL_PROVIDER_CAPABILITIES, filterByAnyCapability, filterByCapabilities, hasCapability, resolveProviderCapabilities, } from "./src/provider-capabilities.js";
import { renderFusionSummary, runSearchFusion } from "./src/search-fusion.js";
import { wrapModelVisibleSearchPayload } from "./src/external-content.js";
// Re-export the capability taxonomy so consumers can import directly from the
// plugin entry point without knowing internal file structure.
export { ALL_PROVIDER_CAPABILITIES, filterByAnyCapability, filterByCapabilities, hasCapability, resolveProviderCapabilities, KNOWN_PROVIDERS, };
const SearchFusionParameters = Type.Object({
    query: Type.String({ description: "Search query string." }),
    intent: Type.Optional(Type.Union([
        Type.Literal("research"),
        Type.Literal("keyword"),
        Type.Literal("answer"),
        Type.Literal("news"),
        Type.Literal("local"),
    ], {
        description: "Optional intent hint that biases provider selection without overriding explicit providers or mode. " +
            "When intentProviders is omitted, built-in capability rules route research to academic/extract/neural providers, " +
            "keyword to classic results providers without answer synthesis, answer to answer providers, and news to news providers. " +
            "Local has no built-in provider preference and falls through to defaults unless intentProviders.local is set.",
    })),
    mode: Type.Optional(Type.String({ description: "Optional mode name. Uses configured modes, or built-in starter modes (fast, balanced, deep) when custom modes are not set." })),
    providers: Type.Optional(Type.Array(Type.String({ description: "Explicit provider id, or use 'all' / '*' to fan out to every configured provider. Explicit selections bypass excludeProviders; unknown ids are errors." }))),
    count: Type.Optional(Type.Integer({
        description: "Number of results to request from each provider (1-10).",
        minimum: 1,
        maximum: 10,
    })),
    maxMergedResults: Type.Optional(Type.Integer({
        description: "Maximum merged results returned after dedupe (1-50).",
        minimum: 1,
        maximum: 50,
    })),
    country: Type.Optional(Type.String({ description: "2-letter country code for region-specific results." })),
    language: Type.Optional(Type.String({ description: "ISO 639-1 language code for results." })),
    freshness: Type.Optional(Type.String({ description: "Time filter: day, week, month, or year." })),
    date_after: Type.Optional(Type.String({ description: "Only results published after this date (YYYY-MM-DD)." })),
    date_before: Type.Optional(Type.String({ description: "Only results published before this date (YYYY-MM-DD)." })),
    search_lang: Type.Optional(Type.String({ description: "Provider-specific search language code when supported." })),
    ui_lang: Type.Optional(Type.String({ description: "Locale code for UI elements when supported." })),
    includeFailures: Type.Optional(Type.Boolean({ description: "Include provider failures in the human-readable summary." })),
    includeRawPayloads: Type.Optional(Type.Boolean({ description: "Include full provider payloads and raw normalized items. Defaults to false." })),
    includeDiscarded: Type.Optional(Type.Boolean({ description: "Include missing-URL items discarded from merging. Defaults to false." })),
}, { additionalProperties: false });
function asJsonResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
    };
}
async function asWrappedJsonResult(payload) {
    return {
        content: [{ type: "text", text: await wrapModelVisibleSearchPayload(payload) }],
        details: payload,
    };
}
function throwIfSignalAborted(signal) {
    if (!signal?.aborted)
        return;
    if (signal.reason instanceof Error)
        throw signal.reason;
    const error = new Error(typeof signal.reason === "string" ? signal.reason : "Search aborted");
    error.name = "AbortError";
    throw error;
}
function resolveRuntimeConfigSnapshot(fallback) {
    return getRuntimeConfigSnapshot() ?? fallback;
}
const ProviderListParameters = Type.Object({
    onlyConfigured: Type.Optional(Type.Boolean({ description: "Return only providers with a configured credential." })),
}, { additionalProperties: false });
function createSearchFusionProvider(api) {
    return {
        id: "search-fusion",
        label: "Search Fusion",
        hint: "Fan out across configured web search providers in parallel and merge the results.",
        credentialLabel: "No credential required",
        envVars: [],
        placeholder: "",
        signupUrl: "https://github.com/VACInc/openclaw-search-fusion",
        docsUrl: "https://github.com/VACInc/openclaw-search-fusion#readme",
        autoDetectOrder: 999,
        credentialPath: "plugins.entries.search-fusion.config.__unused",
        getCredentialValue: () => undefined,
        setCredentialValue: () => { },
        getConfiguredCredentialValue: () => "always-enabled",
        createTool: (ctx = {}) => ({
            description: "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
            parameters: SearchFusionParameters,
            execute: async (args, context) => {
                const payload = await runSearchFusion({
                    runtime: api.runtime,
                    config: api.config,
                    contextConfig: ctx.config,
                    searchConfig: ctx.searchConfig,
                    pluginConfig: api.pluginConfig,
                    request: args,
                    signal: context?.signal,
                    runtimeMetadata: ctx.runtimeMetadata,
                    agentDir: ctx.agentDir,
                });
                return {
                    content: await wrapModelVisibleSearchPayload(payload),
                    externalContent: payload.externalContent,
                };
            },
        }),
    };
}
const plugin = {
    id: "search-fusion",
    name: "Search Fusion",
    description: "Federated web search fusion for OpenClaw.",
    register(api) {
        const searchApi = api;
        searchApi.registerWebSearchProvider?.(createSearchFusionProvider(searchApi));
        api.registerTool({
            name: "search_fusion",
            label: "Search Fusion",
            description: "Search across multiple configured web search providers in parallel, merge duplicate URLs, and preserve provider attribution.",
            parameters: SearchFusionParameters,
            async execute(_id, params, signal) {
                const payload = await runSearchFusion({
                    runtime: searchApi.runtime,
                    config: searchApi.config,
                    pluginConfig: searchApi.pluginConfig,
                    request: params,
                    signal,
                });
                return await asWrappedJsonResult({
                    summary: renderFusionSummary(payload, Boolean(params.includeFailures)),
                    payload,
                });
            },
        });
        api.registerTool({
            name: "search_fusion_providers",
            label: "Search Fusion Providers",
            description: "List web search providers discovered from the runtime registry and enabled plugin config, with safe configuration and enablement hints.",
            parameters: ProviderListParameters,
            async execute(_id, params, signal) {
                throwIfSignalAborted(signal);
                const runtimeConfig = resolveRuntimeConfigSnapshot(searchApi.config);
                const runtimeProviders = searchApi.runtime.webSearch.listProviders({
                    config: runtimeConfig,
                });
                const providers = discoverProviders({
                    providers: runtimeProviders,
                    config: runtimeConfig,
                    catalogConfig: runtimeConfig,
                    selfId: "search-fusion",
                });
                const missing = findMissingProviders({
                    config: runtimeConfig,
                });
                const visibleProviders = params.onlyConfigured
                    ? providers.filter((provider) => provider.configured)
                    : providers;
                const lines = visibleProviders.map((provider) => `- ${provider.id}: ${provider.label}${provider.configured ? " [configured]" : " [not configured]"}${provider.credentialSource ? ` [credential: ${provider.credentialSource}]` : ""}${(provider.capabilities ?? []).length > 0 ? ` [${(provider.capabilities ?? []).join(", ")}]` : ""}${provider.hint ? ` — ${provider.hint}` : ""}`);
                const missingLines = missing.map((provider) => `- ${provider.id}: plugin ${provider.pluginId} disabled/not enabled [keyless: ${provider.keyless}] [env key detected: ${provider.envKeyDetected}]`);
                const summary = [
                    lines.length > 0 ? lines.join("\n") : "No enabled web search providers discovered.",
                    ...(missingLines.length > 0
                        ? [`Catalog providers with plugin disabled/not enabled:\n${missingLines.join("\n")}`]
                        : []),
                ].join("\n\n");
                throwIfSignalAborted(signal);
                return asJsonResult({
                    summary,
                    providers: visibleProviders,
                    missing,
                });
            },
        });
    },
};
export default plugin;
