/**
 * Provider Capability Taxonomy
 *
 * A lightweight, enumerated model that describes what each known web-search
 * provider is good at.  It is deliberately narrow: the goal is to give future
 * routing logic a stable vocabulary to reason over rather than trying to rank
 * providers along every possible dimension.
 *
 * Design principles
 * -----------------
 * - Additive: adding a new capability never breaks existing code.
 * - Non-exclusive: a provider can (and usually does) have multiple capabilities.
 * - Declared, not detected: capabilities are statically registered per provider
 *   id, not inferred at runtime from credentials or payloads.
 * - Conservative: only include capabilities we have reasonable evidence for; an
 *   empty set is valid and means "general-purpose / unknown".
 *
 * How routing code can use this
 * ------------------------------
 * A mode like "answers" can select providers where `hasCapability(p, "answer")`
 * is true; a "news" mode can prefer providers with "news"; cost-aware routing
 * can prefer providers with "free-tier"; etc.
 *
 *   import { resolveProviderCapabilities, hasCapability } from "./provider-capabilities.js";
 *
 *   const caps = resolveProviderCapabilities("gemini");
 *   if (hasCapability(caps, "answer")) { ... }
 */
/** Immutable ordered list of all known capability tags (useful for validation). */
export const ALL_PROVIDER_CAPABILITIES = [
    "results",
    "answer",
    "extract",
    "news",
    "images",
    "video",
    "local",
    "academic",
    "code",
    "neural",
    "free-tier",
    "privacy",
];
// ---------------------------------------------------------------------------
// Per-provider capability registry
// ---------------------------------------------------------------------------
/**
 * Known capabilities for each provider id.
 *
 * Keys are lowercase provider ids as registered with the OpenClaw web search
 * runtime.  Values are sorted arrays of ProviderCapability.  Any provider id
 * NOT in this map is treated as having an empty capability set (i.e. completely
 * general-purpose).
 *
 * This is the single source of truth — keep it alphabetically sorted by key
 * to make diffs reviewable.
 */
const PROVIDER_CAPABILITY_REGISTRY = {
    brave: ["news", "privacy", "results"],
    codex: ["answer", "results"],
    duckduckgo: ["free-tier", "privacy", "results"],
    exa: ["academic", "code", "extract", "neural", "results"],
    firecrawl: ["results"],
    "firecrawl-free": ["free-tier", "results"],
    gemini: ["answer", "results"],
    grok: ["answer", "news", "results"],
    kimi: ["answer", "results"],
    minimax: ["code", "results"],
    ollama: ["free-tier", "results"],
    parallel: ["extract", "neural", "results"],
    "parallel-free": ["extract", "free-tier", "neural", "results"],
    perplexity: ["answer", "neural", "results"],
    searxng: ["free-tier", "privacy", "results"],
    tavily: ["neural", "results"],
};
// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------
/**
 * Return the registered capability set for the given provider id, normalised
 * to lowercase.  Returns an empty array for unknown providers.
 */
export function resolveProviderCapabilities(providerId) {
    return PROVIDER_CAPABILITY_REGISTRY[providerId.toLowerCase()] ?? [];
}
/**
 * Check whether a capability set includes a particular capability.
 */
export function hasCapability(capabilities, capability) {
    return capabilities.includes(capability);
}
/**
 * Return the subset of providers from `providerIds` that have ALL of the
 * requested capabilities.
 */
export function filterByCapabilities(providerIds, required) {
    if (required.length === 0)
        return [...providerIds];
    return providerIds.filter((id) => {
        const caps = resolveProviderCapabilities(id);
        return required.every((cap) => caps.includes(cap));
    });
}
/**
 * Return the subset of providers from `providerIds` that have AT LEAST ONE of
 * the requested capabilities.
 */
export function filterByAnyCapability(providerIds, any) {
    if (any.length === 0)
        return [...providerIds];
    return providerIds.filter((id) => {
        const caps = resolveProviderCapabilities(id);
        return any.some((cap) => caps.includes(cap));
    });
}
