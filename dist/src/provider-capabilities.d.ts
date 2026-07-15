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
/**
 * The full set of recognised capability tags.
 *
 * - `"results"`       Provider returns a ranked list of URLs/snippets (classic
 *                     10-blue-links style).  Nearly every provider has this.
 * - `"answer"`        Provider synthesises a grounded prose answer in addition
 *                     to (or instead of) ranked links.  Examples: Gemini, Grok,
 *                     Perplexity Sonar, Kimi.
 * - `"extract"`       The generic web_search path returns page/content extracts
 *                     useful for downstream grounding. Reserved for future
 *                     dedicated-tool routing where that generic contract does
 *                     not expose extracts.
 * - `"news"`          Provider has a dedicated news index or freshness signal
 *                     that makes it materially better for recency-sensitive
 *                     queries.  Example: Brave.
 * - `"images"`        Provider can return image results.
 * - `"video"`         Provider can return video results.
 * - `"local"`         Provider has strong local/maps intent handling.
 * - `"academic"`      Provider has indexed academic or scientific content.
 *                     Examples: Exa (with a domain filter), Semantic Scholar.
 * - `"code"`          Provider is particularly good at code / technical queries.
 * - `"neural"`        Provider uses neural / semantic retrieval rather than
 *                     (only) keyword matching.  Examples: Exa, Perplexity.
 * - `"free-tier"`     Provider is usable without a paid API key at a meaningful
 *                     call volume.  Examples: DuckDuckGo, SearXNG.
 * - `"privacy"`       Provider explicitly avoids user-level tracking.  Examples:
 *                     DuckDuckGo, Brave, SearXNG.
 */
export type ProviderCapability = "results" | "answer" | "extract" | "news" | "images" | "video" | "local" | "academic" | "code" | "neural" | "free-tier" | "privacy";
/** Immutable ordered list of all known capability tags (useful for validation). */
export declare const ALL_PROVIDER_CAPABILITIES: readonly ProviderCapability[];
/**
 * Return the registered capability set for the given provider id, normalised
 * to lowercase.  Returns an empty array for unknown providers.
 */
export declare function resolveProviderCapabilities(providerId: string): readonly ProviderCapability[];
/**
 * Check whether a capability set includes a particular capability.
 */
export declare function hasCapability(capabilities: readonly ProviderCapability[], capability: ProviderCapability): boolean;
/**
 * Return the subset of providers from `providerIds` that have ALL of the
 * requested capabilities.
 */
export declare function filterByCapabilities(providerIds: readonly string[], required: readonly ProviderCapability[]): string[];
/**
 * Return the subset of providers from `providerIds` that have AT LEAST ONE of
 * the requested capabilities.
 */
export declare function filterByAnyCapability(providerIds: readonly string[], any: readonly ProviderCapability[]): string[];
