import { asSingleLine, cleanProviderText, truncate } from "./text.js";
/** Longest provider failure message kept in the model-visible web_search payload. */
const MAX_FAILURE_MESSAGE_LENGTH = 200;
/**
 * Shape the payload the web_search tool hands to the model.
 *
 * OpenClaw caps web_search output (20,000 characters in 2026.10) and cuts the
 * tail, so the full audit payload (provider runs, ranking explanations, the
 * evidence table) pushed the merged results and their page passages out of view.
 * By default the model gets ranked results with snippets and passages plus a
 * short provider status; `includeRawPayloads` keeps the full payload for audits.
 */
export function buildModelVisibleSearchPayload(payload) {
    if (payload.output.includeRawPayloads)
        return payload;
    const results = payload.results.map((result) => {
        const entry = {
            title: result.title,
            url: result.url,
            providers: result.providers,
        };
        if (result.siteName)
            entry.siteName = result.siteName;
        if (result.snippet)
            entry.snippet = asSingleLine(result.snippet);
        if (result.passages && result.passages.length > 0)
            entry.passages = result.passages;
        return entry;
    });
    const visible = {
        query: payload.query,
        provider: payload.provider,
        tookMs: payload.tookMs,
        count: payload.count,
        providersQueried: payload.providersQueried,
        providersSucceeded: payload.providersSucceeded,
        results,
    };
    if (payload.providersFailed.length > 0) {
        visible.providersFailed = payload.providersFailed.map((failure) => ({
            provider: failure.provider,
            error: truncate(cleanProviderText(failure.error) || failure.error, MAX_FAILURE_MESSAGE_LENGTH),
        }));
    }
    if (payload.answers.length > 0) {
        visible.answers = payload.answers.map((answer) => ({
            providerId: answer.providerId,
            summary: answer.summary,
        }));
    }
    return visible;
}
