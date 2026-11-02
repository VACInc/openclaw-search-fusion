# Search Fusion

Federated web search for OpenClaw.

This plugin reuses the web search providers you already have configured, fans them out in parallel, merges duplicate URLs, preserves which provider found what, and returns compact evidence with full raw payloads available by opt-in.

## Requirements

- OpenClaw `2026.4.9` or newer

The broker relies on the newer plugin runtime web-search helpers. Older OpenClaw builds may install the package but will not provide the runtime surface this plugin expects.

`wrapWebContent` first shipped from `openclaw/plugin-sdk/provider-web-search` in OpenClaw `2026.3.22`. Search Fusion keeps the higher `2026.4.9` minimum required by its runtime provider-discovery surface and feature-detects the wrapper for compatible SDK variants.

The built-in provider catalog and enablement hints track the native OpenClaw `2026.7.2` web-search provider contracts.

## What it adds

- A **web search provider** named `search-fusion`
- A direct **agent tool** named `search_fusion`
- A helper tool named `search_fusion_providers`
- A **provider capability taxonomy** in `src/provider-capabilities.ts`

## Why this exists

OpenClaw already has solid search providers. The missing piece was orchestration.

Search Fusion is the orchestration layer:

- discover configured providers
- report native catalog providers hidden because their owning plugin is not enabled
- run them in parallel
- avoid querying paid and keyless siblings backed by the same index in one fan-out
- retry transient provider failures with configurable policy
- merge duplicate URLs
- keep provider attribution intact
- return bounded provider evidence and per-provider merged variants; raw payloads are opt-in
- expose native ranks, deterministic flags, merged rankings, and machine-readable ranking explainability
- emit structured `payload.evidenceTable` rows for downstream evidence-table renderers (for example Atlas)
- expose one clean result set back to the agent

## Install

Search Fusion is a native **OpenClaw code plugin**, so ClawHub labeling it as **Code Plugin** is correct.

```bash
# recommended: ClawHub first, npm fallback
openclaw plugins install @vacinc/search-fusion

# explicit ClawHub-only install
openclaw plugins install clawhub:@vacinc/search-fusion
```

## Configure

Optional plugin config:

```json
{
  "plugins": {
    "entries": {
      "search-fusion": {
        "enabled": true,
        "config": {
          "modes": {
            "fast": ["brave"],
            "balanced": ["brave", "tavily"],
            "deep": ["brave", "tavily", "gemini", "minimax"],
            "coding": ["minimax", "brave"],
            "cheap": ["duckduckgo", "brave"],
            "results": ["brave", "duckduckgo", "minimax"],
            "answers": ["gemini"]
          },
          "intentProviders": {
            "research": ["exa", "parallel", "tavily"],
            "keyword":  ["brave", "duckduckgo", "minimax"],
            "answer":   ["codex", "gemini", "grok", "kimi", "perplexity"],
            "news":     ["brave"]
          },
          "defaultMode": "balanced",
          "excludeProviders": ["grok"],
          "sourceTierMode": "balanced",
          "maxMergedResults": 10,
          "providerTimeoutMs": 15000,
          "totalTimeoutMs": 30000,
          "maxSnippetLength": 500,
          "includeRawPayloads": false,
          "includeDiscarded": false,
          "retry": {
            "maxAttempts": 3,
            "backoffMs": 750,
            "backoffMultiplier": 2,
            "maxBackoffMs": 5000
          },
          "providerConfig": {
            "exa": {
              "maxResults": 25
            },
            "gemini": {
              "timeoutMs": 60000,
              "weight": 1.3,
              "scoreCalibration": {
                "strategy": "fixed",
                "curve": [
                  { "input": 0, "output": 0 },
                  { "input": 0.5, "output": 0.4 },
                  { "input": 1, "output": 1 }
                ]
              },
              "retry": {
                "maxAttempts": 4,
                "backoffMs": 1500
              }
            },
            "duckduckgo": {
              "weight": 0.8,
              "scoreCalibration": {
                "strategy": "rank"
              }
            }
          }
        }
      }
    }
  }
}
```

