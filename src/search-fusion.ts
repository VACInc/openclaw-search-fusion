import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  FusionEvidenceRow,
  FusionEvidenceTable,
  FusionMergedResult,
  FusionRankingMeta,
  FusionRankingStrategy,
  FusionScoreBreakdown,
  FusionSearchPayload,
  NormalizedSearchResult,
  ProviderAnswerDigest,
  ProviderRunResult,
  ProviderSelectionRequest,
  ResolvedProvider,
  RuntimeWebSearchProvider,
  SearchFusionCircuitBreakerConfig,
  SearchFusionConfig,
  SearchFusionProviderConfig,
  SearchFusionRetryConfig,
  SearchResultFlag,
  SearchRuntime,
  SourceTierMode,
} from "./types.js";
import { discoverProviders, resolveSelectedProviders } from "./provider-discovery.js";
import { readTopPages, resolveReadPagesConfig, type PageReaderDeps } from "./page-reader.js";
import { KNOWN_PROVIDERS } from "./provider-catalog.js";
import {
  applySearchResultQuality,
  calibrateProviderScores,
  normalizeProviderPayload,
  validateScoreCalibrationConfig,
} from "./result-normalizer.js";
import {
  compareSourceTierDesc,
  coerceSourceTierMode,
  pickHigherSourceTier,
  sourceTierMergedAdjustment,
} from "./source-tier.js";
import {
  analyzeFuzzyUrl,
  canonicalizeUrl,
  normalizeTitle,
  type FuzzyUrlAnalysis,
  type FuzzyUrlOptions,
} from "./text.js";

const DEFAULT_UNKNOWN_PROVIDER_COUNT = 5;
const DEFAULT_GENERIC_PROVIDER_MAX_RESULTS = 10;
const DEFAULT_MAX_MERGED_RESULTS = 10;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SNIPPET_LENGTH = 500;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 750;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_PROVIDER_WEIGHT = 1;
const MIN_PROVIDER_WEIGHT = 0.1;
const MAX_PROVIDER_WEIGHT = 5;
const SEARCH_FUSION_PROVIDER_ID = "search-fusion";
const MERGED_RANKING_STRATEGY = "merged-score-v1" as const;
const MERGED_SORT_ORDER = [
  "score:desc",
  "providerPriority:asc",
  "bestRank:asc",
] as const;
const RRF_RANKING_STRATEGY = "rrf-v1" as const;
const DEFAULT_RRF_K = 60;
const DEFAULT_CIRCUIT_HARD_FAILURE_THRESHOLD = 1;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_CIRCUIT_MAX_COOLDOWN_MS = 60 * 60 * 1000;

type RankingOptions = {
  strategy: FusionRankingStrategy;
  rrfK: number;
  weights: ReadonlyMap<string, number>;
};

const DEFAULT_RANKING_OPTIONS: RankingOptions = {
  strategy: MERGED_RANKING_STRATEGY,
  rrfK: DEFAULT_RRF_K,
  weights: new Map(),
};

// Failures that will not heal by retrying the same call: credentials, billing,
// plan entitlement, or an endpoint that is not listening. They skip in-call
// retries and open the provider circuit on the first occurrence by default.
const HARD_FAILURE_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b402\b/,
  /\b403\b/,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid api key/i,
  /missing api key/i,
  /api key (?:is )?(?:missing|invalid|required)/i,
  /credential/i,
  /insufficient (?:balance|credit|credits|funds|quota)/i,
  /payment required/i,
  /billing/i,
  /model_not_found/i,
  /\bno [\w-]+ plan\b/i,
  /not (?:included|available) (?:in|on|with) (?:your|the|this) (?:plan|subscription)/i,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /EHOSTUNREACH/,
  /EAI_AGAIN/,
];

