import { randomBytes } from "node:crypto";

type WrapWebContent = (
  content: string,
  source?: "web_search" | "web_fetch",
) => string;

let wrapWebContentPromise: Promise<WrapWebContent> | undefined;

function fallbackWrapWebContent(content: string): string {
  const sanitized = content.replace(
    /<<<\s*(END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+id="[^"]{1,128}")?\s*>>>/gi,
    (_marker, end: string | undefined) =>
      end ? "[[END_MARKER_SANITIZED]]" : "[[MARKER_SANITIZED]]",
  );
  const id = randomBytes(8).toString("hex");
  return [
    `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
    "Source: Web Search",
    "---",
    sanitized,
    `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
  ].join("\n");
}

async function resolveWrapWebContent(): Promise<WrapWebContent> {
  wrapWebContentPromise ??= import("openclaw/plugin-sdk/provider-web-search")
    .then((module) =>
      typeof module.wrapWebContent === "function"
        ? module.wrapWebContent
        : fallbackWrapWebContent,
    )
    .catch(() => fallbackWrapWebContent);
  return await wrapWebContentPromise;
}

/** Wrap one complete serialized search payload at its model-visible exit. */
export async function wrapModelVisibleSearchPayload(payload: unknown): Promise<string> {
  const wrapWebContent = await resolveWrapWebContent();
  return wrapWebContent(JSON.stringify(payload, null, 2), "web_search");
}
