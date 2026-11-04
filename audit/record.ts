/**
 * audit/record.ts
 *
 * Functions to create and serialize AuditRecord objects from a
 * FusionSearchPayload + request context.
 */

import type {
  AuditCaveat,
  AuditProviderSummary,
  AuditRecord,
  CreateAuditRecordParams,
} from "./types.js";
import { AUDIT_SCHEMA_VERSION } from "./types.js";
import type { FusionSearchPayload, SearchFusionConfig } from "../src/types.js";

function fraction(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Auth failures: a standalone 401/403 status code (the same matching the
 * retry classifier uses, so "4031", "1.401", or "403 ms" do not count) or
 * auth/credential wording.
 */
const AUTH_STATUS_PATTERN =
  /(?<!\w|\d\.)(?:401|403)(?!\w|\.\d)(?!\s*(?:ms|s|sec|secs|seconds|milliseconds)\b)/i;
const AUTH_MESSAGE_PATTERN = /unauthorized|forbidden|invalid api key|api key|credential/i;

function isAuthError(message: string): boolean {
  return AUTH_STATUS_PATTERN.test(message) || AUTH_MESSAGE_PATTERN.test(message);
}

function providerCaveats(run: FusionSearchPayload["providerRuns"][number]): AuditCaveat[] {
  const caveats: AuditCaveat[] = [];

  if (!run.configured) {
    caveats.push({
      severity: "warn",
      code: "provider-not-configured",
      message: `Provider "${run.provider}" appears unconfigured. Results may be absent or degraded.`,
      target: run.provider,
    });
  }

  if (!run.ok && run.error) {
    caveats.push({
      severity: "error",
      code: isAuthError(run.error) ? "provider-auth-error" : "provider-run-failed",
      message: run.error,
      target: run.provider,
    });
  }

  if (run.ok && run.attempts > 1) {
    caveats.push({
      severity: "warn",
      code: "provider-needed-retry",
      message: `Provider "${run.provider}" succeeded after ${run.attempts} attempts (${run.attempts - 1} retr${run.attempts - 1 === 1 ? "y" : "ies"}).`,
      target: run.provider,
    });
  }

  if (run.ok && run.rawCount === 0) {
    caveats.push({
      severity: "warn",
      code: "provider-empty-results",
      message: `Provider "${run.provider}" returned 0 results.`,
      target: run.provider,
    });
  }

  return caveats;
}

function buildProviderSummary(
  run: FusionSearchPayload["providerRuns"][number],
): AuditProviderSummary {
  const flagSet = new Set<string>();
  let flaggedCount = 0;
  for (const result of run.results) {
    if (result.flags.length > 0) {
      flaggedCount += 1;
    }
    for (const flag of result.flags) {
      flagSet.add(flag);
    }
  }

  return {
    provider: run.provider,
    configured: run.configured,
    ok: run.ok,
    rawCount: run.rawCount,
    tookMs: run.tookMs,
    attempts: run.attempts,
    error: run.error,
    flaggedResultFraction: fraction(flaggedCount, run.results.length),
    observedFlags: [...flagSet].sort(),
    caveats: providerCaveats(run),
  };
}

function topLevelCaveats(payload: FusionSearchPayload): AuditCaveat[] {
  const caveats: AuditCaveat[] = [];

  const totalQueried = payload.providersQueried.length;
  const failedCount = payload.providersFailed.length;

  if (totalQueried === 0) {
    caveats.push({
      severity: "error",
      code: "no-providers-queried",
      message: "No providers were queried. Check provider configuration.",
    });
    return caveats;
  }

  if (failedCount === totalQueried) {
    caveats.push({
      severity: "error",
      code: "all-providers-failed",
      message: `All ${totalQueried} provider(s) failed. Results are empty.`,
    });
  } else if (failedCount > 0) {
    caveats.push({
      severity: "warn",
      code: "some-providers-failed",
      message: `${failedCount} of ${totalQueried} provider(s) failed: ${payload.providersFailed.map((f) => f.provider).join(", ")}.`,
    });
  }

  if (payload.results.length === 0 && payload.answers.length === 0) {
    caveats.push({
      severity: "warn",
      code: "no-results",
      message: "No merged results or answer digests were produced.",
    });
  }

  // Flag heavy result sets where most results carry quality flags
  const sponsoredCount = payload.results.filter((r) => r.flags.includes("sponsored")).length;
  if (sponsoredCount > 0 && payload.results.length > 0) {
    const pct = Math.round((sponsoredCount / payload.results.length) * 100);
    if (pct >= 30) {
      caveats.push({
        severity: "warn",
        code: "high-sponsored-ratio",
        message: `${pct}% of merged results are marked sponsored (${sponsoredCount}/${payload.results.length}).`,
      });
    }
  }

  // Note single-provider results (no corroboration)
  const uncorroborated = payload.results.filter((r) => r.providerCount === 1).length;
  if (payload.providersSucceeded.length >= 2 && uncorroborated === payload.results.length && payload.results.length > 0) {
    caveats.push({
      severity: "info",
      code: "no-cross-provider-corroboration",
      message: "No results were corroborated by more than one provider.",
    });
  }

  return caveats;
}

/**
 * Create an AuditRecord from a FusionSearchPayload and the request context.
 *
 * @example
 * ```ts
 * const record = createAuditRecord({ payload, request, pluginConfig, label: "my-query" });
 * fs.writeFileSync("my-audit.json", JSON.stringify(record, null, 2));
 * ```
 */
export function createAuditRecord(params: CreateAuditRecordParams): AuditRecord {
  const { payload, request, pluginConfig = {}, label, capturedAt } = params;

  const providerSummaries = payload.providerRuns.map(buildProviderSummary);
  const caveats = topLevelCaveats(payload);

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    capturedAt: capturedAt ?? new Date().toISOString(),
    label,
    request,
    pluginConfig: pluginConfig as SearchFusionConfig,
    summary: {
      tookMs: payload.tookMs,
      mergedResultCount: payload.results.length,
      providersQueried: payload.providersQueried,
      providersSucceeded: payload.providersSucceeded,
      providersFailed: payload.providersFailed,
      answerProviders: payload.answers.map((a) => a.providerId),
    },
    providerSummaries,
    caveats,
    payload,
  };
}

/**
 * Parse an AuditRecord from raw JSON (e.g. read from disk).
 * Throws if the JSON is not a valid AuditRecord.
 */
export function parseAuditRecord(json: string): AuditRecord {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== AUDIT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Invalid audit record: expected schemaVersion ${AUDIT_SCHEMA_VERSION}. ` +
        `Got: ${JSON.stringify((parsed as { schemaVersion?: unknown })?.schemaVersion)}`,
    );
  }
  return parsed as AuditRecord;
}
