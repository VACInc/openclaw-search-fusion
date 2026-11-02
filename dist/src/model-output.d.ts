import type { FusionSearchPayload } from "./types.js";
export type ModelVisibleSearchResult = {
    title: string;
    url: string;
    siteName?: string;
    snippet?: string;
    passages?: string[];
    providers: string[];
};
export type ModelVisibleSearchPayload = {
    query: string;
    provider: FusionSearchPayload["provider"];
    tookMs: number;
    count: number;
    providersQueried: string[];
    providersSucceeded: string[];
    providersFailed?: Array<{
        provider: string;
        error: string;
    }>;
    results: ModelVisibleSearchResult[];
    answers?: Array<{
        providerId: string;
        summary: string;
    }>;
};
/**
 * Shape the payload the web_search tool hands to the model.
 *
 * OpenClaw caps web_search output (20,000 characters in 2026.10) and cuts the
 * tail, so the full audit payload (provider runs, ranking explanations, the
 * evidence table) pushed the merged results and their page passages out of view.
 * By default the model gets ranked results with snippets and passages plus a
 * short provider status; `includeRawPayloads` keeps the full payload for audits.
 */
export declare function buildModelVisibleSearchPayload(payload: FusionSearchPayload): FusionSearchPayload | ModelVisibleSearchPayload;
