import path from "node:path";
import { fileURLToPath } from "node:url";

// plugin-inspector 0.3.10 binds its child runner's original stream writer,
// which can lose the final JSON write on Node 24+ when stdout is a pipe.
// Preload a child-only synchronous writer until the inspector fixes that seam.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor >= 24) {
  const preload = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "plugin-inspector-node-stdio.cjs",
  );
  const existing = process.env.NODE_OPTIONS?.trim();
  process.env.NODE_OPTIONS = [existing, `--require=${preload}`].filter(Boolean).join(" ");
}

await import("../node_modules/@openclaw/plugin-inspector/src/cli.js");
