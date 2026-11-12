import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Capture the options the reader hands to OpenClaw's guarded fetch.
const calls: Array<Record<string, any>> = [];
mock.module("openclaw/plugin-sdk/ssrf-runtime", {
  cache: true,
  namedExports: {
    fetchWithSsrFGuard: async (params: Record<string, any>) => {
      calls.push(params);
      return {
        response: new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } }),
        finalUrl: params.url,
        release: async () => {},
      };
    },
  },
});

const { defaultPageReaderDeps } = await import("../src/page-reader.js");

test("guarded fetch gets a per-hop lookup that refuses blocked TLDs and raw-IP redirect hops before DNS", async () => {
  const controller = new AbortController();
  await defaultPageReaderDeps.fetchPage("https://192.0.2.10/doc", { timeoutMs: 1000, maxBytes: 100_000, signal: controller.signal, blockedTlds: ["su"] });
  const lookupFn = calls.at(-1)?.lookupFn as (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;
  assert.equal(typeof lookupFn, "function");
  // Redirect into a blocked TLD (trailing dot and case folded): rejected as NXDOMAIN, no lookup.
  await assert.rejects(lookupFn("Mirror.TVWATCH.su.", { all: true }), (e: any) => e.code === "ENOTFOUND" && /blocked TLD/.test(e.message));
  // Redirect hop to a different raw IP is refused.
  await assert.rejects(lookupFn("198.51.100.4", { all: true }), /raw IP/);
  // The first hop's own literal still resolves (dns.lookup returns a literal as-is, no query).
  assert.deepEqual((await lookupFn("192.0.2.10", { all: true })).map((r) => r.address), ["192.0.2.10"]);
});

test("default resolver check returns every address (literal input needs no DNS query)", async () => {
  assert.deepEqual(await defaultPageReaderDeps.resolveHost?.("192.0.2.10"), ["192.0.2.10"]);
  assert.deepEqual(await defaultPageReaderDeps.resolveHost?.("2001:db8::8"), ["2001:db8::8"]);
});