export function isHardProviderFailure(message: string | undefined): boolean {
  if (!message) return false;
  return HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

type ResolvedCircuitBreaker = {
  enabled: boolean;
  hardFailureThreshold: number;
  failureThreshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
};

type ProviderHealth = {
  consecutiveFailures: number;
  lastHard: boolean;
  openUntilMs: number;
  openCount: number;
  lastError?: string;
};

// Process-wide on purpose: health must survive across tool calls so a dead
// source is skipped instead of costing its timeout and retries on every search.
const providerHealth = new Map<string, ProviderHealth>();

export function resetProviderHealthForTests(): void {
  providerHealth.clear();
}

export function getProviderHealthSnapshot(nowMs = Date.now()): Record<
  string,
  { consecutiveFailures: number; open: boolean; openForMs: number; openCount: number; lastError?: string }
> {
  return Object.fromEntries(
    [...providerHealth.entries()].map(([providerId, health]) => [
      providerId,
      {
        consecutiveFailures: health.consecutiveFailures,
        open: health.openUntilMs > nowMs,
        openForMs: Math.max(0, health.openUntilMs - nowMs),
        openCount: health.openCount,
        ...(health.lastError ? { lastError: health.lastError } : {}),
      },
    ]),
  );
}

function resolveCircuitBreaker(config: SearchFusionConfig): ResolvedCircuitBreaker {
  const raw: SearchFusionCircuitBreakerConfig = config.circuitBreaker ?? {};
  const cooldownMs = clamp(raw.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS, 1000, 24 * 60 * 60 * 1000);
  return {
    enabled: raw.enabled !== false,
    hardFailureThreshold: clamp(
      Math.round(raw.hardFailureThreshold ?? DEFAULT_CIRCUIT_HARD_FAILURE_THRESHOLD),
      1,
      100,
    ),
    failureThreshold: clamp(Math.round(raw.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD), 1, 100),
    cooldownMs,
    maxCooldownMs: Math.max(
      cooldownMs,
      clamp(raw.maxCooldownMs ?? DEFAULT_CIRCUIT_MAX_COOLDOWN_MS, 1000, 7 * 24 * 60 * 60 * 1000),
    ),
  };
}

function openCircuitFor(providerId: string, nowMs: number): ProviderHealth | undefined {
  const health = providerHealth.get(providerId);
  return health && health.openUntilMs > nowMs ? health : undefined;
}

function recordProviderOutcome(
  policy: ResolvedCircuitBreaker,
  run: ProviderRunResult,
  nowMs: number,
): void {
  if (run.ok) {
    providerHealth.delete(run.providerId);
    return;
  }
  const prior = providerHealth.get(run.providerId);
  const hard = isHardProviderFailure(run.error);
  const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
  const next: ProviderHealth = {
    consecutiveFailures,
    lastHard: hard,
    openUntilMs: prior?.openUntilMs ?? 0,
    openCount: prior?.openCount ?? 0,
    lastError: run.error,
  };
  const threshold = hard ? policy.hardFailureThreshold : policy.failureThreshold;
  if (consecutiveFailures >= threshold) {
    const windowMs = Math.min(
      policy.maxCooldownMs,
      policy.cooldownMs * Math.pow(2, next.openCount),
    );
    next.openUntilMs = nowMs + windowMs;
    next.openCount += 1;
  }
  providerHealth.set(run.providerId, next);
}

function circuitOpenResult(
  provider: ResolvedProvider,
  health: ProviderHealth,
  nowMs: number,
): ProviderRunResult {
  const remainingSeconds = Math.max(1, Math.ceil((health.openUntilMs - nowMs) / 1000));
  return {
    providerId: provider.id,
    label: provider.label,
    configured: provider.configured,
    ok: false,
    tookMs: 0,
    rawCount: 0,
    attempts: 0,
    results: [],
    discardedResults: [],
    retryHistory: [],
    error: `circuit open: skipped for ${remainingSeconds}s more after ${health.consecutiveFailures} consecutive failure(s); last error: ${health.lastError ?? "unknown"}`,
  };
}

function resolveRankingOptions(
  config: SearchFusionConfig,
  providerIds: readonly string[],
): RankingOptions {
  if (config.rankingStrategy !== "rrf") {
    return DEFAULT_RANKING_OPTIONS;
  }
  return {
    strategy: RRF_RANKING_STRATEGY,
    rrfK: clamp(config.rrfK ?? DEFAULT_RRF_K, 1, 1000),
    weights: new Map(
      providerIds.map((providerId) => [
        providerId,
        clamp(
          resolveProviderConfig(config, providerId).weight ?? DEFAULT_PROVIDER_WEIGHT,
          MIN_PROVIDER_WEIGHT,
          MAX_PROVIDER_WEIGHT,
        ),
      ]),
    ),
  };
}

type ProviderResultCountContract = {
  maxResults: number;
  adapterHandling: string;
  freeTier?: true;
};

/**
 * Result-count contracts verified against the OpenClaw generic web-search
 * adapters. Search Fusion always sends the adapter-facing `count` argument;
 * each adapter translates or applies it as described below.
 *
 * | Provider        | Native request field               | Maximum |
 * |-----------------|------------------------------------|---------|
 * | exa             | `numResults`                       | 100     |
 * | parallel        | `advanced_settings.max_results`    | 40      |
 * | parallel-free   | client-side slice of MCP response  | 40      |
 * | tavily          | `max_results`                      | 20      |
 *
 * The object also records every other catalog provider's generic 10-result
 * contract. Both Firecrawl adapters intentionally cap generic paid and
 * keyless searches at 10 even though the provider-specific Firecrawl tool can
 * request more. Parallel Free's 40-result ceiling is applied only after the
 * hosted free MCP returns its fixed-size response, so this broker does not
 * increase free-tier upstream usage. Unknown third-party providers retain the
 * historical default of 5 because their native ceiling is not known here.
 */
const PROVIDER_RESULT_COUNT_CONTRACTS: Readonly<Record<string, ProviderResultCountContract>> = {
  brave: {
    maxResults: 10,
    adapterHandling: "native count query parameter",
  },
  codex: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  duckduckgo: {
    maxResults: 10,
    adapterHandling: "client-side result slice",
    freeTier: true,
  },
  exa: {
    maxResults: 100,
    adapterHandling: "native numResults",
  },
  firecrawl: {
    maxResults: 10,
    adapterHandling: "native limit",
  },
  "firecrawl-free": {
    maxResults: 10,
    adapterHandling: "native limit",
    freeTier: true,
  },
  gemini: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  grok: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  kimi: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  minimax: {
    maxResults: 10,
    adapterHandling: "client-side result slice",
  },
  ollama: {
    maxResults: 10,
    adapterHandling: "native max_results",
  },
  parallel: {
    maxResults: 40,
    adapterHandling: "native advanced_settings.max_results",
  },
  "parallel-free": {
    maxResults: 40,
    adapterHandling: "client-side slice of fixed MCP response",
    freeTier: true,
  },
  perplexity: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  searxng: {
    maxResults: 10,
    adapterHandling: "generic adapter contract",
  },
  tavily: {
    maxResults: 20,
    adapterHandling: "native max_results",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretRefLike(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function cloneConfigForCredentialInjection(config: unknown): unknown {
  if (!isRecord(config)) {
    return config;
  }
  return structuredClone(config);
}

function readConfigPath(config: unknown, path: readonly string[]): unknown {
  let current = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function writeConfigPath(config: unknown, path: readonly string[], value: string): void {
  let current = config;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current)) {
      throw new Error(`Unable to inject resolved credential at ${path.join(".")}.`);
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    throw new Error(`Unable to inject resolved credential at ${path.join(".")}.`);
  }
  current[path.at(-1)!] = value;
}

function resolveSearchConfig(config: unknown): Record<string, unknown> | undefined {
  const tools = isRecord(config) ? config.tools : undefined;
  const web = isRecord(tools) ? tools.web : undefined;
  const search = isRecord(web) ? web.search : undefined;
  return isRecord(search) ? search : undefined;
}

function applySearchConfigContext(
  config: unknown,
  searchConfig: Record<string, unknown> | undefined,
): unknown {
  if (!searchConfig || !isRecord(config)) return config;
  if (resolveSearchConfig(config) === searchConfig) return config;
  const tools = isRecord(config.tools) ? config.tools : {};
  const web = isRecord(tools.web) ? tools.web : {};
  return {
    ...config,
    tools: {
      ...tools,
      web: {
        ...web,
        search: searchConfig,
      },
    },
  };
}

// OpenClaw 2026.10 retired the plugin-sdk/config-runtime facade. Prefer the
// focused subpath and fall back to the facade so older supported gateways keep working.
const LEGACY_CONFIG_RUNTIME = "openclaw/plugin-sdk/config-runtime";

async function importSdkExport<T>(focusedPath: string, name: string): Promise<T | undefined> {
  for (const path of [focusedPath, LEGACY_CONFIG_RUNTIME]) {
    try {
      const mod = (await import(path)) as Record<string, unknown>;
      if (typeof mod[name] === "function") {
        return mod[name] as T;
      }
    } catch {
      // Subpath not exported by this OpenClaw version; try the next one.
    }
  }
  return undefined;
}

async function resolveRuntimeSourceConfig(fallback: unknown): Promise<unknown> {
  const getSourceSnapshot = await importSdkExport<() => unknown>(
    "openclaw/plugin-sdk/runtime-config-snapshot",
    "getRuntimeConfigSourceSnapshot",
  );
  // Older OpenClaw SDKs do not expose source snapshots to plugins.
  return getSourceSnapshot ? (getSourceSnapshot() ?? fallback) : fallback;
}

async function resolveSecretRefValue(params: {
  config: unknown;
  value: unknown;
  path: string;
}): Promise<string> {
  const resolveConfiguredSecretInputString = await importSdkExport<
    (params: {
      config: never;
      env: NodeJS.ProcessEnv;
      value: unknown;
      path: string;
      unresolvedReasonStyle: "detailed";
    }) => Promise<{ value?: string; unresolvedRefReason?: string }>
  >("openclaw/plugin-sdk/secret-input-runtime", "resolveConfiguredSecretInputString");
  if (!resolveConfiguredSecretInputString) {
    throw new Error(`${params.path} SecretRef cannot be resolved: this OpenClaw version exposes no SecretRef resolver to plugins.`);
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config as never,
    env: process.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });
  if (!resolved.value) {
    throw new Error(resolved.unresolvedRefReason ?? `${params.path} SecretRef is unresolved.`);
  }
  return resolved.value;
}

async function resolveCatalogCredentialPath(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  path: readonly string[];
}): Promise<{ matched: boolean; config: unknown }> {
  const credentialPath = params.path.join(".");
  for (const config of [params.runtimeConfig, params.sourceConfig]) {
    const configuredCredential = readConfigPath(config, params.path);
    if (isSecretRefLike(configuredCredential)) {
      const clonedConfig = cloneConfigForCredentialInjection(config);
      const resolvedValue = await resolveSecretRefValue({
        config: params.sourceConfig,
        value: configuredCredential,
        path: credentialPath,
      });
      writeConfigPath(clonedConfig, params.path, resolvedValue);
      return { matched: true, config: clonedConfig };
    }
    if (configuredCredential !== undefined) {
      return { matched: true, config };
    }
  }
  return { matched: false, config: params.runtimeConfig };
}

async function resolveCatalogDelegatedRuntimeConfig(params: {
  provider: ResolvedProvider;
  runtimeConfig: unknown;
  sourceConfig: unknown;
}): Promise<unknown> {
  const catalogProvider = KNOWN_PROVIDERS.find((entry) => entry.id === params.provider.id);
  if (!catalogProvider) {
    return params.runtimeConfig;
  }

  const pluginCredential = await resolveCatalogCredentialPath({
    runtimeConfig: params.runtimeConfig,
    sourceConfig: params.sourceConfig,
    path: ["plugins", "entries", catalogProvider.pluginId, "config", "webSearch", "apiKey"],
  });
  if (pluginCredential.matched) {
    return pluginCredential.config;
  }

  const scopedCredential = await resolveCatalogCredentialPath({
    runtimeConfig: params.runtimeConfig,
    sourceConfig: params.sourceConfig,
    path: ["tools", "web", "search", params.provider.id, "apiKey"],
  });
  return scopedCredential.config;
}

async function resolveDelegatedRuntimeConfig(params: {
  provider: ResolvedProvider;
  runtimeProviders: RuntimeWebSearchProvider[];
  runtimeConfig: unknown;
  sourceConfig: unknown;
}): Promise<unknown> {
  const runtimeProvider = params.runtimeProviders.find((entry) => entry.id === params.provider.id);
  if (!runtimeProvider) {
    return resolveCatalogDelegatedRuntimeConfig(params);
  }
  if (runtimeProvider.requiresCredential === false) {
    return params.runtimeConfig;
  }

  const configuredCredential = runtimeProvider.getConfiguredCredentialValue?.(params.runtimeConfig);
  const sourceConfiguredCredential = runtimeProvider.getConfiguredCredentialValue?.(params.sourceConfig);
  if (
    isSecretRefLike(configuredCredential) &&
    runtimeProvider.setConfiguredCredentialValue
  ) {
    const clonedConfig = cloneConfigForCredentialInjection(params.runtimeConfig);
    const resolvedValue = await resolveSecretRefValue({
      config: params.sourceConfig,
      value: configuredCredential,
      path: runtimeProvider.credentialPath ?? `plugins.entries.${params.provider.id}.config.webSearch.apiKey`,
    });
    runtimeProvider.setConfiguredCredentialValue(clonedConfig, resolvedValue);
    return clonedConfig;
  }
  if (configuredCredential !== undefined) {
    return params.runtimeConfig;
  }
  if (
    isSecretRefLike(sourceConfiguredCredential) &&
    runtimeProvider.setConfiguredCredentialValue
  ) {
    const clonedConfig = cloneConfigForCredentialInjection(params.sourceConfig);
    const resolvedValue = await resolveSecretRefValue({
      config: params.sourceConfig,
      value: sourceConfiguredCredential,
      path: runtimeProvider.credentialPath ?? `plugins.entries.${params.provider.id}.config.webSearch.apiKey`,
    });
    runtimeProvider.setConfiguredCredentialValue(clonedConfig, resolvedValue);
    return clonedConfig;
  }
  if (sourceConfiguredCredential !== undefined) {
    return params.sourceConfig;
  }

  const searchConfig = resolveSearchConfig(params.runtimeConfig);
  const searchCredential = runtimeProvider.getCredentialValue?.(searchConfig);
  const sourceSearchConfig = resolveSearchConfig(params.sourceConfig);
  const sourceSearchCredential = runtimeProvider.getCredentialValue?.(sourceSearchConfig);
  if (isSecretRefLike(searchCredential) && runtimeProvider.setCredentialValue) {
    const clonedConfig = cloneConfigForCredentialInjection(params.runtimeConfig);
    const clonedSearchConfig = resolveSearchConfig(clonedConfig);
    if (!clonedSearchConfig) {
      return params.runtimeConfig;
    }
    const resolvedValue = await resolveSecretRefValue({
      config: params.sourceConfig,
      value: searchCredential,
      path: runtimeProvider.credentialPath ?? `tools.web.search.${params.provider.id}.apiKey`,
    });
    runtimeProvider.setCredentialValue(clonedSearchConfig, resolvedValue);
    return clonedConfig;
  }
  if (searchCredential !== undefined) {
    return params.runtimeConfig;
  }
  if (isSecretRefLike(sourceSearchCredential) && runtimeProvider.setCredentialValue) {
    const clonedConfig = cloneConfigForCredentialInjection(params.sourceConfig);
    const clonedSearchConfig = resolveSearchConfig(clonedConfig);
    if (!clonedSearchConfig) {
      return params.sourceConfig;
    }
    const resolvedValue = await resolveSecretRefValue({
      config: params.sourceConfig,
      value: sourceSearchCredential,
      path: runtimeProvider.credentialPath ?? `tools.web.search.${params.provider.id}.apiKey`,
    });
    runtimeProvider.setCredentialValue(clonedSearchConfig, resolvedValue);
    return clonedConfig;
  }
  if (sourceSearchCredential !== undefined) {
    return params.sourceConfig;
  }

  return params.runtimeConfig;
}

const EVIDENCE_TABLE_COLUMNS: ReadonlyArray<FusionEvidenceTable["columns"][number]> = [
  {
    key: "rank",
    label: "Rank",
    description: "Merged ordering position after dedupe and score computation.",
  },
  {
    key: "title",
    label: "Title",
    description: "Best available title for the merged URL.",
  },
  {
    key: "url",
    label: "URL",
    description: "Display URL for the merged hit.",
  },
  {
    key: "providers",
    label: "Providers",
    description: "Provider ids that independently surfaced this URL.",
  },
  {
    key: "providerCount",
    label: "Provider Count",
    description: "How many providers corroborated this URL.",
  },
  {
    key: "bestRank",
    label: "Best Rank",
    description: "Best raw rank observed across providers.",
  },
  {
    key: "score",
    label: "Merged Score",
    description: "Final broker score used for merged ordering.",
  },
  {
    key: "answerCitationCount",
    label: "Answer Citations",
    description: "How many answer-style provider citations referenced this URL.",
  },
  {
    key: "flags",
    label: "Flags",
    description: "Deterministic flags inferred during normalization and merge.",
  },
];

type ResolvedRetryConfig = {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
};

type ResolvedProviderConfig = {
  count: number;
  timeoutMs: number;
  retry: ResolvedRetryConfig;
  weight: number;
  scoreCalibration: SearchFusionProviderConfig["scoreCalibration"];
};

type ProviderCooldown = {
  untilMs: number;
  source: string;
};

class DeadlineExceededError extends Error {
  override name = "DeadlineExceededError";

  constructor() {
    super("deadline exceeded");
  }
}

class ProviderTimeoutError extends Error {
  override name = "ProviderTimeoutError";

  constructor(providerId: string, timeoutMs: number) {
    super(`Provider ${providerId} timed out after ${timeoutMs}ms`);
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "Search aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort(createAbortError(source.reason));
  if (source.aborted) {
    abort();
    return () => {};
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type ProviderRunTaskRejection = {
  error: unknown;
  tookMs: number;
};

function asConfig(pluginConfig: unknown): SearchFusionConfig {
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as SearchFusionConfig)
    : {};
}

function resolveMergeDedupeOptions(config: SearchFusionConfig): MergeDedupeOptions {
  return {
    enabled: config.fuzzyDedupe !== false,
    trackingParams: config.trackingParams,
    trackingParamMode: config.trackingParamMode,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveProviderNativeMaxResults(providerId: string): number {
  return (
    PROVIDER_RESULT_COUNT_CONTRACTS[providerId.toLowerCase()]?.maxResults ??
    DEFAULT_GENERIC_PROVIDER_MAX_RESULTS
  );
}

function resolveProviderDefaultResultCount(providerId: string): number {
  return (
    PROVIDER_RESULT_COUNT_CONTRACTS[providerId.toLowerCase()]?.maxResults ??
    DEFAULT_UNKNOWN_PROVIDER_COUNT
  );
}

function resolveResultCount(value: unknown, fallback: number, max: number): number {
  const finiteValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(Math.floor(finiteValue), 1, max);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function applyProviderWeight(score: number, weight: number): number {
  return Math.max(0, roundScore(score * weight));
}

function resolveProviderConfig(
  config: SearchFusionConfig,
  providerId: string,
): SearchFusionProviderConfig {
  return config.providerConfig?.[providerId] ?? {};
}

function resolveRetryConfig(config: SearchFusionConfig, providerId: string): ResolvedRetryConfig {
  const globalRetry = config.retry ?? {};
  const legacyProviderRetry = config.providerRetries?.[providerId] ?? {};
  const providerRetry = resolveProviderConfig(config, providerId).retry ?? {};
  const merged: SearchFusionRetryConfig = {
    ...globalRetry,
    ...legacyProviderRetry,
    ...providerRetry,
  };

  return {
    maxAttempts: clamp(merged.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS, 1, 10),
    backoffMs: clamp(merged.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS, 0, 30000),
    backoffMultiplier: clamp(merged.backoffMultiplier ?? DEFAULT_RETRY_BACKOFF_MULTIPLIER, 1, 10),
    maxBackoffMs: clamp(merged.maxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS, 0, 120000),
  };
}

function resolveRuntimeProviderConfig(
  request: ProviderSelectionRequest,
  config: SearchFusionConfig,
  providerId: string,
): ResolvedProviderConfig {
  const providerConfig = resolveProviderConfig(config, providerId);
  const nativeMaxResults = resolveProviderNativeMaxResults(providerId);
  const maxResults = resolveResultCount(
    providerConfig.maxResults,
    nativeMaxResults,
    nativeMaxResults,
  );
  const defaultCount =
    providerConfig.maxResults === undefined
      ? Math.min(resolveProviderDefaultResultCount(providerId), maxResults)
      : maxResults;

  return {
    count: resolveResultCount(
      request.count ?? providerConfig.count ?? config.countPerProvider,
      defaultCount,
      maxResults,
    ),
    timeoutMs: clamp(
      providerConfig.timeoutMs ?? config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      1000,
      120000,
    ),
    retry: resolveRetryConfig(config, providerId),
    weight: clamp(providerConfig.weight ?? DEFAULT_PROVIDER_WEIGHT, MIN_PROVIDER_WEIGHT, MAX_PROVIDER_WEIGHT),
    scoreCalibration: providerConfig.scoreCalibration,
  };
}

function buildProviderArgs(
  request: ProviderSelectionRequest,
  config: SearchFusionConfig,
  providerId: string,
): Record<string, unknown> {
  const providerConfig = resolveRuntimeProviderConfig(request, config, providerId);

  return {
    query: request.query,
    count: providerConfig.count,
    country: request.country,
    language: request.language,
    freshness: request.freshness,
    date_after: request.date_after,
    date_before: request.date_before,
    search_lang: request.search_lang,
    ui_lang: request.ui_lang,
  };
}

async function runProviderAttempt<T>(params: {
  providerId: string;
  timeoutMs: number;
  parentSignal: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const removeParentRelay = relayAbort(params.parentSignal, controller);
  const timer = setTimeout(
    () => controller.abort(new ProviderTimeoutError(params.providerId, params.timeoutMs)),
    params.timeoutMs,
  );
  try {
    throwIfAborted(controller.signal);
    return await raceWithSignal(params.execute(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    removeParentRelay();
  }
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }

  try {
    const rendered = String(error);
    if (rendered.length > 0 && rendered !== "[object Object]") {
      return rendered;
    }
  } catch {
    // Ignore stringify errors and fall back to a generic message.
  }

  return "Unknown error";
}

function asHttpStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

function extractHttpFailureDetails(error: unknown): {
  status?: number;
  headers: unknown[];
} {
  const queue: unknown[] = [error];
  const visited = new Set<object>();
  const headers: unknown[] = [];
  let status: number | undefined;

  while (queue.length > 0 && visited.size < 12) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);

    const record = candidate as Record<string, unknown>;
    status ??=
      asHttpStatus(record.status) ??
      asHttpStatus(record.statusCode) ??
      asHttpStatus(record.httpStatus);
    if (record.headers !== undefined) {
      headers.push(record.headers);
    }
    for (const key of ["response", "cause", "error"]) {
      if (record[key] && typeof record[key] === "object") {
        queue.push(record[key]);
      }
    }
  }

  if (status === undefined) {
    const match = asErrorMessage(error).match(/(?:^|\D)(429|503)(?:\D|$)/);
    status = match ? Number(match[1]) : undefined;
  }

  return { status, headers };
}

function asHeaderStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => asHeaderStrings(entry));
  }
  if (typeof value === "string" || typeof value === "number") {
    return [String(value).trim()].filter(Boolean);
  }
  return [];
}

function readHeaderValues(headers: unknown, name: string): string[] {
  if (!headers || typeof headers !== "object") {
    return [];
  }

  const values: string[] = [];
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    try {
      values.push(...asHeaderStrings(getter.call(headers, name)));
    } catch {
      // Fall through to plain-object lookup.
    }
  }

  const plainHeaders = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(plainHeaders)) {
    if (key.toLowerCase() === name) {
      values.push(...asHeaderStrings(value));
    }
  }

  return [...new Set(values)];
}

function parseNumericHeader(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return undefined;
  }
  return Number(normalized);
}

