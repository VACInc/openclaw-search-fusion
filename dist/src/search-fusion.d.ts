import type { FusionSearchPayload, ProviderSelectionRequest, SearchRuntime } from "./types.js";
export declare function runSearchFusion(params: {
    runtime: SearchRuntime;
    config: unknown;
    contextConfig?: unknown;
    pluginConfig: unknown;
    request: ProviderSelectionRequest;
    signal?: AbortSignal;
    agentDir?: string;
    runtimeMetadata?: unknown;
    searchConfig?: Record<string, unknown>;
}): Promise<FusionSearchPayload>;
export declare function renderFusionSummary(payload: FusionSearchPayload, includeFailures?: boolean): string;