If `modes` is omitted, Search Fusion auto-generates starter modes from discovered providers:

- `fast` → first configured provider (or first available provider if nothing is configured)
- `balanced` → first two configured providers (or first two available)
- `deep` → all configured providers (or all available)

If you set `modes`, your map is treated as authoritative and replaces those starter defaults.

Resolution order:

- explicit `providers`
- explicit `mode` (from custom modes, or starter modes when custom modes are absent)
- `intent` hint → matched against `intentProviders`, or against built-in capability rules when that map is omitted
- configured `defaultMode`
- configured `defaultProviders` (backward compatibility)
- otherwise all configured providers

`providerConfig.<id>` is the canonical place for per-provider overrides like `maxResults`, `retry`, `timeoutMs`, `weight`, and `scoreCalibration`. The older `count` field remains supported as a default count when a request does not pass one.

### Provider health (circuit breaker)

Search Fusion remembers provider failures across calls (process-wide). A hard failure (auth, billing such as `insufficient balance`, plan entitlement such as `model_not_found` / `no ... plan`, or a refused/unresolvable endpoint) is never retried in-call and opens that provider's circuit immediately; other failures (timeouts, 5xx) open it after three in a row. While a circuit is open the provider is skipped and reported in `providersFailed` as `circuit open: ...` with `attempts: 0`. After the window expires one probe runs; a failed probe doubles the window up to `maxCooldownMs`, a success closes it. If every selected provider is open, all of them are probed rather than returning nothing. A caller abort never counts as a failure.

```json
"circuitBreaker": { "enabled": true, "hardFailureThreshold": 1, "failureThreshold": 3, "cooldownMs": 300000, "maxCooldownMs": 3600000 }
```

### Ranking strategy

`rankingStrategy` defaults to `score` (`merged-score-v1`: calibrated per-provider scores plus a corroboration bonus). `rrf` switches to weighted reciprocal-rank fusion (`rrf-v1`): each provider contributes `weight / (rrfK + rank)` for its best rank of a merged URL, scaled so a lone rank-1 hit at weight 1 scores 1. Source-tier and flag penalties still apply. `rrfK` defaults to 60; lower values reward top ranks more. RRF helps most when a wide fan-out mixes strong and weak providers; for a small set of strong providers the default `score` ranking measured better.

### Provider result counts

Search Fusion pulls each provider's verified native maximum by default so dedupe and ranking have a deeper candidate pool. Every delegated OpenClaw provider receives its generic `count` argument; the provider adapter translates that to its native request field.

| Provider | Default / native maximum | Adapter behavior |
|---|---:|---|
| `exa` | 100 | `count` becomes Exa `numResults` |
| `parallel` | 40 | `count` becomes `advanced_settings.max_results` |
| `parallel-free` | 40 | `count` only slices the free MCP's fixed-size response client-side |
| `tavily` | 20 | `count` becomes Tavily `max_results` |
| Other known generic providers | 10 | OpenClaw's generic provider contract caps `count` at 10 |

The generic Firecrawl adapters are part of the 10-result row: both `firecrawl` and `firecrawl-free` intentionally accept at most 10 even though Firecrawl's separate provider-specific tool supports a larger count. This keeps the keyless starter tier within its adapter contract. Parallel Free does not ask its hosted MCP for a larger response; its count is applied only after the fixed response arrives. Runtime providers outside the documented OpenClaw catalog retain the historical default of 5 because Search Fusion cannot safely infer a third-party adapter's native ceiling.

Use `providerConfig.<id>.maxResults` to lower a provider's ceiling:

```json
{
  "providerConfig": {
    "exa": { "maxResults": 25 },
    "tavily": { "maxResults": 10 },
    "parallel-free": { "maxResults": 10 }
  }
}
```