function clampRateLimitDelay(delayMs: number): number | undefined {
  if (Number.isNaN(delayMs)) {
    return undefined;
  }
  if (delayMs <= 0) return 0;
  if (delayMs >= MAX_RATE_LIMIT_WAIT_MS) return MAX_RATE_LIMIT_WAIT_MS;
  return clamp(Math.ceil(delayMs), 0, MAX_RATE_LIMIT_WAIT_MS);
}

const HTTP_DATE_SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const HTTP_DATE_LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const HTTP_DATE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function buildHttpDate(params: {
  weekday: string;
  day: string;
  month: string;
  year: number;
  hour: string;
  minute: string;
  second: string;
}): number | undefined {
  const weekday = [...HTTP_DATE_SHORT_WEEKDAYS, ...HTTP_DATE_LONG_WEEKDAYS].indexOf(
    params.weekday as (typeof HTTP_DATE_SHORT_WEEKDAYS)[number],
  );
  const weekdayIndex =
    weekday >= HTTP_DATE_SHORT_WEEKDAYS.length ? weekday - HTTP_DATE_SHORT_WEEKDAYS.length : weekday;
  const monthIndex = HTTP_DATE_MONTHS.indexOf(
    params.month as (typeof HTTP_DATE_MONTHS)[number],
  );
  const day = Number(params.day);
  const hour = Number(params.hour);
  const minute = Number(params.minute);
  const second = Number(params.second);
  if (
    weekdayIndex < 0 ||
    monthIndex < 0 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  const dateMs = Date.UTC(params.year, monthIndex, day, hour, minute, second);
  const date = new Date(dateMs);
  if (
    date.getUTCFullYear() !== params.year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== weekdayIndex
  ) {
    return undefined;
  }
  return dateMs;
}

function parseHttpDate(value: string, nowMs: number): number | undefined {
  const normalized = value.trim();
  const imfFixdate =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      normalized,
    );
  if (imfFixdate) {
    return buildHttpDate({
      weekday: imfFixdate[1],
      day: imfFixdate[2],
      month: imfFixdate[3],
      year: Number(imfFixdate[4]),
      hour: imfFixdate[5],
      minute: imfFixdate[6],
      second: imfFixdate[7],
    });
  }

  const rfc850Date =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      normalized,
    );
  if (rfc850Date) {
    const currentYear = new Date(nowMs).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850Date[4]);
    if (year - currentYear > 50) year -= 100;
    return buildHttpDate({
      weekday: rfc850Date[1],
      day: rfc850Date[2],
      month: rfc850Date[3],
      year,
      hour: rfc850Date[5],
      minute: rfc850Date[6],
      second: rfc850Date[7],
    });
  }

  const asctimeDate =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      normalized,
    );
  if (!asctimeDate) return undefined;
  return buildHttpDate({
    weekday: asctimeDate[1],
    day: asctimeDate[3].trim(),
    month: asctimeDate[2],
    year: Number(asctimeDate[7]),
    hour: asctimeDate[4],
    minute: asctimeDate[5],
    second: asctimeDate[6],
  });
}

