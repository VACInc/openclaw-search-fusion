/**
 * Read-top-pages enrichment: fetch the best merged results through OpenClaw's
 * SSRF-guarded fetch and attach the passages that best answer the query, so an
 * agent can answer from one search call instead of guessing from snippets.
 *
 * Off by default. Every failure is per page and silent: a page that times out,
 * is blocked, or is not HTML simply keeps its provider snippet.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { neutralizeUntrustedText, sanitizeErrorText } from "./text.js";
export const DEFAULT_SKIP_DOMAINS = [
    "youtube.com",
    "youtu.be",
    "x.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "linkedin.com",
];
const clampInt = (value, fallback, min, max) => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
};
export function resolveReadPagesConfig(raw) {
    const cfg = (raw && typeof raw === "object" ? raw : {});
    return {
        enabled: cfg.enabled === true,
        blockedTlds: (Array.isArray(cfg.blockedTlds) ? cfg.blockedTlds : ["su"]).filter((d) => typeof d === "string").map((d) => d.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean),
        skipGithubCopies: cfg.skipGithubCopies !== false,
        topK: clampInt(cfg.topK, 4, 1, 10),
        timeoutMs: clampInt(cfg.timeoutMs, 4000, 500, 30000),
        maxPassages: clampInt(cfg.maxPassages, 3, 1, 8),
        passageChars: clampInt(cfg.passageChars, 600, 200, 2000),
        maxBytes: clampInt(cfg.maxBytes, 1_500_000, 50_000, 5_000_000),
        skipDomains: Array.isArray(cfg.skipDomains)
            ? cfg.skipDomains.filter((d) => typeof d === "string" && d.length > 0).map((d) => d.toLowerCase())
            : DEFAULT_SKIP_DOMAINS,
    };
}
const STOPWORDS = new Set(("a an and are as at be by can do does for from has have how i if in into is it its of on or " +
    "that the their then there these this to was what when where which who why will with you your " +
    "vs versus best latest new not no get set use using example examples").split(" "));
/** Lowercased query terms; keeps version-like tokens such as `9.1` or `2026.11` intact. */
export function queryTerms(query) {
    const out = [];
    for (const raw of query.toLowerCase().split(/[^a-z0-9.+#_-]+/)) {
        const tok = raw.replace(/^[.\-_]+|[.\-_]+$/g, "");
        if (tok.length < 2 || STOPWORDS.has(tok))
            continue;
        if (!out.includes(tok))
            out.push(tok);
    }
    return out;
}
function tokenize(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9.+#_-]+/)
        .map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, ""))
        .filter((t) => t.length > 0);
}
/** Split page text into passage windows of roughly `targetChars`. */
export function splitPassages(text, targetChars) {
    const blocks = text
        .split(/\n\s*\n|\n(?=#{1,6} )/)
        .map((b) => b.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
        .filter((b) => b.length >= 25);
    const pieces = [];
    for (const block of blocks) {
        if (block.length <= targetChars) {
            pieces.push(block);
            continue;
        }
        // Long block: cut on sentence boundaries.
        const sentences = block.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [block];
        let cur = "";
        for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
            if (cur && cur.length + s.length + 1 > targetChars) {
                pieces.push(cur);
                cur = "";
            }
            cur = cur ? `${cur} ${s}` : s;
            while (cur.length > targetChars * 1.5) {
                pieces.push(cur.slice(0, targetChars));
                cur = cur.slice(targetChars);
            }
        }
        if (cur)
            pieces.push(cur);
    }
    // Merge short neighbours so a heading or one-line fact keeps its context.
    const windows = [];
    let cur = "";
    for (const p of pieces) {
        if (cur && cur.length + p.length + 1 > targetChars) {
            windows.push(cur);
            cur = "";
        }
        cur = cur ? `${cur} ${p}` : p;
    }
    if (cur)
        windows.push(cur);
    return windows;
}
/**
 * Rank passages by BM25 over the page's own windows, boosted by how many distinct
 * query terms a window covers. Returns the best `max` windows with a positive score.
 */
export function selectPassages(text, query, max, targetChars) {
    const terms = queryTerms(query);
    if (terms.length === 0)
        return [];
    const windows = splitPassages(text, targetChars);
    if (windows.length === 0)
        return [];
    const docs = windows.map((w) => tokenize(w));
    const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
    const df = new Map();
    for (const term of terms)
        df.set(term, docs.filter((d) => d.includes(term)).length);
    const k1 = 1.2;
    const b = 0.75;
    const scored = docs.map((doc, index) => {
        let score = 0;
        let covered = 0;
        for (const term of terms) {
            const tf = doc.filter((t) => t === term).length;
            if (tf === 0)
                continue;
            covered += 1;
            const n = df.get(term) ?? 0;
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
            score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen));
        }
        const coverage = covered / terms.length;
        // Link-farm and menu windows: many tokens, little prose punctuation.
        const proseish = /[.:;]/.test(windows[index]) ? 1 : 0.6;
        return { index, score: score * (1 + coverage) * proseish, covered };
    });
    return scored
        .filter((s) => s.score > 0 && s.covered >= Math.min(2, terms.length))
        .sort((a, b2) => b2.score - a.score || a.index - b2.index)
        .slice(0, max)
        .map((s) => windows[s.index]);
}
/**
 * Fit a long provider snippet into `maxLength` by keeping the windows that best
 * match the query instead of the head of the page (which is often navigation).
 * Returns undefined when nothing matches, so callers keep head truncation.
 */