A per-call `count`, legacy `providerConfig.<id>.count`, or shared `countPerProvider` can select a smaller pull size. None can exceed `providerConfig.<id>.maxResults` or the native adapter maximum. `maxMergedResults` remains the independent fusion-level output cap, so deeper provider pulls improve dedupe and ranking without increasing the returned merged-result count. `rawCount` reports every transport result item encountered in the supported result arrays, including items later discarded for a missing URL.

`totalTimeoutMs` bounds the whole fan-out, including credential preparation, provider attempts, retries, and backoff (default `30000`, range `5000`–`180000`). When it expires, completed providers are returned as partial results and unfinished providers report `deadline exceeded`. `providerTimeoutMs` still bounds each individual attempt; timed-out and aborted attempts are not retried.

Model-visible output is compact by default:

- `includeRawPayloads` (default `false`) controls full provider payloads and complete audit evidence. Without it, `providerRuns[].results` includes one item per provider for each returned merged URL, merged `variants`/`rankings` and evidence-table provider evidence include one item per contributing provider, and `ranking.dropped` omits detailed records while retaining `droppedCount`.
- `includeDiscarded` (default `false`) controls missing-URL items preserved outside the merged results.
- `maxSnippetLength` (default `500`, range `100`–`5000`) caps result snippets, variant snippets, evidence snippets, and provider answer text. Affected objects carry `truncated: true`.

Both include flags can be set in plugin config or overridden per `search_fusion` call. Audit consumers such as Atlas can enable both flags to retain full source fidelity in raw payloads while normalized model-visible fields remain bounded.

`excludeProviders` applies to automatic intent/default fallback selection. Explicit `providers` and explicit custom modes can deliberately select an excluded provider.

`providerConfig.<id>.weight` is a ranking multiplier (default `1`, range `0.1` to `5`). Higher values boost trusted providers, lower values down-weight noisier ones.

`providerConfig.<id>.scoreCalibration` makes heterogeneous provider scores comparable before fusion:

- No calibration config defaults to `minmax`, scaling that provider's native scores within the current result set to `[0,1]`.
- `strategy: "rank"` ignores native score magnitude and uses `1 / rawRank`.
- `strategy: "fixed"` uses a configured piecewise-linear `curve` of `{ "input", "output" }` points. Inputs must be strictly increasing, outputs must be non-decreasing within `[0,1]`, and at least two points are required. Values outside the curve use the nearest endpoint. Supplying `curve` without `strategy` also selects `fixed`.
- `strategy: "none"` disables calibration for that provider: native scores pass through unchanged (clamped to `[0,1]`), matching pre-calibration behavior.
- With `minmax`, a singleton or equal native scores make the complete provider set fall back to `1 / rawRank`. A fixed curve remains absolute for singleton and equal-score sets.
- With any strategy that needs native scores, a missing, non-finite, or negative native score makes the complete provider set fall back to `1 / rawRank`. The set-wide fallback avoids mixing incomparable native and synthetic values.

Calibration happens before source-type/trust penalties and the optional provider weight. Clean result-style hits with the default weight retain their calibrated `[0,1]` score; an explicit weight above `1` can intentionally move the merge score above that interval. Native provider values remain available as `nativeScore`.

Fuzzy dedupe is a fusion feature controlled by `fuzzyDedupe`: it activates by default only when more than one provider contributes results, so single-provider searches return that provider's result set untouched (legacy exact canonical-URL merge only). Set `fuzzyDedupe` to `true` to force it for single-provider runs, or `false` to disable it everywhere. When active, it folds HTTP into HTTPS, default ports, `www.`/`m.`/`amp.` host variants, terminal `/amp` paths, fragments, trailing slashes, and known tracking parameters. Meaningful query parameters remain part of URL identity. Normalized-title equality is used only for results on the same canonical host with the same remaining query, so equal titles never merge across sites or across conflicting query values.

The default tracking list is `utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid`, `mc_eid`, and `igshid`. Add site-specific names with `trackingParams`; its default `trackingParamMode` is `extend`. Set the mode to `override` to replace the defaults entirely. The active policy is also applied before result and answer-citation normalization, so a parameter omitted by an override remains present in navigation URLs and is attributed to the correct evidence row. Set `fuzzyDedupe` to `false` to retain only the legacy exact canonical-URL merge.