function parseRetryAfter(value: string, nowMs: number): number | undefined {
  const deltaSeconds = parseNumericHeader(value);
  if (deltaSeconds !== undefined) {
    return clampRateLimitDelay(deltaSeconds * 1000);
  }

  const dateMs = parseHttpDate(value, nowMs);
  return dateMs === undefined ? undefined : clampRateLimitDelay(dateMs - nowMs);
}

function parseResetSeconds(value: string, nowMs: number): number | undefined {
  const numeric = parseNumericHeader(value);
  if (numeric === undefined) {
    const dateMs = parseHttpDate(value, nowMs);
    return dateMs === undefined ? undefined : clampRateLimitDelay(dateMs - nowMs);
  }
  if (numeric >= 1_000_000_000_000) {
    return clampRateLimitDelay(numeric - nowMs);
  }
  if (numeric >= 1_000_000_000) {
    return clampRateLimitDelay(numeric * 1000 - nowMs);
  }
  return clampRateLimitDelay(numeric * 1000);
}

function parseResetMilliseconds(value: string, nowMs: number): number | undefined {
  const numeric = parseNumericHeader(value);
  if (numeric === undefined) {
    return undefined;
  }
  return clampRateLimitDelay(
    numeric >= 1_000_000_000_000 ? numeric - nowMs : numeric,
  );
}

function parseDurationHeader(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const matcher = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  let totalMs = 0;
  let consumed = "";
  for (const match of normalized.matchAll(matcher)) {
    totalMs += Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
    consumed += match[0];
  }
  if (!consumed || consumed !== normalized.replace(/\s+/g, "")) {
    return undefined;
  }
  return clampRateLimitDelay(totalMs);
}

type RateLimitHeader = {
  delayMs?: number;
  hadHeader: boolean;
  source?: string;
};

function extractRateLimitHeader(error: unknown, nowMs: number): {
  status?: number;
  header: RateLimitHeader;
} {
  const details = extractHttpFailureDetails(error);
  if (details.status !== 429 && details.status !== 503) {
    return { status: details.status, header: { hadHeader: false } };
  }

  const specifications: Array<{
    names: string[];
    parse: (value: string) => number | undefined;
  }> = [
    {
      names: ["retry-after"],
      parse: (value) => parseRetryAfter(value, nowMs),
    },
    {
      names: [
        "retry-after-ms",
        "x-retry-after-ms",
        "x-ms-retry-after-ms",
        "x-ratelimit-reset-ms",
        "x-rate-limit-reset-ms",
        "ratelimit-reset-ms",
      ],
      parse: (value) => parseResetMilliseconds(value, nowMs),
    },
    {
      names: [
        "x-ratelimit-reset",
        "x-rate-limit-reset",
        "ratelimit-reset",
        "x-ratelimit-reset-after",
        "x-rate-limit-reset-after",
        "ratelimit-reset-after",
      ],
      parse: (value) => parseResetSeconds(value, nowMs),
    },
    {
      names: [
        "x-ratelimit-reset-requests",
        "x-rate-limit-reset-requests",
        "x-ratelimit-reset-tokens",
        "x-rate-limit-reset-tokens",
      ],
      parse: parseDurationHeader,
    },
  ];
  const parsed: Array<{ delayMs: number; source: string }> = [];
  let hadHeader = false;

  for (const specification of specifications) {
    for (const name of specification.names) {
      for (const headers of details.headers) {
        const values = readHeaderValues(headers, name);
        hadHeader ||= values.length > 0;
        for (const value of values) {
          const delayMs = specification.parse(value);
          if (delayMs !== undefined) {
            parsed.push({ delayMs, source: name });
          }
        }
      }
    }
  }

  const longest = parsed.sort((a, b) => b.delayMs - a.delayMs)[0];
  return {
    status: details.status,
    header: {
      delayMs: longest?.delayMs,
      hadHeader,
      source: longest?.source,
    },
  };
}

function isProviderRunTaskRejection(value: unknown): value is ProviderRunTaskRejection {
  return (
    value !== null &&
    typeof value === "object" &&
    "tookMs" in value &&
    typeof (value as { tookMs?: unknown }).tookMs === "number" &&
    "error" in value
  );
}

function asUnhandledProviderFailure(params: {
  provider: ResolvedProvider;
  tookMs: number;
  error: unknown;
}): ProviderRunResult {
  return {
    providerId: params.provider.id,
    label: params.provider.label,
    configured: params.provider.configured,
    ok: false,
    tookMs: Math.max(0, params.tookMs),
    rawCount: 0,
    attempts: 1,
    results: [],
    discardedResults: [],
    retryHistory: [],
    error: asErrorMessage(params.error),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DeadlineExceededError ||
    error instanceof ProviderTimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function shouldRetry(error: unknown, errorMessage: string): boolean {
  if (isAbortError(error)) return false;
  if (isHardProviderFailure(errorMessage)) return false;
  const nonRetriablePatterns = [
    /401\b/,
    /403\b/,
    /400\b/,
    /404\b/,
    /409\b/,
    /422\b/,
    /unauthorized/i,
    /forbidden/i,
    /invalid api key/i,
    /api key/i,
    /credential/i,
    /unknown provider/i,
    /unsupported/i,
    /bad request/i,
    /not found/i,
  ];

  return !nonRetriablePatterns.some((pattern) => pattern.test(errorMessage));
}

function computeBackoffDelay(policy: ResolvedRetryConfig, attempt: number): number {
  if (policy.backoffMs <= 0) return 0;
  return Math.min(
    policy.maxBackoffMs,
    Math.round(policy.backoffMs * Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1))),
  );
}

function resolveRetryTiming(
  policy: ResolvedRetryConfig,
  attempt: number,
  error: unknown,
  errorMessage: string,
  nowMs: number,
): {
  delayMs: number;
  rateLimited: boolean;
  overridesMessageHeuristics: boolean;
  source?: string;
} {
  const configured = computeBackoffDelay(policy, attempt);
  const { status, header } = extractRateLimitHeader(error, nowMs);
  const explicitRateLimit = status === 429 || /429|rate limit/i.test(errorMessage);
  const rateLimited = explicitRateLimit || (status === 503 && header.hadHeader);
  const overridesMessageHeuristics =
    explicitRateLimit || (status === 503 && header.delayMs !== undefined);

  if (header.delayMs !== undefined) {
    return {
      delayMs: Math.max(configured, header.delayMs),
      rateLimited,
      overridesMessageHeuristics,
      source: header.source,
    };
  }

  return {
    delayMs: explicitRateLimit
      ? Math.max(DEFAULT_RATE_LIMIT_BACKOFF_MS, configured)
      : configured,
    rateLimited,
    overridesMessageHeuristics,
  };
}

