/**
 * Offline replay harness: feeds recorded provider payloads through the real
 * `runSearchFusion` pipeline and scores the merged output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSearchFusion } from "../src/search-fusion.js";
import type { FusionSearchPayload, ProviderSelectionRequest, SearchFusionConfig } from "../src/types.js";
import {
  aggregateMetrics,
  computeQueryMetrics,
  type JudgedPage,
  type MetricName,
  type QueryMetrics,
} from "./metrics.js";

export type FixtureProvider =
  | { payload: Record<string, unknown>; wrap?: boolean; error?: undefined }
  | { error: string; payload?: undefined; wrap?: undefined };

export type EvalFixture = {
  id: string;
  query: string;
  notes?: string;
  request?: Partial<ProviderSelectionRequest>;
  pluginConfig?: SearchFusionConfig;
  providers: Record<string, FixtureProvider>;
  pages: JudgedPage[];
  answer?: { mustMention?: string[] };
};

export type FixtureRun = {
  fixture: EvalFixture;
  payload: FusionSearchPayload;
  metrics: QueryMetrics;
  unjudgedUrls: string[];
};

export type SetReport = {
  set: string;
  queries: number;
  aggregate: Record<MetricName, number>;
  runs: FixtureRun[];
};

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.join(EVAL_DIR, "fixtures");
export const BASELINE_PATH = path.join(EVAL_DIR, "baseline.json");

const WRAPPED_TEXT_KEYS = new Set(["title", "description", "snippet", "content", "answer", "summary"]);

/** Same envelope OpenClaw's `wrapWebContent(text, "web_search")` produces. */
function wrapWebContent(text: string, markerId: string): string {
  return [
    "",
    `<<<EXTERNAL_UNTRUSTED_CONTENT id="${markerId}">>>`,
    "Source: Web Search",
    "---",
    text,
    `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${markerId}">>>`,
  ].join("\n");
}

function wrapTextFields(value: unknown, markerId: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => wrapTextFields(entry, markerId));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      typeof entry === "string" && WRAPPED_TEXT_KEYS.has(key) && entry.length > 0
        ? wrapWebContent(entry, markerId)
        : wrapTextFields(entry, markerId);
  }
  return out;
}

function servePayload(provider: FixtureProvider & { payload: Record<string, unknown> }, providerId: string, count: number) {
  const payload = structuredClone(provider.payload);
  if (Array.isArray(payload.results)) payload.results = payload.results.slice(0, count);
  return provider.wrap === false ? payload : (wrapTextFields(payload, `${providerId}-fixture`) as Record<string, unknown>);
}

function collectUrls(value: unknown, out: Set<string>): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") out.add(entry.trim());
      else collectUrls(entry, out);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "url" || key === "link" || key === "href") && typeof entry === "string") out.add(entry.trim());
    else if (key === "results" || key === "sources" || key === "citations" || key === "web") collectUrls(entry, out);
  }
}

export function loadFixtures(set: string): EvalFixture[] {
  const dir = path.join(FIXTURE_ROOT, set);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as EvalFixture);
}

export function listFixtureSets(): string[] {
  if (!fs.existsSync(FIXTURE_ROOT)) return [];
  return fs
    .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function createReplayRuntime(fixture: EvalFixture, served: Set<string>) {
  const ids = Object.keys(fixture.providers);
  return {
    webSearch: {
      listProviders: () =>
        ids.map((id, index) => ({
          id,
          label: id,
          autoDetectOrder: index + 1,
          envVars: [],
          getConfiguredCredentialValue: () => `${id}-fixture-key`,
          getCredentialValue: () => undefined,
        })),
      search: async ({ providerId, args }: { providerId?: string; args: Record<string, unknown> }) => {
        const provider = providerId ? fixture.providers[providerId] : undefined;
        if (!provider) throw new Error(`fixture has no provider ${String(providerId)}`);
        if (provider.error !== undefined) throw new Error(provider.error);
        const count = typeof args.count === "number" ? args.count : 5;
        const result = servePayload(provider, providerId!, count);
        collectUrls(result, served);
        return { provider: providerId!, result };
      },
    },
  };
}

export async function runFixture(fixture: EvalFixture): Promise<FixtureRun> {
  const served = new Set<string>();
  const pluginConfig: SearchFusionConfig = {
    ...fixture.pluginConfig,
    // Failures are recorded, so retrying only slows the replay down.
    retry: { maxAttempts: 1, ...fixture.pluginConfig?.retry },
  };
  const payload = await runSearchFusion({
    runtime: createReplayRuntime(fixture, served) as never,
    config: {},
    pluginConfig,
    request: {
      query: fixture.query,
      providers: Object.keys(fixture.providers),
      ...fixture.request,
    },
  });

  const judged = new Map<string, JudgedPage>();
  for (const page of fixture.pages) for (const url of page.urls) judged.set(url.trim(), page);
  const retrievableById = new Map<string, JudgedPage>();
  const unjudgedUrls: string[] = [];
  for (const url of served) {
    const page = judged.get(url);
    if (page) retrievableById.set(page.id, page);
    else unjudgedUrls.push(url);
  }

  return {
    fixture,
    payload,
    unjudgedUrls,
    metrics: computeQueryMetrics({
      payload,
      pages: fixture.pages,
      retrievable: [...retrievableById.values()],
      mustMention: fixture.answer?.mustMention,
    }),
  };
}

export async function runSet(set: string): Promise<SetReport> {
  const fixtures = loadFixtures(set);
  const runs: FixtureRun[] = [];
  for (const fixture of fixtures) runs.push(await runFixture(fixture));
  return {
    set,
    queries: runs.length,
    aggregate: aggregateMetrics(runs.map((run) => run.metrics)),
    runs,
  };
}

export type Baseline = Record<string, Record<MetricName, number>>;

export function readBaseline(): Baseline | undefined {
  if (!fs.existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

export function roundMetrics(metrics: Record<MetricName, number>): Record<MetricName, number> {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => [name, Math.round(value * 10_000) / 10_000]),
  ) as Record<MetricName, number>;
}
