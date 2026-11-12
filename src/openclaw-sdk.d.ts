// OpenClaw 2026.9+ ships these plugin-sdk subpaths as JavaScript without
// declaration files. Declare only what this plugin uses.
declare module "openclaw/plugin-sdk/web-content-extractor" {
  export function htmlToMarkdown(html: string): unknown;
  export function stripInvisibleUnicode(text: string): string;
}