function mergeFlags(...flagLists: Array<readonly SearchResultFlag[]>): SearchResultFlag[] {
  return [...new Set(flagLists.flatMap((flags) => [...flags]))].sort();
}

type MergeCandidate = Omit<FusionMergedResult, "score" | "ranking"> & {
  providerPriority: number;
  priorityProvider: string;
  insertionIndex: number;
};

type ScoredMergeCandidate = MergeCandidate & {
  score: number;
  scoreBreakdown: FusionScoreBreakdown;
};

type MergeDedupeOptions = FuzzyUrlOptions & {
  enabled: boolean;
};

type IndexedMergeResult = {
  item: NormalizedSearchResult;
  fuzzyUrl: FuzzyUrlAnalysis;
};

function mergedFlagPenalty(flags: readonly SearchResultFlag[]): number {
  let penalty = 0;
  if (flags.includes("sponsored")) penalty += 0.65;
  if (flags.includes("redirect-wrapper")) penalty += 0.1;
  if (flags.includes("community")) penalty += 0.08;
  if (flags.includes("video")) penalty += 0.08;
  if (flags.includes("tracking-stripped")) penalty += 0.02;
  return penalty;
}

function mergedSortOrder(): string[] {
  return [...MERGED_SORT_ORDER];
}

function computeRrfScore(entry: MergeCandidate, ranking: RankingOptions): number {
  const bestRankByProvider = new Map<string, number>();
  for (const variant of entry.variants) {
    const current = bestRankByProvider.get(variant.providerId);
    if (current === undefined || variant.rawRank < current) {
      bestRankByProvider.set(variant.providerId, variant.rawRank);
    }
  }
  let sum = 0;
  for (const [providerId, rank] of bestRankByProvider) {
    sum += (ranking.weights.get(providerId) ?? DEFAULT_PROVIDER_WEIGHT) / (ranking.rrfK + Math.max(1, rank));
  }
  return roundScore(sum * (ranking.rrfK + 1));
}

function computeMergedScoreBreakdown(
  entry: MergeCandidate,
  sourceTierMode: SourceTierMode,
  ranking: RankingOptions = DEFAULT_RANKING_OPTIONS,
): FusionScoreBreakdown {
  const bestVariantScore = entry.variants.reduce((max, variant) => Math.max(max, variant.score), 0);
  if (ranking.strategy === RRF_RANKING_STRATEGY) {
    const rrfScore = computeRrfScore(entry, ranking);
    const tierAdjustment = sourceTierMergedAdjustment(entry.bestSourceTier, sourceTierMode);
    const flagPenalty = mergedFlagPenalty(entry.flags);
    return {
      bestVariantScore,
      corroborationBonus: 0,
      bestRankBonus: 0,
      tierAdjustment,
      flagPenalty,
      rrfScore,
      finalScore: Math.max(0.01, rrfScore + tierAdjustment - flagPenalty),
    };
  }
  const corroborationBonus = Math.max(0, entry.providerCount - 1) * 0.12;
  // Rank is an explicit tie-breaker after provider priority. Folding it into
  // the score would silently make rank take precedence over provider priority.
  const bestRankBonus = 0;
  const tierAdjustment = sourceTierMergedAdjustment(entry.bestSourceTier, sourceTierMode);
  const flagPenalty = mergedFlagPenalty(entry.flags);

  return {
    bestVariantScore,
    corroborationBonus,
    bestRankBonus,
    tierAdjustment,
    flagPenalty,
    finalScore: Math.max(0.01, bestVariantScore + corroborationBonus + bestRankBonus + tierAdjustment - flagPenalty),
  };
}

function compareMergedCandidates(
  a: ScoredMergeCandidate,
  b: ScoredMergeCandidate,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.providerPriority !== b.providerPriority) {
    return a.providerPriority - b.providerPriority;
  }
  if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
  return a.insertionIndex - b.insertionIndex;
}

function buildRankingExplanation(params: {
  strategy: FusionRankingStrategy;
  rank: number;
  title: string;
  bestRank: number;
  bestSourceTier: FusionMergedResult["bestSourceTier"];
  providerCount: number;
  providerPriority: number;
  priorityProvider: string;
  scoreBreakdown: FusionScoreBreakdown;
}): FusionMergedResult["ranking"] {
  return {
    strategy: params.strategy,
    rank: params.rank,
    scoreBreakdown: params.scoreBreakdown,
    tieBreakers: {
      providerPriority: params.providerPriority,
      priorityProvider: params.priorityProvider,
      bestSourceTier: params.bestSourceTier,
      bestRank: params.bestRank,
      providerCount: params.providerCount,
      title: params.title,
    },
  };
}

function emptyRankingMeta(
  strategy: FusionRankingStrategy = MERGED_RANKING_STRATEGY,
): FusionRankingMeta {
  return {
    strategy,
    sortOrder: mergedSortOrder(),
    consideredCount: 0,
    returnedCount: 0,
    droppedCount: 0,
    dropped: [],
  };
}

function compareRepresentativeResults(
  a: NormalizedSearchResult,
  b: NormalizedSearchResult,
  sourceTierMode: SourceTierMode,
): number {
  if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
  if (b.score !== a.score) return b.score - a.score;
  if (sourceTierMode !== "off") {
    const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
    if (tierDelta !== 0) return tierDelta;
  }
  const providerDelta = a.providerId.localeCompare(b.providerId);
  if (providerDelta !== 0) return providerDelta;
  return a.originalUrl.localeCompare(b.originalUrl);
}

function pickBestSnippet(
  items: readonly NormalizedSearchResult[],
): Pick<MergeCandidate, "snippet" | "truncated"> {
  const withSnippets = items.filter(
    (item): item is NormalizedSearchResult & { snippet: string } =>
      typeof item.snippet === "string" && item.snippet.trim().length > 0,
  );
  if (withSnippets.length === 0) {
    return {};
  }

  const informative = withSnippets.filter((item) => normalizeTitle(item.snippet).length > 0);
  const candidates = informative.length > 0 ? informative : withSnippets;
  const best = candidates.reduce((current, item) =>
    item.snippet.length > current.snippet.length ? item : current,
  );
  return {
    snippet: best.snippet,
    ...(best.truncated ? { truncated: true as const } : {}),
  };
}

function buildMergeGroups(
  results: ProviderRunResult[],
  dedupe: MergeDedupeOptions,
): IndexedMergeResult[][] {
  const indexed = results.flatMap((provider) =>
    provider.results.map((item) => ({
      item,
      fuzzyUrl: dedupe.enabled
        ? analyzeFuzzyUrl(item.originalUrl, dedupe)
        : {
            canonicalUrl: item.canonicalUrl,
            meaningfulQuery: "",
          },
    })),
  );
  const parent = indexed.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  const byCanonicalUrl = new Map<string, number>();
  indexed.forEach((entry, index) => {
    const prior = byCanonicalUrl.get(entry.fuzzyUrl.canonicalUrl);
    if (prior === undefined) {
      byCanonicalUrl.set(entry.fuzzyUrl.canonicalUrl, index);
    } else {
      union(prior, index);
    }
  });

  if (dedupe.enabled) {
    const byTitleHostAndQuery = new Map<string, number>();
    indexed.forEach((entry, index) => {
      const title = normalizeTitle(entry.item.title);
      if (
        !entry.fuzzyUrl.host ||
        !entry.fuzzyUrl.canonicalUrl.startsWith("https://") ||
        !title
      ) {
        return;
      }
      const titleKey = [
        entry.fuzzyUrl.host,
        entry.fuzzyUrl.meaningfulQuery,
        title,
      ].join("\u0000");
      const prior = byTitleHostAndQuery.get(titleKey);
      if (prior === undefined) {
        byTitleHostAndQuery.set(titleKey, index);
      } else {
        union(prior, index);
      }
    });
  }

  const groups = new Map<number, IndexedMergeResult[]>();
  indexed.forEach((entry, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) {
      group.push(entry);
    } else {
      groups.set(root, [entry]);
    }
  });
  return [...groups.values()];
}