```json
{
  "fuzzyDedupe": true,
  "trackingParams": ["campaign_id", "pk_*"],
  "trackingParamMode": "extend"
}
```

`sourceTierMode` controls deterministic trust-tier downranking:

- `off`: disables source-tier adjustments
- `balanced` (default): favors high-trust result classes and downranks low-trust classes
- `strict`: stronger suppression of lower-trust classes

### Intent-based routing

Set `intentProviders` to define provider selection when a caller passes an `intent` hint. The intent is applied after explicit `providers`/`mode` but before `defaultMode`/`defaultProviders`, so it only kicks in when the caller leaves routing unspecified.

When `intentProviders` is omitted entirely, Search Fusion uses the capability registry: `research` matches `academic`, `extract`, or `neural`; `keyword` matches providers with `results` but without `answer` (classic index style); `answer` matches `answer`; and `news` matches `news`. Only configured providers are considered when any are configured. OpenClaw 2026.7.2 has no provider with verified local strength through the generic path, so `local` falls through to the normal default chain unless `intentProviders.local` is set explicitly.

Supported intents:

| Intent | Suggested use | Example providers |
|---|---|---|
| `research` | In-depth investigation and content-oriented retrieval | `exa`, `parallel`, `tavily` |
| `keyword` | Classic keyword/web search | `brave`, `duckduckgo`, `minimax` |
| `answer` | Direct answer expected | `codex`, `gemini`, `grok`, `kimi`, `perplexity` |
| `news` | Recent news / current events | `brave` |
| `local` | Location-aware queries | No built-in preference; configure `intentProviders.local` if desired |

Example config snippet:

```json
{
  "plugins": {
    "entries": {
      "search-fusion": {
        "config": {
          "intentProviders": {
            "research": ["exa", "parallel", "tavily"],
            "keyword":  ["brave", "duckduckgo", "minimax"],
            "answer":   ["codex", "gemini", "grok", "kimi", "perplexity"],
            "news":     ["brave"]
          }
        }
      }
    }
  }
}
```

When a custom `intentProviders` map has no entry for the given intent, or the mapped providers are unavailable, routing falls through to `defaultMode`, `defaultProviders`, and finally all configured providers. Providing the map opts out of built-in capability routing so custom intent policy remains authoritative.

