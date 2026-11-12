// plugin-sdk/config-schema was retired; json-schema-runtime ships without types.
declare module "openclaw/plugin-sdk/json-schema-runtime" {
  export function validateJsonSchemaValue(params: {
    schema: unknown;
    cacheKey?: string;
    value: unknown;
  }): { ok: true; value: unknown } | { ok: false; errors: Array<{ text: string; path?: string; message?: string }> };
}
