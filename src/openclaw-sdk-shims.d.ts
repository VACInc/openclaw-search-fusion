// openclaw >=2026.8 still ships `plugin-sdk/provider-web-search` at runtime but
// no longer publishes a `types` entry for it. Search Fusion only needs the one
// optional helper, and external-content.ts already falls back when it is
// missing, so declare exactly that surface instead of loosening tsconfig.
declare module "openclaw/plugin-sdk/provider-web-search" {
  export const wrapWebContent:
    | ((content: string, source?: "web_search" | "web_fetch") => string)
    | undefined;
}
