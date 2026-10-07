import { describe, expect, it } from "vitest";
import { decide, describeHttpFailure, originOf, type S1Fetch, type S1Response } from "./decision.js";
import { judgeReadiness } from "./readiness-judge.js";

const Q = { risk: { type: "boolean" as const, instructions: "is it risky?" } };
const res = (status: number, body?: unknown, bodyThrows = false): S1Response => ({ ok: status >= 200 && status < 300, status, json: async () => { if (bodyThrows) throw new Error("not json"); return body; } });
const run = (fetch: S1Fetch, timeoutMs = 25) => decide({ state: {}, questions: Q }, { fetch, timeoutMs, url: "http://s1.example:8009/base?token=SECRET" });

describe("#311: S1 failures name the condition", () => {
  it("a timeout says so, with the bound, the elapsed time and the origin (never the path/query)", async () => {
    const hang: S1Fetch = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("This operation was aborted"))));
    const r = await run(hang);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^S1 timed out after 25ms \(elapsed \d+ms\) at http:\/\/s1\.example:8009$/);
    expect(r.error).not.toMatch(/aborted/);
    expect(r.error).not.toContain("SECRET");
  });
  it("an unreachable endpoint says so, with the code", async () => {
    const refused: S1Fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const r = await run(refused, 1000);
    expect(r).toMatchObject({ ok: false, error: "S1 unreachable at http://s1.example:8009 (ECONNREFUSED)" });
  });
  it("an unclassified transport error keeps the 'request failed' wording with the message", async () => {
    const r = await run(async () => { throw new Error("weird"); }, 1000);
    expect(r).toMatchObject({ ok: false, error: "S1 request failed: weird" });
  });
  it("a 4xx surfaces the status AND the endpoint's own validation text", async () => {
    const r = await run(async () => res(422, { detail: 'unknown type "noul" for question risk' }), 1000);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toBe('S1 rejected the request: HTTP 422 unknown type "noul" for question risk');
  });
  it("a 5xx says server error; an unreadable body falls back to the status alone", async () => {
    const a = await run(async () => res(503, { error: "model loading" }), 1000);
    if (!a.ok) expect(a.error).toMatch(/^S1 server error: HTTP 503 model loading \(elapsed \d+ms\)$/);
    const b = await run(async () => res(500, undefined, true), 1000);
    if (!b.ok) expect(b.error).toMatch(/^S1 server error: HTTP 500 \(elapsed/);
  });
  it("the body detail is redacted and bounded (it is untrusted text that lands in logs)", async () => {
    const msg = await describeHttpFailure(res(400, { detail: "bad key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " + "x".repeat(1000) }), 5);
    expect(msg).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(msg.length).toBeLessThan(400);
  });
  it("the three conditions are distinguishable", async () => {
    const hang: S1Fetch = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const errs = await Promise.all([run(hang), run(async () => { throw Object.assign(new TypeError("x"), { cause: { code: "ENOTFOUND" } }); }, 1000), run(async () => res(422, { detail: "bad" }), 1000)]);
    const msgs = errs.map((e) => (e.ok ? "" : e.error));
    expect(new Set(msgs.map((m) => m.split(" ").slice(0, 3).join(" "))).size).toBe(3);
  });
  it("originOf drops path and query", () => {
    expect(originOf("http://127.0.0.1:8009/v1/systemone?x=1")).toBe("http://127.0.0.1:8009");
    expect(originOf("not a url")).toBe("the configured S1 endpoint");
  });
});

describe("#311: the readiness fallbackReason keeps the decider's precise error", () => {
  const spec = { goal: "Add `f` to src/a.ts", acceptance: ["f() returns 42"], verify: { command: "./scripts/verify.sh" }, scope: { files: ["src/a.ts"] } } as never;
  it("an S1 error string passes through unchanged (prefixed once)", async () => {
    const j = (await judgeReadiness({ spec }, async () => ({ ok: false, error: "S1 rejected the request: HTTP 422 unknown type" })))!;
    expect(j.source).toBe("baseline");
    expect(j.fallbackReason).toBe("S1 error: S1 rejected the request: HTTP 422 unknown type");
  });
});
