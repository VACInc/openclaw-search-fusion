import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Supply-chain policy for .github/workflows. Line-based on purpose: the
// workflows are small and hand-written, and this keeps the check free of a
// YAML dependency.

const workflowsDir = path.resolve(import.meta.dirname, "..", ".github", "workflows");
const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}

function usesRefs(source: string): string[] {
  return [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]!);
}

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
    for (const line of readWorkflow(name).split("\n")) {
      if (!/^\s*(?:-\s+)?uses:\s*[^.\s]\S*@[0-9a-f]{40}/.test(line)) continue;
      assert.match(line, /@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/, `${name}: missing "# vX.Y.Z" comment on: ${line.trim()}`);
    }
  });
}