export function focusSnippet(text, query, maxLength) {
    if (!query.trim() || text.replace(/\s+/g, " ").trim().length <= maxLength)
        return undefined;
    const target = Math.max(120, Math.floor(maxLength / 2));
    const picked = selectPassages(stripMarkupNoise(text), query, 4, target);
    if (picked.length === 0)
        return undefined;
    let out = "";
    for (const passage of picked) {
        const clean = passage.replace(/\s+/g, " ").trim();
        const next = out ? `${out} … ${clean}` : clean;
        if (next.length > maxLength) {
            if (!out)
                out = `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
            break;
        }
        out = next;
    }
    return out || undefined;
}
/** Markdown images and link targets, and stray inline HTML tags, are noise inside passages. */
export function stripMarkupNoise(text) {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
        .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "");
}
const DROP_BLOCKS = /<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
export function stripBoilerplateHtml(html) {
    return html.replace(/<!--[\s\S]*?-->/g, " ").replace(DROP_BLOCKS, " ");
}
function decodeEntities(text) {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
export function fallbackHtmlToText(html) {
    return decodeEntities(stripBoilerplateHtml(html)
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n\n")
        .replace(/<[^>]+>/g, " "));
}
/** Hostname without IPv6 brackets or a trailing root dot, lowercased. */
function normalizeHost(hostname) {
    return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
/** True when `host` is a blocked TLD or under one (label bounded: `notsu.example` is not `.su`). */
export function hostHasBlockedTld(host, blockedTlds) {
    const h = normalizeHost(host);
    return blockedTlds.some((tld) => h === tld || h.endsWith(`.${tld}`));
}
// Known GitHub copy sites: `<host>/<owner>/<repo>` pages that mirror a real repo.
const GITHUB_COPY_HOSTS = ["tvwatch.su"];
// Resolver answers that mean "blocked here": unspecified and loopback sinkholes.
const SINKHOLE_ADDRESS = /^(?:0\.0\.0\.0|127(?:\.\d+){3}|::|::1|::ffff:(?:0\.0\.0\.0|127(?:\.\d+){3}))$/i;
/** Skip reason decided from the URL alone. Never touches DNS. */
function staticSkipReason(url, config) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return "invalid-url";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        return "unsupported-scheme";
    const host = normalizeHost(u.hostname);
    if (u.protocol === "http:" && isIP(host))
        return "raw-ip-http";
    const onHost = (domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));
    if (config.skipGithubCopies && onHost(GITHUB_COPY_HOSTS) && u.pathname.split("/").filter(Boolean).length >= 2) {
        return "github-copy";
    }
    if (hostHasBlockedTld(host, config.blockedTlds))
        return "blocked-tld";
    if (onHost(config.skipDomains))
        return "skip-domain";
    return undefined;
}
/** Skip reason from the local resolver: blocked answers and failures both mean "do not fetch". */
async function resolverSkipReason(host, resolveHost, signal) {
    try {
        const addresses = await raceAbort(resolveHost(host), signal);
        if (addresses.length === 0 || addresses.some((address) => SINKHOLE_ADDRESS.test(address)))
            return "resolver-blocked";
        return undefined;
    }
    catch (error) {
        // NXDOMAIN and REFUSED have the same safe outcome as a block. Other
        // resolver failures (timeouts included) also keep the hit but never fetch.
        const code = error?.code;
        return code && ["ENOTFOUND", "ENODATA", "EREFUSED"].includes(code) ? "resolver-blocked" : "resolver-unavailable";
    }
}
let sdkFetchPromise;
let sdkExtractPromise;
async function loadSdkFetch() {
    sdkFetchPromise ??= import("openclaw/plugin-sdk/ssrf-runtime")
        .then((mod) => mod.fetchWithSsrFGuard)
        .catch(() => undefined);
    return await sdkFetchPromise;
}
async function loadSdkExtract() {
    sdkExtractPromise ??= import("openclaw/plugin-sdk/web-content-extractor")
        .then((mod) => mod)
        .catch(() => undefined);
    return await sdkExtractPromise;
}
/** Charset from the Content-Type header, else from a <meta> tag near the top of the page; utf-8 otherwise. */
export function decodePageBytes(bytes, contentType) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const label = /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
        /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head)?.[1] ??
        "utf-8";
    try {
        return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(bytes);
    }
    catch {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
}
async function readCapped(response, maxBytes) {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done)
                break;
            chunks.push(value);
            total += value.byteLength;
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
    return decodePageBytes(Buffer.concat(chunks).subarray(0, maxBytes), response.headers.get("content-type") ?? "");
}
/** Default deps: OpenClaw's SSRF-guarded fetch (blocks private and internal addresses). */
export const defaultPageReaderDeps = {
    async resolveHost(hostname) {
        return (await lookup(hostname, { all: true })).map((r) => r.address);
    },
    async fetchPage(url, opts) {
        const guarded = await loadSdkFetch();
        if (!guarded)
            throw new Error("guarded fetch unavailable");
        const blockedTlds = opts.blockedTlds ?? [];
        const firstHost = normalizeHost(new URL(url).hostname);
        const res = await guarded({
            url,
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
            maxRedirects: 3,
            // Called for every hop, redirects included: a redirect into a blocked
            // TLD fails here without a DNS query, and no hop may jump to a raw IP.
            lookupFn: async (hostname, options) => {
                const host = normalizeHost(hostname);
                if (hostHasBlockedTld(host, blockedTlds)) {
                    throw Object.assign(new Error(`blocked TLD: ${host}`), { code: "ENOTFOUND" });
                }
                if (isIP(host) && host !== firstHost)
                    throw new Error("redirect to a raw IP address refused");
                return await lookup(hostname, options);
            },
            init: {
                signal: opts.signal,
                headers: {
                    accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
                    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                },
            },
        });
        try {
            const contentType = res.response.headers.get("content-type") ?? "";
            const body = /html|text\/plain|xml/i.test(contentType) || !contentType ? await readCapped(res.response, opts.maxBytes) : "";
            return { status: res.response.status, contentType, body, finalUrl: res.finalUrl };
        }
        finally {
            await res.release().catch(() => undefined);
        }
    },
    async htmlToText(html) {
        const sdk = await loadSdkExtract();
        const stripped = stripBoilerplateHtml(html);
        let text = "";
        if (sdk?.htmlToMarkdown) {
            try {
                const md = sdk.htmlToMarkdown(stripped);
                const resolved = (md instanceof Promise ? await md : md);
                text = typeof resolved === "string" ? resolved : String(resolved?.text ?? "");
            }
            catch {
                text = "";
            }
        }
        if (!text.trim())
            text = fallbackHtmlToText(html);
        // Drop markdown link targets and images: they are noise inside passages.
        text = stripMarkupNoise(text);
        return sdk?.stripInvisibleUnicode ? sdk.stripInvisibleUnicode(text) : text;
    },
};
/**
 * Read up to `topK` results in parallel inside one wall-clock budget and attach
 * `passages` to each result that yielded query-relevant text. Mutates `results`.
 */
export async function readTopPages(params) {
    const { config, query } = params;
    const deps = params.deps ?? defaultPageReaderDeps;
    const budget = Math.max(0, Math.min(config.timeoutMs, params.deadlineAt ? params.deadlineAt - Date.now() : config.timeoutMs));
    if (!config.enabled || budget < 250 || params.signal?.aborted)
        return [];
    const targets = [];
    const skipped = [];
    const controller = new AbortController();
    const onAbort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("read budget exceeded")), budget);
    try {
        // Pick pages before any fetch so skipped hits never consume a slot. Static
        // policy never invokes DNS. The resolver check runs in parallel for just
        // enough candidates to fill the free slots, refilling after skips. All
        // lookups share at most half the budget so a slow resolver cannot starve
        // the reads; a host not verified in time is skipped, never fetched.
        const resolveHost = deps.resolveHost;
        const lookupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(250, Math.floor(budget / 2)))]);
        const skip = (url, reason) => skipped.push({ url, ok: false, tookMs: 0, passages: 0, skipped: reason });
        let next = 0;
        while (targets.length < config.topK && next < params.results.length && !controller.signal.aborted) {
            const round = [];
            while (next < params.results.length && round.length < config.topK - targets.length) {
                const result = params.results[next++];
                const reason = staticSkipReason(result.url, config);
                if (reason)
                    skip(result.url, reason);
                else
                    round.push(result);
            }
            const reasons = resolveHost
                ? await Promise.all(round.map((r) => resolverSkipReason(normalizeHost(new URL(r.url).hostname), resolveHost, lookupSignal)))
                : round.map(() => undefined);
            round.forEach((result, i) => {
                const reason = reasons[i];
                if (reason)
                    skip(result.url, reason);
                else if (!controller.signal.aborted)
                    targets.push(result);
            });
        }
        const found = new Map();
        const settled = await Promise.all(targets.map(async (result) => {
            const started = Date.now();
            try {
                const page = await raceAbort(deps.fetchPage(result.url, {
                    timeoutMs: budget,
                    maxBytes: config.maxBytes,
                    signal: controller.signal,
                    blockedTlds: config.blockedTlds,
                }), controller.signal);
                if (page.status < 200 || page.status >= 300)
                    throw new Error(`HTTP ${page.status}`);
                if (!page.body)
                    throw new Error(`unsupported content type ${page.contentType || "unknown"}`);
                const text = /html|xml/i.test(page.contentType) || /^\s*</.test(page.body)
                    ? await deps.htmlToText(page.body, page.finalUrl)
                    : page.body;
                // Page text is untrusted: neutralize boundary and role lookalikes first.
                const passages = selectPassages(neutralizeUntrustedText(text), query, config.maxPassages, config.passageChars);
                if (controller.signal.aborted)
                    throw new Error("read budget exceeded");
                if (passages.length > 0)
                    found.set(result, passages);
                return { url: result.url, ok: passages.length > 0, tookMs: Date.now() - started, passages: passages.length, ...(passages.length ? {} : { error: "no relevant passages" }) };
            }
            catch (error) {
                return {
                    url: result.url,
                    ok: false,
                    tookMs: Date.now() - started,
                    passages: 0,
                    error: sanitizeErrorText(error instanceof Error ? error.message : String(error)).slice(0, 160),
                };
            }
        }));
        // Mirror pages (the same doc on two URLs or versions) yield the same passage:
        // keep it on the best-ranked result only.
        const seen = new Set();
        targets.forEach((result, index) => {
            const kept = (found.get(result) ?? []).filter((passage) => {
                const key = passage.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 200);
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
            if (kept.length > 0)
                result.passages = kept;
            settled[index].passages = kept.length;
        });
        return [...skipped, ...settled];
    }
    finally {
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
    }
}
/**
 * One log line per search: how many pages were read and which hits were skipped
 * (host and reason only; no paths or query strings).
 */
export function summarizePageReads(reads) {
    if (!reads || reads.length === 0)
        return undefined;
    const fetched = reads.filter((r) => !r.skipped);
    const skipped = reads.filter((r) => r.skipped);
    const hostOf = (url) => {
        try {
            return normalizeHost(new URL(url).hostname) || "invalid-url";
        }
        catch {
            return "invalid-url";
        }
    };
    const detail = skipped.map((r) => `${hostOf(r.url)} ${r.skipped}`).join(", ");
    return `search-fusion: page reader fetched ${fetched.length} (${fetched.filter((r) => r.ok).length} with passages), skipped ${skipped.length}${detail ? `: ${detail}` : ""}`;
}
function raceAbort(promise, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error("aborted"));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((v) => {
            signal.removeEventListener("abort", onAbort);
            resolve(v);
        }, (e) => {
            signal.removeEventListener("abort", onAbort);
            reject(e);
        });
    });
}