If you want the built-in `web_search` tool to route through the broker by default:

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "search-fusion"
      }
    }
  }
}
```

## Tool usage

### `search_fusion`

Example prompt:

- Search across all configured providers for `openclaw plugin sdk runtime helpers`
- Search brave and tavily only for `best local llm web search api` with 3 results each
- Search in `deep` mode for `best local llm web search api`

Supported arguments:

- `query`
- `intent` — optional routing hint: `research`, `keyword`, `answer`, `news`, or `local`
- `mode` — mode name from configured modes, or starter modes (`fast`, `balanced`, `deep`) when custom modes are not set
- `providers` — provider ids, or `all`
- `count` — requested per-provider pull count (1–100), clamped independently to each provider's configured and native maximum
- `maxMergedResults`
- `country`
- `language`
- `freshness`
- `date_after`
- `date_before`
- `search_lang`
- `ui_lang`
- `includeFailures`
- `includeRawPayloads`
- `includeDiscarded`

Unknown explicit provider ids are input errors. The error lists the valid runtime provider ids instead of silently returning an empty search.

## External-content security boundary

Provider wrappers are removed only inside normalization so snippets can be deduplicated and ranked consistently. At each model-visible exit—the `search_fusion` agent tool and the `search-fusion` web-search provider—Search Fusion serializes the complete bounded payload and wraps it exactly once with `wrapWebContent(json, "web_search")`. OpenClaw sanitizes any spoofed external-content markers embedded in provider text before adding one randomized `EXTERNAL_UNTRUSTED_CONTENT` boundary pair.

The structured payload retains `externalContent.untrusted: true` metadata for non-model consumers. That metadata is descriptive; the randomized wrapper around model-visible text is the actual trust boundary. A small randomized local fallback provides the same boundary and marker sanitization when the SDK export is unavailable.

## Ranking explainability

Merged payloads include:

- `results[].ranking` with the final rank, score breakdown (`bestVariantScore`, `corroborationBonus`, `bestRankBonus`, `tierAdjustment`, `flagPenalty`, `finalScore`), and tie-breaker values. `bestRankBonus` is retained as a compatibility field with value `0`; original rank is applied only as the explicit final tie-breaker.
- top-level `ranking` metadata with the strategy, sort order, considered/returned counts, and `droppedCount` for results trimmed by the output cap. Detailed `dropped[]` records (with `reason: "maxMergedResults"`) are included only with `includeRawPayloads: true`.

Final ordering is deterministic: descending score, selected-provider priority, then original provider rank. Results still tied on all three keys retain their insertion order. The selected `providers`/mode order therefore acts as the provider-priority order and is exposed in `ranking.tieBreakers`.

### `search_fusion_providers`

Lists the providers visible to the broker and whether they appear configured.

#### How discovery works

Search Fusion unions the active runtime registry with its native provider catalog, adding catalog providers whose owning plugin is enabled in the live config. Runtime entries win on id collisions and keep their full credential accessors; catalog entries cover providers not yet present because OpenClaw activates plugins lazily. The resulting union drives listing, selection, modes, intent routing, sibling dedupe, and fan-out; delegated search still asks the runtime to load the selected provider on demand.

Before delegation, Search Fusion resolves plugin-entry or scoped credential SecretRefs for catalog-derived provider stubs so lazy-loaded providers receive the resolved credential config.

For catalog-derived entries, `credentialSource` reports `keyless`, `plugin-config (declared)`, `environment (<NAME>)`, or `account-auth` for Codex. A declared plugin `webSearch.apiKey` may be a string or SecretRef; Search Fusion reports only that it was declared, never its value. Enabled catalog providers without a detectable configuration remain selectable but report `configured: false` with a setup hint.

The additive `missing` array now reports native catalog providers whose owning plugin is disabled or not enabled in the live config, with:

- `id` — runtime provider id
- `pluginId` — plugin to enable
- `keyless` — whether the provider needs neither an API key nor account auth/config
- `envKeyDetected` — whether any known environment credential is present

`envKeyDetected` is boolean-only. Search Fusion never returns environment credential values. A provider can still be configured through plugin config or account auth when this flag is `false`.

Registry-derived provider entries also include a non-secret `credentialSource` annotation when known. Because the plugin context cannot inspect the account-auth profile store directly, registry providers that declare `authProviderId` are included with `account-auth (unverified)` rather than being incorrectly omitted; the delegated OpenClaw runtime still performs the authoritative auth check.

### OpenClaw 2026.7.2 provider coverage

| Runtime provider id | Owning plugin | Credential / setup | Keyless |
|---|---|---|---|
| `brave` | `brave` | `BRAVE_API_KEY` or plugin `webSearch.apiKey` | No |
| `codex` | `codex` | OpenAI/Codex account auth (`openaiCodex` mode) | No |
| `duckduckgo` | `duckduckgo` | None | Yes |
| `exa` | `exa` | `EXA_API_KEY` | No |
| `firecrawl` | `firecrawl` | `FIRECRAWL_API_KEY` | No |
| `firecrawl-free` | `firecrawl` | None; hosted starter tier, maximum count 10 | Yes |
| `gemini` | `google` | `GEMINI_API_KEY`, plugin `webSearch.apiKey`, or `models.providers.google.apiKey` fallback | No |
| `grok` | `xai` | xAI account auth, `XAI_API_KEY`, or `tools.web.search.grok.apiKey` | No |
| `kimi` | `moonshot` | `KIMI_API_KEY` or `MOONSHOT_API_KEY` | No |
| `minimax` | `minimax` | `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` / `MINIMAX_OAUTH_TOKEN` / `MINIMAX_API_KEY`, or plugin `webSearch.apiKey` | No |
| `ollama` | `ollama` | `OLLAMA_API_KEY` / local Ollama server | No |
| `parallel` | `parallel` | `PARALLEL_API_KEY` | No |
| `parallel-free` | `parallel` | None | Yes |
| `perplexity` | `perplexity` | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY`, or plugin `webSearch.apiKey` | No |
| `searxng` | `searxng` | Self-hosted endpoint configuration | No |
| `tavily` | `tavily` | `TAVILY_API_KEY` or plugin `webSearch.apiKey` | No |