function mergeResults(
  results: ProviderRunResult[],
  maxMergedResults: number,
  sourceTierMode: SourceTierMode,
  dedupe: MergeDedupeOptions,
  providerOrder: readonly string[] = results.map((provider) => provider.providerId),
  ranking: RankingOptions = DEFAULT_RANKING_OPTIONS,
): { results: FusionMergedResult[]; ranking: FusionRankingMeta } {
  const providerPriorities = new Map(
    providerOrder.map((providerId, index) => [providerId, index] as const),
  );
  const mergeCandidates = buildMergeGroups(results, dedupe).map(
    (group, groupIndex): MergeCandidate => {
      const representative = [...group].sort((a, b) =>
        compareRepresentativeResults(a.item, b.item, sourceTierMode),
      )[0];
      const items = group.map((entry) => entry.item);
      const providers = [...new Set(items.map((item) => item.providerId))];
      const flags = mergeFlags(...items.map((item) => item.flags));
      const bestSourceTier = items.reduce(
        (best, item) => pickHigherSourceTier(best, item.sourceTier),
        representative.item.sourceTier,
      );
      const priority = items.reduce(
        (best, item) => {
          const itemPriority =
            providerPriorities.get(item.providerId) ?? Number.MAX_SAFE_INTEGER;
          return itemPriority < best.providerPriority
            ? { providerPriority: itemPriority, priorityProvider: item.providerId }
            : best;
        },
        {
          providerPriority: Number.MAX_SAFE_INTEGER,
          priorityProvider: representative.item.providerId,
        },
      );

      return {
        title: representative.item.title,
        url: representative.item.url,
        canonicalUrl: representative.fuzzyUrl.canonicalUrl,
        ...pickBestSnippet(items),
        siteName: representative.item.siteName ?? items.find((item) => item.siteName)?.siteName,
        providers,
        providerCount: providers.length,
        bestRank: Math.min(...items.map((item) => item.rawRank)),
        bestSourceTier,
        flags,
        rankings: items.map((item) => ({
          providerId: item.providerId,
          rawRank: item.rawRank,
          score: item.score,
          nativeScore: item.nativeScore,
          sourceType: item.sourceType,
          sourceTier: item.sourceTier,
          flags: [...item.flags],
        })),
        variants: items,
        providerPriority: priority.providerPriority,
        priorityProvider: priority.priorityProvider,
        insertionIndex: groupIndex,
      };
    },
  );

  const rankedCandidates: ScoredMergeCandidate[] = mergeCandidates
    .map((entry) => {
      const normalized: MergeCandidate = {
        ...entry,
        providers: [...entry.providers].sort(),
        providerCount: entry.providers.length,
        flags: [...entry.flags].sort(),
        rankings: [...entry.rankings].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          if (sourceTierMode !== "off") {
            const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
            if (tierDelta !== 0) return tierDelta;
          }
          return a.providerId.localeCompare(b.providerId);
        }),
        variants: [...entry.variants].sort((a, b) => {
          if (a.rawRank !== b.rawRank) return a.rawRank - b.rawRank;
          if (b.score !== a.score) return b.score - a.score;
          if (sourceTierMode !== "off") {
            const tierDelta = compareSourceTierDesc(a.sourceTier, b.sourceTier);
            if (tierDelta !== 0) return tierDelta;
          }
          return a.providerId.localeCompare(b.providerId);
        }),
      };
      const scoreBreakdown = computeMergedScoreBreakdown(normalized, sourceTierMode, ranking);

      return {
        ...normalized,
        score: scoreBreakdown.finalScore,
        scoreBreakdown,
      };
    })
    .sort(compareMergedCandidates);

  const mergedResults: FusionMergedResult[] = rankedCandidates
    .slice(0, maxMergedResults)
    .map((entry, index) => {
      const {
        scoreBreakdown,
        providerPriority,
        priorityProvider,
        insertionIndex: _insertionIndex,
        ...base
      } = entry;
      void _insertionIndex;
      return {
        ...base,
        ranking: buildRankingExplanation({
          strategy: ranking.strategy,
          rank: index + 1,
          title: base.title,
          bestRank: base.bestRank,
          bestSourceTier: base.bestSourceTier,
          providerCount: base.providerCount,
          providerPriority,
          priorityProvider,
          scoreBreakdown,
        }),
      };
    });

  const dropped = rankedCandidates.slice(maxMergedResults).map((entry, index) => ({
    rank: maxMergedResults + index + 1,
    reason: "maxMergedResults" as const,
    title: entry.title,
    url: entry.url,
    canonicalUrl: entry.canonicalUrl,
    score: entry.score,
    bestRank: entry.bestRank,
    providerCount: entry.providerCount,
  }));

  return {
    results: mergedResults,
    ranking:
      rankedCandidates.length === 0
        ? emptyRankingMeta(ranking.strategy)
        : {
            strategy: ranking.strategy,
            sortOrder: mergedSortOrder(),
            consideredCount: rankedCandidates.length,
            returnedCount: mergedResults.length,
            droppedCount: dropped.length,
            dropped,
          },
  };
}

type CitationSupportStats = {
  count: number;
  providers: Set<string>;
};

function buildEvidenceTable(
  results: FusionMergedResult[],
  answers: ProviderAnswerDigest[],
  dedupe: MergeDedupeOptions,
): FusionEvidenceTable {
  const citationSupportByUrl = new Map<string, CitationSupportStats>();
  const mergedUrlByVariantUrl = new Map<string, string>();

  for (const result of results) {
    mergedUrlByVariantUrl.set(result.canonicalUrl, result.canonicalUrl);
    for (const variant of result.variants) {
      const variantUrl = dedupe.enabled
        ? analyzeFuzzyUrl(variant.originalUrl, dedupe).canonicalUrl
        : variant.canonicalUrl;
      mergedUrlByVariantUrl.set(variantUrl, result.canonicalUrl);
    }
  }

  for (const answer of answers) {
    for (const citationUrl of answer.citations) {
      const citationVariantUrl = dedupe.enabled
        ? analyzeFuzzyUrl(citationUrl, dedupe).canonicalUrl
        : canonicalizeUrl(citationUrl);
      const canonicalCitationUrl =
        mergedUrlByVariantUrl.get(citationVariantUrl) ?? citationVariantUrl;
      if (!canonicalCitationUrl) {
        continue;
      }

      const existing = citationSupportByUrl.get(canonicalCitationUrl);
      if (existing) {
        existing.count += 1;
        existing.providers.add(answer.providerId);
        continue;
      }

      citationSupportByUrl.set(canonicalCitationUrl, {
        count: 1,
        providers: new Set([answer.providerId]),
      });
    }
  }

  const rows: FusionEvidenceRow[] = results.map((result, index) => {
    const citationSupport = citationSupportByUrl.get(result.canonicalUrl);
    const citationProviders = citationSupport ? [...citationSupport.providers].sort() : [];

    return {
      rowId: result.canonicalUrl,
      rank: index + 1,
      title: result.title,
      url: result.url,
      canonicalUrl: result.canonicalUrl,
      siteName: result.siteName,
      snippet: result.snippet,
      truncated: result.truncated,
      providers: [...result.providers],
      providerCount: result.providerCount,
      bestRank: result.bestRank,
      score: result.score,
      flags: [...result.flags],
      answerCitationSupport: {
        count: citationSupport?.count ?? 0,
        providerCount: citationProviders.length,
        providers: citationProviders,
      },
      providerEvidence: result.variants.map((variant) => ({
        providerId: variant.providerId,
        rawRank: variant.rawRank,
        score: variant.score,
        nativeScore: variant.nativeScore,
        sourceType: variant.sourceType,
        snippet: variant.snippet,
        truncated: variant.truncated,
        snippetSource: variant.snippetSource,
        flags: [...variant.flags],
      })),
    } satisfies FusionEvidenceRow;
  });

  return {
    version: 1,
    columns: EVIDENCE_TABLE_COLUMNS.map((column) => ({ ...column })),
    rowCount: rows.length,
    rows,
  };
}

