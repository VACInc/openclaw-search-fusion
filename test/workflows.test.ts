import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

// Supply-chain and least-privilege policy for .github/workflows.

type Permissions = string | Record<string, string>;
type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { uses?: string; permissions?: Permissions; steps?: Step[] };
type Workflow = { on?: unknown; permissions?: Permissions; jobs?: Record<string, Job> };

const workflowsDir = path.resolve(import.meta.dirname, "..", ".github", "workflows");
const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function readWorkflowText(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}

function readWorkflow(name: string): Workflow {
  return parse(readWorkflowText(name)) as Workflow;
}

function jobsOf(workflow: Workflow): Array<[string, Job]> {
  return Object.entries(workflow.jobs ?? {});
}

function usesRefs(workflow: Workflow): string[] {
  return jobsOf(workflow).flatMap(([, job]) => [
    ...(job.uses ? [job.uses] : []),
    ...(job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  ]);
}

// Only these jobs may hold write scopes, and only the scopes listed.
const allowedWriteScopes: Record<string, Record<string, string[]>> = {
  "package-publish.yml": { publish: ["id-token"] },
};

test("repo has workflows to check", () => {
  assert.ok(workflowFiles.length > 0);
});

for (const name of workflowFiles) {
  test(`${name}: every action and reusable workflow is pinned to a full commit SHA`, () => {
    const refs = usesRefs(readWorkflow(name));
    assert.ok(refs.length > 0, `${name} should reference at least one action`);
    for (const ref of refs) {
      if (ref.startsWith("./")) continue; // local actions/workflows are versioned with the repo
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name}: "${ref}" must be pinned to a 40-char commit SHA`);
    }
  });

  test(`${name}: every SHA pin carries a version comment for reviewers and Dependabot`, () => {
    for (const line of readWorkflowText(name).split("\n")) {
      if (!/^\s*(?:-\s+)?uses:\s*[^.\s]\S*@[0-9a-f]{40}/.test(line)) continue;
      assert.match(line, /@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/, `${name}: missing "# vX.Y.Z" comment on: ${line.trim()}`);
    }
  });

  test(`${name}: workflow-level GITHUB_TOKEN permissions are empty`, () => {
    assert.deepEqual(readWorkflow(name).permissions, {}, `${name} must set top-level "permissions: {}"`);
  });

  test(`${name}: every job declares explicit, least-privilege permissions`, () => {
    for (const [jobId, job] of jobsOf(readWorkflow(name))) {
      const permissions = job.permissions;
      assert.ok(
        permissions && typeof permissions === "object",
        `${name}#${jobId} must declare a permissions map (not inherit, not read-all/write-all)`,
      );
      const writes = Object.entries(permissions)
        .filter(([, level]) => level === "write")
        .map(([scope]) => scope)
        .sort();
      assert.deepEqual(writes, allowedWriteScopes[name]?.[jobId] ?? [], `${name}#${jobId} has unexpected write scopes`);
      for (const [scope, level] of Object.entries(permissions)) {
        assert.ok(["read", "write", "none"].includes(level), `${name}#${jobId}: ${scope}: ${level} is not a valid level`);
      }
    }
  });

  test(`${name}: no run: step interpolates github.* context directly into the shell`, () => {
    // Refs, branch names and PR titles are attacker-influenced; pass them
    // through env (e.g. $GITHUB_REF_NAME) instead of ${{ }} in scripts.
    for (const [jobId, job] of jobsOf(readWorkflow(name))) {
      for (const step of (job.steps ?? []) as Array<Step & { run?: string }>) {
        if (!step.run) continue;
        assert.doesNotMatch(step.run, /\$\{\{\s*github\./, `${name}#${jobId}: move github.* expressions out of run:`);
      }
    }
  });

  test(`${name}: actions/checkout does not persist the GITHUB_TOKEN into .git/config`, () => {
    for (const [jobId, job] of jobsOf(readWorkflow(name))) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        assert.equal(step.with?.["persist-credentials"], false, `${name}#${jobId}: checkout must set persist-credentials: false`);
      }
    }
  });
}

test("package-publish.yml: releases trigger on version tags only", () => {
  const workflow = readWorkflow("package-publish.yml");
  const on = workflow.on as Record<string, unknown>;
  assert.deepEqual(Object.keys(on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(on.push, { tags: ["v*"] }, "push must filter on v* tags only (no branches)");
  assert.equal(on.workflow_dispatch, null, "workflow_dispatch must not take inputs that could pick a ref");
});

test("package-publish.yml: every job is gated to refs/tags/v* (covers workflow_dispatch from a branch)", () => {
  for (const [jobId, job] of jobsOf(readWorkflow("package-publish.yml"))) {
    assert.equal(
      (job as Job & { if?: string }).if,
      "startsWith(github.ref, 'refs/tags/v')",
      `package-publish.yml#${jobId} must be gated to tag refs`,
    );
  }
});

test("package-publish.yml: publish waits for tests, typecheck, inspector, and tag/version match", () => {
  const jobs = readWorkflow("package-publish.yml").jobs ?? {};
  const publish = jobs.publish as Job & { needs?: string | string[] };
  assert.deepEqual([publish.needs].flat(), ["verify"]);
  const runs = (jobs.verify?.steps ?? []).map((step) => (step as { run?: string }).run ?? "");
  for (const command of ["pnpm install --frozen-lockfile", "pnpm test", "pnpm check", "pnpm run plugin:ci"]) {
    assert.ok(runs.includes(command), `verify job must run "${command}"`);
  }
  assert.ok(
    runs.some((run) => run.includes("$GITHUB_REF_NAME") && run.includes("package.json")),
    "verify job must check the tag against package.json version",
  );
});

function runCommands(workflowName: string, jobId: string): string[] {
  const job = readWorkflow(workflowName).jobs?.[jobId];
  assert.ok(job, `${workflowName} must define job ${jobId}`);
  return (job.steps ?? []).map((step) => (step as { run?: string }).run ?? "").filter(Boolean);
}

test("ci.yml: runs tests, typecheck and build on pull requests and main for Node 22 and 24", () => {
  const workflow = readWorkflow("ci.yml");
  const on = workflow.on as Record<string, unknown>;
  assert.ok("pull_request" in on);
  assert.deepEqual(on.push, { branches: ["main"] });
  const job = workflow.jobs?.test as Job & { strategy?: { matrix?: { node?: number[] } } };
  assert.deepEqual(job.strategy?.matrix?.node, [22, 24]);
  assert.deepEqual(runCommands("ci.yml", "test"), [
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm check",
    "pnpm run build",
  ]);
});

test("audit.yml: audits runtime deps at any severity and the full tree at high+, on PRs and weekly", () => {
  const on = readWorkflow("audit.yml").on as Record<string, unknown>;
  assert.ok("pull_request" in on);
  assert.deepEqual(on.push, { branches: ["main"] });
  assert.ok(Array.isArray(on.schedule) && on.schedule.length === 1, "audit must also run on a schedule");
  assert.deepEqual(runCommands("audit.yml", "audit"), ["pnpm audit --prod", "pnpm audit --audit-level=high"]);
});

test("plugin-inspector.yml: the inspector gate is still present", () => {
  assert.ok(runCommands("plugin-inspector.yml", "check").includes("pnpm run plugin:ci"));
});
