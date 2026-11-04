/**
 * audit/review.ts
 *
 * Human-readable review renderer for AuditRecords.
 * Surfaces source quality notes, caveats, and a comparison summary
 * when diffing two audit records (rerun vs original).
 */

import type { AuditRecord } from "./types.js";

const SEVERITY_PREFIX: Record<string, string> = {
  info: "ℹ",
  warn: "⚠",
  error: "✖",
};

function caveatLines(caveats: AuditRecord["caveats"]): string[] {
  return caveats.map((c) => {
    const prefix = SEVERITY_PREFIX[c.severity] ?? "?";
    const target = c.target ? ` [${c.target}]` : "";
    return `  ${prefix} [${c.code}]${target} ${c.message}`;
  });
}

/**
 * Render a human-readable review of a single AuditRecord.
 *
 * @example
 * ```ts
 * console.log(renderAuditReview(record));
 * ```
 */
export function renderAuditReview(record: AuditRecord): string {
  const lines: string[] = [];

  const label = record.label ? ` "${record.label}"` : "";
  lines.push(`# Search Fusion Audit Review${label}`);
  lines.push(`Captured: ${record.capturedAt}`);
  lines.push(`Query: ${record.request.query}`);
  if (record.request.mode) lines.push(`Mode: ${record.request.mode}`);
  if (record.request.providers?.length) lines.push(`Providers: ${record.request.providers.join(", ")}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Merged results: ${record.summary.mergedResultCount}`);
  lines.push(`- Providers queried: ${record.summary.providersQueried.join(", ") || "(none)"}`);
  lines.push(`- Providers succeeded: ${record.summary.providersSucceeded.join(", ") || "(none)"}`);
  if (record.summary.providersFailed.length > 0) {
    lines.push(
      `- Providers failed: ${record.summary.providersFailed.map((f) => `${f.provider} (${f.error})`).join(", ")}`,
    );
  }
  if (record.summary.answerProviders.length > 0) {
    lines.push(`- Answer digests: ${record.summary.answerProviders.join(", ")}`);
  }
  lines.push(`- Total time: ${record.summary.tookMs}ms`);
  lines.push("");

  if (record.caveats.length > 0) {
    lines.push("## Top-level caveats");
    lines.push(...caveatLines(record.caveats));
    lines.push("");
  }

  lines.push("## Provider source quality");
  for (const ps of record.providerSummaries) {
    const status = ps.ok ? `ok (${ps.rawCount} hits, ${ps.tookMs}ms` + (ps.attempts > 1 ? `, ${ps.attempts} attempts` : "") + ")" : `failed (${ps.tookMs}ms)`;
    lines.push(`### ${ps.provider} — ${status}`);
    if (ps.observedFlags.length > 0) {
      const flaggedPct = Math.round(ps.flaggedResultFraction * 100);
      lines.push(`  Flags observed: ${ps.observedFlags.join(", ")} (${flaggedPct}% of results)`);
    }
    if (ps.caveats.length > 0) {
      lines.push(...caveatLines(ps.caveats));
    }
  }
  lines.push("");

  lines.push("## Merged results");
  if (record.payload.results.length === 0) {
    lines.push("  (no results)");
  } else {
    for (const [i, r] of record.payload.results.entries()) {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   URL: ${r.url}`);
      lines.push(`   Providers: ${r.providers.join(", ")} • Best rank: #${r.bestRank} • Score: ${r.score.toFixed(3)}`);
      if (r.flags.length > 0) {
        lines.push(`   Flags: ${r.flags.join(", ")}`);
      }
      if (r.snippet) {
        lines.push(`   Snippet: ${r.snippet}`);
      }
    }
  }
  lines.push("");

  if (record.payload.answers.length > 0) {
    lines.push("## Provider answer digests");
    for (const ans of record.payload.answers) {
      lines.push(`### ${ans.providerId}`);
      // Truncated summaries already end with an ellipsis from truncate().
      const needsEllipsis = ans.summaryTruncated && !ans.summary.endsWith("…");
      lines.push(`  ${ans.summary}${needsEllipsis ? "…" : ""}`);
      if (ans.citations.length > 0) {
        lines.push(`  Citations (${ans.citations.length}):`);
        for (const c of ans.citations) {
          lines.push(`    - ${c}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Compare two audit records (e.g. original vs rerun) and return a diff summary.
 *
 * @example
 * ```ts
 * const diff = compareAuditRecords(original, rerun);
 * console.log(diff.summary);
 * ```
 */
export function compareAuditRecords(
  original: AuditRecord,
  rerun: AuditRecord,
): {
  summary: string;
  urlsAdded: string[];
  urlsRemoved: string[];
  urlsRetained: string[];
  providerChanges: string[];
} {
  const originalUrls = new Set(original.payload.results.map((r) => r.canonicalUrl));
  const rerunUrls = new Set(rerun.payload.results.map((r) => r.canonicalUrl));

  const urlsAdded = [...rerunUrls].filter((u) => !originalUrls.has(u));
  const urlsRemoved = [...originalUrls].filter((u) => !rerunUrls.has(u));
  const urlsRetained = [...originalUrls].filter((u) => rerunUrls.has(u));

  const providerChanges: string[] = [];
  const origSucceeded = new Set(original.summary.providersSucceeded);
  const rerunSucceeded = new Set(rerun.summary.providersSucceeded);

  for (const p of [...origSucceeded]) {
    if (!rerunSucceeded.has(p)) {
      providerChanges.push(`${p}: was ok → now failed`);
    }
  }
  for (const p of [...rerunSucceeded]) {
    if (!origSucceeded.has(p)) {
      providerChanges.push(`${p}: was failed → now ok`);
    }
  }

  const lines: string[] = [
    `## Audit Comparison`,
    `Original: ${original.capturedAt} (${original.summary.mergedResultCount} results)`,
    `Rerun:    ${rerun.capturedAt} (${rerun.summary.mergedResultCount} results)`,
    ``,
    `Results retained: ${urlsRetained.length}`,
    `Results added:    ${urlsAdded.length}`,
    `Results removed:  ${urlsRemoved.length}`,
  ];

  if (urlsAdded.length > 0) {
    lines.push(``, `Added URLs:`);
    for (const u of urlsAdded) lines.push(`  + ${u}`);
  }
  if (urlsRemoved.length > 0) {
    lines.push(``, `Removed URLs:`);
    for (const u of urlsRemoved) lines.push(`  - ${u}`);
  }
  if (providerChanges.length > 0) {
    lines.push(``, `Provider status changes:`);
    for (const c of providerChanges) lines.push(`  ~ ${c}`);
  }
  if (providerChanges.length === 0 && urlsAdded.length === 0 && urlsRemoved.length === 0) {
    lines.push(``, `No changes detected.`);
  }

  return {
    summary: lines.join("\n"),
    urlsAdded,
    urlsRemoved,
    urlsRetained,
    providerChanges,
  };
}