The native `KNOWN_PROVIDERS` catalog contains all 16 rows and deliberately excludes the test-only `qa-lab-search` provider.

When both `firecrawl` and `firecrawl-free` resolve into one fan-out, Search Fusion uses only the paid sibling when it is configured; otherwise it keeps the free sibling. The same rule applies to `parallel` and `parallel-free`.

## Evidence table output (`payload.evidenceTable`)

Search Fusion emits a table-ready structure for downstream consumers like Atlas.

- `columns[]` provides stable column metadata (`key`, `label`, `description`)
- `rows[]` has one row per merged URL (`rowId` is the canonical URL)
- `rows[].answerCitationSupport` tracks citation count and citing providers from answer-style runs
- `rows[].providerEvidence[]` keeps provider-level rank, calibrated/weighted score, native score when supplied, source type, flags, and snippets for drill-down cells

Example flattening transform:

```ts
const tableRows = payload.evidenceTable.rows.map((row) => ({
  rank: row.rank,
  title: row.title,
  url: row.url,
  providers: row.providers.join(", "),
  providerCount: row.providerCount,
  bestRank: row.bestRank,
  score: Number(row.score.toFixed(3)),
  answerCitationCount: row.answerCitationSupport.count,
  flags: row.flags.join(", "),
}));
```

## Development

```bash
pnpm install
pnpm check
pnpm test
```

## Current behavior

- starter modes are built in for fresh installs (`fast`, `balanced`, `deep`) when `modes` is not configured
- custom `modes` are authoritative and replace the starter map
- falls back to all configured providers when nothing else is specified
- treats discovered keyless providers (DuckDuckGo, Firecrawl Free, and Parallel Free) as configured/available
- prefers a paid sibling only when it is configured; otherwise keeps the keyless sibling
- reports native providers whose plugins are disabled/not enabled, with plugin ids and boolean-only credential detection hints
- excludes itself to avoid recursion
- dedupes fuzzy URL variants by default, with same-host normalized titles as a guarded secondary signal
- retries transient provider failures with global defaults and per-provider overrides via `providerConfig.<id>.retry`
- calibrates each provider's relevance scores with default minmax normalization, rank fallback for degenerate score sets, and optional fixed curves
- supports deterministic provider weighting via `providerConfig.<id>.weight` to bias ranking by provider trust/value
- isolates unexpected provider pipeline crashes so one provider cannot abort the whole fusion run
- omits raw provider payloads and discarded items by default; exposes them through explicit output flags
- caps model-visible snippets and answers with explicit `truncated: true` markers
- honors caller cancellation, aborts delegated searches, and enforces a whole-fan-out deadline with partial results
- preserves per-provider merged variants in `results[].variants[]`
- emits `evidenceTable.columns[]` and `evidenceTable.rows[]` for direct evidence-table rendering
- includes `evidenceTable.rows[].answerCitationSupport` and `providerEvidence[]` helper fields for claim-support views
- surfaces deterministic flags like `sponsored`, `redirect-wrapper`, `tracking-stripped`, `community`, and `video`
- surfaces native ranks, merged rankings, per-result score breakdowns, and dropped-result reasons so ranking decisions are auditable
- classifies each hit into a source tier (`high`, `standard`, `low`, `suppressed`) and downranks lower-trust classes deterministically
- carries answer-style providers (Codex / Gemini / Grok / Kimi / Perplexity) as provider digests with `fullContent`, citation details, and citation-derived hits
- supports honest capability-driven defaults: classic non-answer providers for `keyword`, answer providers for `answer`, and default fallback for `local` unless explicitly mapped

