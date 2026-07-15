import {
  resolveProviderCapabilities,
  type ProviderCapability,
} from "./provider-capabilities.js";

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

function catalogEntry(params: {
  id: string;
  pluginId: string;
  envVars?: readonly string[];
  keyless?: boolean;
}): KnownProviderCatalogEntry {
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
export const KNOWN_PROVIDERS: readonly KnownProviderCatalogEntry[] = [
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
] as const;

function hasDetectedEnvKey(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Return catalog providers absent from the runtime provider list. Environment
 * inspection is deliberately reduced to a boolean so credential values can
 * never escape through the tool payload.
 */
export function findMissingProviders(params: {
  runtimeProviderIds: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}): MissingProviderHint[] {
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
