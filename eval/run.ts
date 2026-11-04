/**
 * CLI for the offline result-quality eval.
 *
 *   pnpm run eval [-- --set dev] [--per-query] [--json] [--write-baseline]
 */

import fs from "node:fs";
import {
  BASELINE_PATH,
  listFixtureSets,
  readBaseline,
  roundMetrics,
  runSet,
  type Baseline,
  type SetReport,
} from "./harness.js";
import { INFORMATIONAL, LOWER_IS_BETTER, METRIC_NAMES, type MetricName } from "./metrics.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const setIndex = argv.indexOf("--set");
const sets = setIndex >= 0 && argv[setIndex + 1] ? [argv[setIndex + 1]] : listFixtureSets();

function fmt(value: number | undefined): string {
  return value === undefined ? "  -   " : value.toFixed(4);
}

function delta(name: MetricName, value: number, base: number | undefined): string {
  if (base === undefined) return "";
  const diff = value - base;
  if (Math.abs(diff) < 1e-4) return "  =";
  const better = LOWER_IS_BETTER.has(name) ? diff < 0 : diff > 0;
  const mark = INFORMATIONAL.has(name) ? "" : better ? " ✓" : " ✗";
  return ` ${diff > 0 ? "+" : ""}${diff.toFixed(4)}${mark}`;
}

const reports: SetReport[] = [];
for (const set of sets) reports.push(await runSet(set));

if (flag("--json")) {
  console.log(
    JSON.stringify(
      reports.map((report) => ({
        set: report.set,
        queries: report.queries,
        aggregate: roundMetrics(report.aggregate),
        perQuery: report.runs.map((run) => ({ id: run.fixture.id, metrics: run.metrics, unjudged: run.unjudgedUrls })),
      })),
      null,
      2,
    ),
  );
} else {
  const baseline = readBaseline();
  for (const report of reports) {
    console.log(`\n== ${report.set} (${report.queries} queries)`);
    for (const name of METRIC_NAMES) {
      const arrow = LOWER_IS_BETTER.has(name) ? "↓" : INFORMATIONAL.has(name) ? " " : "↑";
      console.log(
        `  ${name.padEnd(16)} ${arrow} ${fmt(report.aggregate[name])}${delta(name, report.aggregate[name], baseline?.[report.set]?.[name])}`,
      );
    }
    if (flag("--per-query")) {
      console.log("");
      for (const run of report.runs) {
        const m = run.metrics;
        console.log(
          `  ${run.fixture.id.padEnd(34)} ndcg@5=${fmt(m["ndcg@5"])} ndcg@10=${fmt(m["ndcg@10"])} p@5=${fmt(m["p@5"])} mrr=${fmt(m.mrr)} dup=${fmt(m["dup@10"])} junk=${fmt(m["junk@5"])} snipFb=${fmt(m.snippetFallback)}${run.unjudgedUrls.length ? ` UNJUDGED=${run.unjudgedUrls.length}` : ""}`,
        );
      }
    }
  }
}

if (flag("--write-baseline")) {
  const baseline: Baseline = {};
  for (const report of reports) baseline[report.set] = roundMetrics(report.aggregate);
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nWrote ${BASELINE_PATH}`);
}