## Provider capability taxonomy

Each provider carries a set of declarative **capability tags** that describe what it is good at.  These are resolved at discovery time and attached to `ResolvedProvider.capabilities`.

```ts
import {
  resolveProviderCapabilities,
  hasCapability,
  filterByCapabilities,
  filterByAnyCapability,
  ALL_PROVIDER_CAPABILITIES,
} from "@vacinc/search-fusion";

// What can brave do?
resolveProviderCapabilities("brave");      // ["news", "privacy", "results"]
resolveProviderCapabilities("gemini");     // ["answer", "results"]
resolveProviderCapabilities("exa");        // ["academic", "code", "extract", "neural", "results"]
resolveProviderCapabilities("duckduckgo"); // ["free-tier", "privacy", "results"]
resolveProviderCapabilities("minimax");    // ["code", "results"]
resolveProviderCapabilities("firecrawl");  // ["results"]

// Does Parallel's generic path return extraction-oriented excerpts?
hasCapability(resolveProviderCapabilities("parallel"), "extract"); // true

// Tavily's generic OpenClaw path returns results, not answers.
hasCapability(resolveProviderCapabilities("tavily"), "answer"); // false

// Which providers are both neural and answer-capable?
filterByCapabilities(["brave", "exa", "tavily", "perplexity"], ["neural", "answer"]);
// => ["perplexity"]

// Which providers have any privacy-preserving capability?
filterByAnyCapability(["brave", "duckduckgo", "gemini"], ["privacy", "free-tier"]);
// => ["brave", "duckduckgo"]
```

### Full capability vocabulary

| Tag | Meaning |
|---|---|
| `results` | Returns a ranked list of URLs/snippets (classic web search). |
| `answer` | Synthesises a grounded prose answer alongside or instead of links. |
| `extract` | Generic `web_search` returns page/content extracts; reserved for future dedicated-tool routing elsewhere. |
| `news` | Has a dedicated news index or strong freshness/recency signal. |
| `images` | Can return image results. |
| `video` | Can return video results. |
| `local` | Verified local/maps strength through the generic path (none in OpenClaw 2026.7.2). |
| `academic` | Indexed academic or scientific content. |
| `code` | Particularly good at code / technical queries. |
| `neural` | Uses neural / semantic retrieval rather than (only) keyword matching. |
| `free-tier` | Usable at meaningful call volume without a paid API key. |
| `privacy` | Explicitly avoids user-level tracking. |

### Known registry (built-in)

| Provider id | Capabilities |
|---|---|
| `brave` | `news`, `privacy`, `results` |
| `codex` | `answer`, `results` |
| `duckduckgo` | `free-tier`, `privacy`, `results` |
| `exa` | `academic`, `code`, `extract`, `neural`, `results` |
| `firecrawl` | `results` |
| `firecrawl-free` | `free-tier`, `results` |
| `gemini` | `answer`, `results` |
| `grok` | `answer`, `news`, `results` |
| `kimi` | `answer`, `results` |
| `minimax` | `code`, `results` |
| `ollama` | `free-tier`, `results` |
| `parallel` | `extract`, `neural`, `results` |
| `parallel-free` | `extract`, `free-tier`, `neural`, `results` |
| `perplexity` | `answer`, `neural`, `results` |
| `searxng` | `free-tier`, `privacy`, `results` |
| `tavily` | `neural`, `results` |

Providers not in the registry return an empty capability set (treated as general-purpose).  Future routing features such as cost-aware mode selection and automatic mode generation will build on this taxonomy.

## Next upgrades

- capability-driven automatic mode generation beyond the built-in intent rules
- provider weighting based on capability scores
- cost-aware routing modes
- caching at the broker layer
- optional fetch/expansion of top merged hits
