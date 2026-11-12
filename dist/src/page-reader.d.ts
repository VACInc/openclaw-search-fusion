/**
 * Read-top-pages enrichment: fetch the best merged results through OpenClaw's
 * SSRF-guarded fetch and attach the passages that best answer the query, so an
 * agent can answer from one search call instead of guessing from snippets.
 *
 * Off by default. Every failure is per page and silent: a page that times out,
 * is blocked, or is not HTML simply keeps its provider snippet.
 */
export type SearchFusionReadPagesConfig = {
    enabled?: boolean;
    /** Merged results to read, best first. Default 4. */
    topK?: number;
    /** Wall-clock budget for the whole read step. Default 4000 ms. */
    timeoutMs?: number;
    /** Passages kept per page. Default 3. */
    maxPassages?: number;
    /** Target passage length in characters. Default 600. */
    passageChars?: number;
    /** Response body cap per page. Default 1.5 MB. */
    maxBytes?: number;
    /** Hosts (and their subdomains) never fetched: video, social, and login walls. */
    skipDomains?: string[];
    blockedTlds?: string[];
    skipGithubCopies?: boolean;
};
export type ResolvedReadPagesConfig = {
    enabled: boolean;
    topK: number;
    timeoutMs: number;
    maxPassages: number;
    passageChars: number;
    maxBytes: number;
    skipDomains: string[];
    blockedTlds: string[];
    skipGithubCopies: boolean;
};
export type PageReadOutcome = {
    url: string;
    ok: boolean;
    tookMs: number;
    passages: number;
    error?: string;
    skipped?: string;
};
export type FetchedPage = {
    status: number;
    contentType: string;
    body: string;
    finalUrl: string;
};
export type PageReaderDeps = {
    /** `blockedTlds` must also refuse redirect hops into those TLDs, before any DNS lookup. */
    fetchPage: (url: string, opts: {
        timeoutMs: number;
        maxBytes: number;
        signal: AbortSignal;
        blockedTlds?: string[];
    }) => Promise<FetchedPage>;
    /** Pre-read resolver check. Omit to skip it (static policy still applies). */
    resolveHost?: (hostname: string) => Promise<string[]>;
    htmlToText: (html: string, url: string) => Promise<string>;
};
export declare const DEFAULT_SKIP_DOMAINS: string[];
export declare function resolveReadPagesConfig(raw: unknown): ResolvedReadPagesConfig;
/** Lowercased query terms; keeps version-like tokens such as `9.1` or `2026.11` intact. */
export declare function queryTerms(query: string): string[];
/** Split page text into passage windows of roughly `targetChars`. */
export declare function splitPassages(text: string, targetChars: number): string[];
/**
 * Rank passages by BM25 over the page's own windows, boosted by how many distinct
 * query terms a window covers. Returns the best `max` windows with a positive score.
 */
export declare function selectPassages(text: string, query: string, max: number, targetChars: number): string[];
/**
 * Fit a long provider snippet into `maxLength` by keeping the windows that best
 * match the query instead of the head of the page (which is often navigation).
 * Returns undefined when nothing matches, so callers keep head truncation.
 */
export declare function focusSnippet(text: string, query: string, maxLength: number): string | undefined;
/** Markdown images and link targets, and stray inline HTML tags, are noise inside passages. */
export declare function stripMarkupNoise(text: string): string;
export declare function stripBoilerplateHtml(html: string): string;
export declare function fallbackHtmlToText(html: string): string;
/** True when `host` is a blocked TLD or under one (label bounded: `notsu.example` is not `.su`). */
export declare function hostHasBlockedTld(host: string, blockedTlds: string[]): boolean;
/** Charset from the Content-Type header, else from a <meta> tag near the top of the page; utf-8 otherwise. */
export declare function decodePageBytes(bytes: Uint8Array, contentType: string): string;
/** Default deps: OpenClaw's SSRF-guarded fetch (blocks private and internal addresses). */
export declare const defaultPageReaderDeps: PageReaderDeps;
export type ReadableResult = {
    url: string;
    passages?: string[];
};
/**
 * Read up to `topK` results in parallel inside one wall-clock budget and attach
 * `passages` to each result that yielded query-relevant text. Mutates `results`.
 */
export declare function readTopPages(params: {
    query: string;
    results: ReadableResult[];
    config: ResolvedReadPagesConfig;
    signal?: AbortSignal;
    deps?: PageReaderDeps;
    deadlineAt?: number;
}): Promise<PageReadOutcome[]>;
/**
 * One log line per search: how many pages were read and which hits were skipped
 * (host and reason only; no paths or query strings).
 */
export declare function summarizePageReads(reads: PageReadOutcome[] | undefined): string | undefined;
