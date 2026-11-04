import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Guards dependency bumps: every `openclaw/plugin-sdk/*` subpath the plugin
// source imports must still resolve in the installed openclaw, and the runtime
// helpers it calls must still be exported. Without this, a removed SDK module
// only shows up as a silent fallback (or a runtime failure) inside a gateway.

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceFiles = [
  path.join(repoRoot, "index.ts"),
  ...fs
    .readdirSync(path.join(repoRoot, "src"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => path.join(repoRoot, "src", name)),
];

function importedSdkSubpaths(): string[] {
  const found = new Set<string>();
  const pattern = /["'](openclaw\/plugin-sdk\/[a-z0-9-]+)["']/g;
  for (const file of sourceFiles) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

const requiredRuntimeExports: Record<string, string[]> = {
  "openclaw/plugin-sdk/runtime-config-snapshot": ["getRuntimeConfigSnapshot"],
  "openclaw/plugin-sdk/config-runtime": ["resolveConfiguredSecretInputString"],
  "openclaw/plugin-sdk/provider-web-search": ["wrapWebContent"],
};

test("plugin source imports a known set of openclaw SDK subpaths", () => {
  assert.deepEqual(importedSdkSubpaths(), [
    "openclaw/plugin-sdk/config-runtime",
    "openclaw/plugin-sdk/plugin-entry",
    "openclaw/plugin-sdk/provider-web-search",
    "openclaw/plugin-sdk/runtime-config-snapshot",
  ]);
});

test("installed openclaw still exports every SDK subpath the plugin imports", async () => {
  for (const specifier of importedSdkSubpaths()) {
    await assert.doesNotReject(import(specifier), `${specifier} must resolve in the installed openclaw`);
  }
});

test("installed openclaw still exports the SDK runtime helpers the plugin calls", async () => {
  for (const [specifier, names] of Object.entries(requiredRuntimeExports)) {
    const module = (await import(specifier)) as Record<string, unknown>;
    for (const name of names) {
      assert.equal(typeof module[name], "function", `${specifier} must export ${name}()`);
    }
  }
});
