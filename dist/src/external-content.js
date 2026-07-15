import { randomBytes } from "node:crypto";
let wrapWebContentPromise;
function fallbackWrapWebContent(content) {
    const sanitized = content.replace(/<<<\s*(END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+id="[^"]{1,128}")?\s*>>>/gi, (_marker, end) => end ? "[[END_MARKER_SANITIZED]]" : "[[MARKER_SANITIZED]]");
    const id = randomBytes(8).toString("hex");
    return [
        `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
        "Source: Web Search",
        "---",
        sanitized,
        `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
    ].join("\n");
}
async function resolveWrapWebContent() {
    wrapWebContentPromise ??= import("openclaw/plugin-sdk/provider-web-search")
        .then((module) => typeof module.wrapWebContent === "function"
        ? module.wrapWebContent
        : fallbackWrapWebContent)
        .catch(() => fallbackWrapWebContent);
    return await wrapWebContentPromise;
}
/** Wrap one complete serialized search payload at its model-visible exit. */
export async function wrapModelVisibleSearchPayload(payload) {
    const wrapWebContent = await resolveWrapWebContent();
    return wrapWebContent(JSON.stringify(payload, null, 2), "web_search");
}