async function runProvider(params: {
  runtime: SearchRuntime;
  config: unknown;
  brokerConfig: SearchFusionConfig;
  request: ProviderSelectionRequest;
  provider: ResolvedProvider;
  sourceTierMode: SourceTierMode;
  maxSnippetLength: number;
  urlOptions?: FuzzyUrlOptions;
  signal: AbortSignal;
  deadlineAt: number;
  cooldowns: Map<string, ProviderCooldown>;
  agentDir?: string;
  runtimeMetadata?: unknown;
}): Promise<ProviderRunResult> {
  const start = Date.now();
  const providerConfig = resolveRuntimeProviderConfig(
    params.request,
    params.brokerConfig,
    params.provider.id,
  );
  validateScoreCalibrationConfig(providerConfig.scoreCalibration);
  const retryPolicy = providerConfig.retry;
  const providerArgs = buildProviderArgs(params.request, params.brokerConfig, params.provider.id);
  const retryHistory: ProviderRunResult["retryHistory"] = [];
  let lastError: string | undefined;
  let lastRawPayload: Record<string, unknown> | undefined;
  let attempts = 0;

  const failure = (error: string): ProviderRunResult => ({
    providerId: params.provider.id,
    label: params.provider.label,
    configured: params.provider.configured,
    ok: false,
    tookMs: Date.now() - start,
    rawCount: 0,
    attempts: Math.max(1, attempts),
    rawPayload: lastRawPayload,
    results: [],
    discardedResults: [],
    retryHistory,
    error,
  });

  while (attempts < retryPolicy.maxAttempts) {
    if (Date.now() >= params.deadlineAt) {
      return failure("deadline exceeded");
    }
    if (params.signal.aborted) {
      return failure(
        params.signal.reason instanceof DeadlineExceededError
          ? "deadline exceeded"
          : asErrorMessage(createAbortError(params.signal.reason)),
      );
    }

    const cooldown = params.cooldowns.get(params.provider.id);
    const cooldownRemainingMs = cooldown ? cooldown.untilMs - Date.now() : 0;
    if (cooldown && cooldownRemainingMs <= 0) {
      params.cooldowns.delete(params.provider.id);
    } else if (cooldown && cooldownRemainingMs > 0) {
      const remainingBudgetMs = Math.max(0, params.deadlineAt - Date.now());
      if (cooldownRemainingMs >= remainingBudgetMs) {
        return failure(
          `Rate-limit wait of ${cooldownRemainingMs}ms from ${cooldown.source} exceeds the remaining total timeout budget of ${remainingBudgetMs}ms.`,
        );
      }
      try {
        await sleep(cooldownRemainingMs, params.signal);
      } catch (sleepError) {
        return failure(
          params.signal.reason instanceof DeadlineExceededError
            ? "deadline exceeded"
            : asErrorMessage(sleepError),
        );
      }
      continue;
    }

    attempts += 1;
    const attempt = attempts;
    try {
      const remainingMs = Math.max(1, params.deadlineAt - Date.now());
      const attemptTimeoutMs = Math.min(providerConfig.timeoutMs, remainingMs);
      const response: { provider: string; result: Record<string, unknown> } =
        await runProviderAttempt({
          providerId: params.provider.id,
          timeoutMs: attemptTimeoutMs,
          parentSignal: params.signal,
          execute: async (signal) =>
            await params.runtime.webSearch.search({
              config: params.config,
              providerId: params.provider.id,
              args: providerArgs,
              signal,
              agentDir: params.agentDir,
              runtimeWebSearch: params.runtimeMetadata,
            }),
        });

      lastRawPayload = response.result;
      const normalized = normalizeProviderPayload({
        providerId: params.provider.id,
        payload: response.result,
        sourceTierMode: params.sourceTierMode,
        maxSnippetLength: params.maxSnippetLength,
        urlOptions: params.urlOptions,
        query: params.request.query,
      });

      if (normalized.error) {
        const providerError = new Error(normalized.error) as Error & { response?: unknown };
        providerError.response = response.result;
        throw providerError;
      }

      const calibrated = calibrateProviderScores(
        normalized.results,
        providerConfig.scoreCalibration,
      );
      const weightedResults = normalized.results.map((result, index) => ({
        ...result,
        score: applyProviderWeight(
          applySearchResultQuality({
            relevanceScore: calibrated.scores[index] ?? 0,
            sourceType: result.sourceType,
            sourceTier: result.sourceTier,
            flags: result.flags,
            sourceTierMode: params.sourceTierMode,
            normalizeHighTier: true,
          }),
          providerConfig.weight,
        ),
      }));

      return {
        providerId: params.provider.id,
        label: params.provider.label,
        configured: params.provider.configured,
        ok: true,
        tookMs: Date.now() - start,
        rawCount: normalized.results.length + normalized.discardedResults.length,
        attempts,
        rawPayload: response.result,
        results: weightedResults,
        discardedResults: normalized.discardedResults,
        answer: normalized.answer,
        retryHistory,
      };
    } catch (error) {
      const deadlineExceeded =
        error instanceof DeadlineExceededError ||
        params.signal.reason instanceof DeadlineExceededError ||
        Date.now() >= params.deadlineAt;
      lastError = deadlineExceeded ? "deadline exceeded" : asErrorMessage(error);
      const retryStartedAt = Date.now();
      const retryTiming = resolveRetryTiming(
        retryPolicy,
        attempt,
        error,
        lastError,
        retryStartedAt,
      );
      const canRetry =
        !params.signal.aborted &&
        !deadlineExceeded &&
        attempt < retryPolicy.maxAttempts &&
        (retryTiming.overridesMessageHeuristics || shouldRetry(error, lastError));
      if (retryTiming.rateLimited && retryTiming.delayMs > 0) {
        const nextCooldown: ProviderCooldown = {
          untilMs: retryStartedAt + retryTiming.delayMs,
          source: retryTiming.source ?? "rate-limit response",
        };
        const currentCooldown = params.cooldowns.get(params.provider.id);
        if (!currentCooldown || nextCooldown.untilMs > currentCooldown.untilMs) {
          params.cooldowns.set(params.provider.id, nextCooldown);
        }
      }

      if (!canRetry) {
        return failure(lastError);
      }

      const delayMs = retryTiming.delayMs;
      const remainingBudgetMs = Math.max(0, params.deadlineAt - Date.now());
      if (delayMs >= remainingBudgetMs) {
        return failure(
          retryTiming.rateLimited
            ? `Rate-limit wait of ${delayMs}ms${retryTiming.source ? ` from ${retryTiming.source}` : ""} exceeds the remaining total timeout budget of ${remainingBudgetMs}ms.`
            : "deadline exceeded",
        );
      }
      retryHistory.push({ attempt, error: lastError, delayMs });
      if (retryTiming.rateLimited) {
        continue;
      }
      try {
        await sleep(delayMs, params.signal);
      } catch (sleepError) {
        return failure(
          params.signal.reason instanceof DeadlineExceededError
            ? "deadline exceeded"
            : asErrorMessage(sleepError),
        );
      }
    }
  }

  return failure(lastError ?? "Unknown error");
}

function exposeResult<T extends { rawItem?: unknown }>(result: T, includeRaw: boolean): T {
  if (includeRaw) return result;
  const { rawItem: _rawItem, ...visible } = result;
  void _rawItem;
  return visible as T;
}

function exposeAnswer(
  answer: ProviderAnswerDigest,
  includeRaw: boolean,
): ProviderAnswerDigest {
  if (includeRaw) return answer;
  return {
    ...answer,
    citationDetails: answer.citationDetails.map(({ raw: _raw, ...citation }) => {
      void _raw;
      return citation;
    }),
  };
}

function selectProviderEvidence<T extends { providerId: string }>(
  entries: readonly T[],
): T[] {
  const seenProviders = new Set<string>();
  return entries.filter((entry) => {
    if (seenProviders.has(entry.providerId)) {
      return false;
    }
    seenProviders.add(entry.providerId);
    return true;
  });
}

function selectMergedVariants(
  result: FusionMergedResult,
  includeRaw: boolean,
): NormalizedSearchResult[] {
  return includeRaw ? result.variants : selectProviderEvidence(result.variants);
}

function exposeMergedResult(
  result: FusionMergedResult,
  includeRaw: boolean,
): FusionMergedResult {
  return {
    ...result,
    rankings: includeRaw ? result.rankings : selectProviderEvidence(result.rankings),
    variants: selectMergedVariants(result, includeRaw).map((variant) =>
      exposeResult(variant, includeRaw),
    ),
  };
}

function exposeRankingMeta(
  ranking: FusionRankingMeta,
  includeRaw: boolean,
): FusionRankingMeta {
  return includeRaw
    ? ranking
    : {
        ...ranking,
        dropped: [],
      };
}

