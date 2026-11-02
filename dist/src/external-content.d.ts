/**
 * Wrap one complete serialized search payload at its model-visible exit.
 * `indent` 0 serializes compactly for size-capped surfaces.
 */
export declare function wrapModelVisibleSearchPayload(payload: unknown, indent?: number): Promise<string>;
