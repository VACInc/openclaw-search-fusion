import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

type Update = {
  "package-ecosystem": string;
  directory: string;
  schedule?: { interval?: string };
  cooldown?: { "default-days"?: number };
};

const configPath = path.resolve(import.meta.dirname, "..", ".github", "dependabot.yml");
const config = parse(fs.readFileSync(configPath, "utf8")) as { version: number; updates: Update[] };

function updateFor(ecosystem: string): Update | undefined {
  return config.updates.find((entry) => entry["package-ecosystem"] === ecosystem && entry.directory === "/");
}

test("dependabot config is version 2", () => {
  assert.equal(config.version, 2);
});

for (const ecosystem of ["npm", "github-actions"]) {
  test(`dependabot watches ${ecosystem} at the repo root weekly with a release cooldown`, () => {
    const update = updateFor(ecosystem);
    assert.ok(update, `missing ${ecosystem} update entry`);
    assert.equal(update.schedule?.interval, "weekly");
    assert.ok((update.cooldown?.["default-days"] ?? 0) >= 3, `${ecosystem} should let releases age before proposing them`);
  });
}