export async function runSearchFusion(params: {
  runtime: SearchRuntime;
  config: unknown;
  contextConfig?: unknown;
  pluginConfig: unknown;
  request: ProviderSelectionRequest;
  signal?: AbortSignal;
  agentDir?: string;
  runtimeMetadata?: unknown;
  searchConfig?: Record<string, unknown>;
  /** Test seam for the readPages step. */
  pageReaderDeps?: PageReaderDeps;
}): Promise<FusionSearchPayload> {
  const start = Date.now();
  const brokerConfig = asConfig(params.pluginConfig);
  const sourceTierMode = coerceSourceTierMode(brokerConfig.sourceTierMode);
  const dedupe = resolveMergeDedupeOptions(brokerConfig);
  const includeRawPayloads =
    params.request.includeRawPayloads ?? brokerConfig.includeRawPayloads ?? false;
  const includeDiscarded =
    params.request.includeDiscarded ?? brokerConfig.includeDiscarded ?? false;
  const maxSnippetLength = clamp(
    brokerConfig.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH,
    100,
    5000,
  );
  const output = { includeRawPayloads, includeDiscarded, maxSnippetLength };
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfig = applySearchConfigContext(
    runtimeConfigSnapshot ?? params.contextConfig ?? params.config,
    params.searchConfig,
  );
  const sourceConfig = await resolveRuntimeSourceConfig(params.config);
  const runtimeProviders = params.runtime.webSearch.listProviders({ config: runtimeConfig });
  const availableProviders = discoverProviders({
    providers: runtimeProviders,
    config: sourceConfig,
    fallbackConfig: runtimeConfig,
    catalogConfig: runtimeConfig,
    selfId: SEARCH_FUSION_PROVIDER_ID,
  });
  const selectedProviders = resolveSelectedProviders({
    availableProviders,
    requestMode: params.request.mode,
    requestProviders: params.request.providers,
    requestIntent: params.request.intent,
    config: brokerConfig,
  });

  if (selectedProviders.length === 0) {
    return {
      query: params.request.query,
      provider: SEARCH_FUSION_PROVIDER_ID,
      tookMs: Date.now() - start,
      count: 0,
      configuredProviders: availableProviders
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
      providersQueried: [],
      providersSucceeded: [],
      providersFailed: [],
      providerDetails: [],
      providerRuns: [],
      discardedResults: [],
      answers: [],
      results: [],
      ranking: emptyRankingMeta(
        resolveRankingOptions(brokerConfig, []).strategy,
      ),
      evidenceTable: buildEvidenceTable([], [], dedupe),
      output,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: SEARCH_FUSION_PROVIDER_ID,
        aggregated: true,
      },
    };
  }

  const maxMergedResults = clamp(
    params.request.maxMergedResults ?? brokerConfig.maxMergedResults ?? DEFAULT_MAX_MERGED_RESULTS,
    1,
    50,
  );
  const totalTimeoutMs = clamp(
    brokerConfig.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    5000,
    180000,
  );
  const deadlineAt = start + totalTimeoutMs;
  const runController = new AbortController();
  const removeOuterRelay = relayAbort(params.signal, runController);
  const deadlineTimer = setTimeout(
    () => runController.abort(new DeadlineExceededError()),
    Math.max(0, deadlineAt - Date.now()),
  );
  const providerCooldowns = new Map<string, ProviderCooldown>();
  const circuitBreaker = resolveCircuitBreaker(brokerConfig);
  const healthCheckedAt = Date.now();
  const openCircuits = new Map<string, ProviderHealth>();
  if (circuitBreaker.enabled) {
    for (const provider of selectedProviders) {
      const health = openCircuitFor(provider.id, healthCheckedAt);
      if (health) openCircuits.set(provider.id, health);
    }
    // Never skip the whole selection: when every provider is cooling off, probe them all.
    if (openCircuits.size === selectedProviders.length) openCircuits.clear();
  }

  const providerRunTasks = selectedProviders.map((provider) => {
    const startedAt = Date.now();
    const openHealth = openCircuits.get(provider.id);
    if (openHealth) {
      return {
        provider,
        startedAt,
        skipped: true,
        promise: Promise.resolve(circuitOpenResult(provider, openHealth, startedAt)),
      };
    }
    return {
      skipped: false,
      provider,
      startedAt,
      promise: raceWithSignal(
        resolveDelegatedRuntimeConfig({
          provider,
          runtimeProviders,
          runtimeConfig,
          sourceConfig,
        }).then((providerConfig) =>
          runProvider({
            runtime: params.runtime,
            config: providerConfig,
            brokerConfig,
            request: params.request,
            provider,
            sourceTierMode,
            maxSnippetLength,
            urlOptions: dedupe.enabled ? dedupe : undefined,
            signal: runController.signal,
            deadlineAt,
            cooldowns: providerCooldowns,
            agentDir: params.agentDir,
            runtimeMetadata: params.runtimeMetadata,
          }),
        ),
        runController.signal,
      ).catch((error) => {
        const rejection: ProviderRunTaskRejection = {
          error,
          tookMs: Math.max(0, Date.now() - startedAt),
        };
        throw rejection;
      }),
    };
  });

  let settledProviderRuns: PromiseSettledResult<ProviderRunResult>[];
  try {
    settledProviderRuns = await Promise.allSettled(
      providerRunTasks.map((task) => task.promise),
    );
  } finally {
    clearTimeout(deadlineTimer);
    removeOuterRelay();
  }
  const providerRuns = settledProviderRuns.map((settled, index) => {
    if (settled.status === "fulfilled") {
      return settled.value;
    }

    const rejection = isProviderRunTaskRejection(settled.reason) ? settled.reason : undefined;
    return asUnhandledProviderFailure({
      provider: providerRunTasks[index].provider,
      tookMs: rejection?.tookMs ?? Math.max(0, Date.now() - providerRunTasks[index].startedAt),
      error: rejection?.error ?? settled.reason,
    });
  });

  if (circuitBreaker.enabled && !params.signal?.aborted) {
    const recordedAt = Date.now();
    providerRuns.forEach((run, index) => {
      if (!providerRunTasks[index].skipped) recordProviderOutcome(circuitBreaker, run, recordedAt);
    });
  }

  const okRuns = providerRuns.filter((run) => run.ok);
  const contributingProviders = new Set(
    okRuns.filter((run) => run.results.length > 0).map((run) => run.providerId),
  ).size;
  // Fuzzy dedupe is a fusion feature: a single contributing provider keeps its
  // raw result set (exact-match dedupe only) unless fuzzyDedupe is explicitly true.
  const mergeDedupe =
    brokerConfig.fuzzyDedupe !== true && contributingProviders <= 1
      ? { ...dedupe, enabled: false }
      : dedupe;
  const merged = mergeResults(
    okRuns,
    maxMergedResults,
    sourceTierMode,
    mergeDedupe,
    selectedProviders.map((provider) => provider.id),
    resolveRankingOptions(
      brokerConfig,
      selectedProviders.map((provider) => provider.id),
    ),
  );
  const mergedResults = merged.results;
  const internalDiscardedResults = providerRuns.flatMap((run) => run.discardedResults);
  const internalAnswers = providerRuns
    .map((run) => run.answer)
    .filter((answer): answer is NonNullable<ProviderRunResult["answer"]> => Boolean(answer));
  const answers = internalAnswers.map((answer) => exposeAnswer(answer, includeRawPayloads));
  const visibleMergedResults = mergedResults.map((result) =>
    exposeMergedResult(result, includeRawPayloads),
  );
  const readPagesConfig = resolveReadPagesConfig(brokerConfig.readPages);
  const pageReads =
    readPagesConfig.enabled && visibleMergedResults.length > 0
      ? await readTopPages({
          query: params.request.query,
          results: visibleMergedResults,
          config: readPagesConfig,
          signal: params.signal,
          deadlineAt,
          deps: params.pageReaderDeps,
        })
      : undefined;
  const defaultProviderEvidence = new Set(
    mergedResults.flatMap((result) => selectMergedVariants(result, false)),
  );
  const discardedResults = includeDiscarded
    ? internalDiscardedResults.map((result) => exposeResult(result, includeRawPayloads))
    : [];

  return {
    query: params.request.query,
    provider: SEARCH_FUSION_PROVIDER_ID,
    tookMs: Date.now() - start,
    count: mergedResults.length,
    configuredProviders: availableProviders.filter((provider) => provider.configured).map((provider) => provider.id),
    providersQueried: selectedProviders.map((provider) => provider.id),
    providersSucceeded: providerRuns.filter((run) => run.ok).map((run) => run.providerId),
    providersFailed: providerRuns
      .filter((run) => !run.ok && run.error)
      .map((run) => ({ provider: run.providerId, error: run.error ?? "Unknown error" })),
    providerDetails: providerRuns.map((run) => ({
      provider: run.providerId,
      ok: run.ok,
      tookMs: run.tookMs,
      rawCount: run.rawCount,
      discardedCount: run.discardedResults.length,
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
    })),
    providerRuns: providerRuns.map((run) => ({
      provider: run.providerId,
      ok: run.ok,
      tookMs: run.tookMs,
      rawCount: run.rawCount,
      discardedCount: run.discardedResults.length,
      attempts: run.attempts,
      configured: run.configured,
      error: run.error,
      answer: run.answer ? exposeAnswer(run.answer, includeRawPayloads) : undefined,
      results: run.results
        .filter((result) => includeRawPayloads || defaultProviderEvidence.has(result))
        .map((result) => exposeResult(result, includeRawPayloads)),
      discardedResults: includeDiscarded
        ? run.discardedResults.map((result) => exposeResult(result, includeRawPayloads))
        : [],
      ...(includeRawPayloads ? { rawPayload: run.rawPayload } : {}),
      retryHistory: run.retryHistory,
    })),
    discardedResults,
    answers,
    results: visibleMergedResults,
    ...(pageReads ? { pageReads } : {}),
    ranking: exposeRankingMeta(merged.ranking, includeRawPayloads),
    evidenceTable: buildEvidenceTable(visibleMergedResults, answers, dedupe),
    output,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: SEARCH_FUSION_PROVIDER_ID,
      aggregated: true,
    },
  };
}

export function renderFusionSummary(payload: FusionSearchPayload, includeFailures = false): string {
  const lines: string[] = [];
  lines.push(
    `Search broker ran ${payload.providersQueried.length} provider${payload.providersQueried.length === 1 ? "" : "s"} in ${payload.tookMs}ms.`,
  );

  if (payload.results.length > 0) {
    lines.push("");
    lines.push(`Merged results (${payload.results.length}):`);
    payload.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title}`);
      lines.push(`   ${result.url}`);
      lines.push(
        `   Providers: ${result.providers.join(", ")} • Best rank: #${result.bestRank} • Source tier: ${result.bestSourceTier}`,
      );
      if (result.flags.length > 0) {
        lines.push(`   Flags: ${result.flags.join(", ")}`);
      }
      if (result.snippet) {
        lines.push(`   ${result.snippet}`);
      }
      for (const passage of result.passages ?? []) {
        lines.push(`   > ${passage}`);
      }
    });
  } else {
    lines.push("");
    lines.push("No merged results.");
  }

  if (payload.discardedResults.length > 0) {
    lines.push("");
    lines.push(`Preserved ${payload.discardedResults.length} non-merged item${payload.discardedResults.length === 1 ? "" : "s"} as provenance evidence.`);
  }

  if (payload.answers.length > 0) {
    lines.push("");
    lines.push("Provider answer digests:");
    for (const answer of payload.answers) {
      lines.push(`- ${answer.providerId}: ${answer.summary}`);
    }
  }

  lines.push("");
  lines.push("Provider status:");
  for (const detail of payload.providerDetails) {
    if (!includeFailures && !detail.ok) {
      continue;
    }
    const attemptText = detail.attempts > 1 ? `, ${detail.attempts} attempts` : "";
    lines.push(
      `- ${detail.provider}: ${detail.ok ? `ok (${detail.rawCount} hits, ${detail.tookMs}ms${attemptText})` : `failed (${detail.tookMs}ms${attemptText})${detail.error ? ` — ${detail.error}` : ""}`}`,
    );
  }

  if (includeFailures && payload.providersFailed.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const failure of payload.providersFailed) {
      lines.push(`- ${failure.provider}: ${failure.error}`);
    }
  }

  return lines.join("\n");
}
