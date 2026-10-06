import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, SENTINEL_OPS, isSentinelPrompt, nodeProtocolOf, opFromPrompt, resolveOp, sentinelForOp, stampProtocol } from "./protocol.js";
import { handleOpencodeRun } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { gatewaySrc } from "./testkit/src.js";

describe("issue #43: protocol op resolution", () => {
  it("maps every sentinel to an op and back", () => {
    for (const [sentinel, op] of Object.entries(SENTINEL_OPS)) {
      expect(opFromPrompt(sentinel)).toBe(op);
      expect(sentinelForOp(op)).toBe(sentinel);
      expect(isSentinelPrompt(sentinel)).toBe(true);
    }
    expect(opFromPrompt("fix the failing test")).toBe("run");
    expect(isSentinelPrompt("__NOPE__")).toBe(false);
    expect(isSentinelPrompt("toString")).toBe(false); // not an inherited property
  });
  it("without an op the prompt decides (legacy requests keep working)", () => {
    expect(resolveOp({ prompt: "__DIFF__" })).toEqual({ ok: true, op: "diff" });
    expect(resolveOp({ prompt: "do work" })).toEqual({ ok: true, op: "run" });
  });
  it("an explicit op must agree with the prompt, in both directions", () => {
    expect(resolveOp({ op: "diff", prompt: "__DIFF__" })).toEqual({ ok: true, op: "diff" });
    expect(resolveOp({ op: "run", prompt: "do work" })).toEqual({ ok: true, op: "run" });
    // a task prompt cannot be promoted to a control op ...
    expect(resolveOp({ op: "xfer.unpack", prompt: "do work" }).ok).toBe(false);
    // ... and a control message cannot be smuggled in as an ordinary run
    expect(resolveOp({ op: "run", prompt: "__UNPACK__" }).ok).toBe(false);
    expect(resolveOp({ op: "bogus", prompt: "do work" }).ok).toBe(false);
    expect(resolveOp({ op: 7, prompt: "do work" }).ok).toBe(false);
  });
  it("stamps JSON results and leaves non-JSON alone; reads a node's version (0 when absent)", () => {
    expect(JSON.parse(stampProtocol('{"ok":true}'))).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
    expect(stampProtocol("plain text")).toBe("plain text");
    expect(stampProtocol("[1,2]")).toBe("[1,2]");
    expect(nodeProtocolOf({ protocol: 1 })).toBe(1);
    expect(nodeProtocolOf('{"protocol":1}')).toBe(1);
    expect(nodeProtocolOf({ ok: false })).toBe(0);
    expect(nodeProtocolOf({ protocol: "1" })).toBe(0);
    expect(nodeProtocolOf(undefined)).toBe(0);
  });
});

describe("issue #43: node handler (behavioral)", () => {
  let dir: string;
  const prev = { state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet43-"));
    process.env.FLEET_STATE_DIR = join(dir, "state");
    process.env.FLEET_ALLOWED_ROOTS = join(dir, "work");
  });
  afterEach(() => {
    process.env.FLEET_STATE_DIR = prev.state;
    process.env.FLEET_ALLOWED_ROOTS = prev.roots;
    if (prev.state === undefined) delete process.env.FLEET_STATE_DIR;
    if (prev.roots === undefined) delete process.env.FLEET_ALLOWED_ROOTS;
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));

  it("every response carries the protocol version", async () => {
    const r = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: "protocol-probe", op: "run.status" });
    expect(r.protocol).toBe(PROTOCOL_VERSION);
    expect(r.status).toBe("never-started");
    const bad = await call({ prompt: "x", cwd: "/" , op: "bogus" });
    expect(bad.ok).toBe(false);
    expect(bad.protocol).toBe(PROTOCOL_VERSION);
  });
  it("legacy requests without an op still work", async () => {
    const r = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: "nope" });
    expect(r).toMatchObject({ ok: false, status: "never-started", protocol: PROTOCOL_VERSION });
  });
  it("refuses an op that disagrees with the prompt, before any op runs", async () => {
    const r = await call({ prompt: "__UNPACK__", cwd: join(dir, "work", "x"), op: "run", transferId: "t", sha256: "0".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match/);
  });
  it("still enforces id validation and cwd confinement (#31) ahead of every op", async () => {
    expect((await call({ prompt: "__RUN_STATUS__", cwd: "/", runId: "../x", op: "run.status" })).error).toMatch(/invalid runId/);
    expect((await call({ prompt: "__RUN_STATUS__", cwd: "/", op: "run.status" })).error).toMatch(/runId required/);
    expect((await call({ prompt: "__UNPACK__", cwd: "/etc", transferId: "t", op: "xfer.unpack" })).error).toMatch(/refused/);
    expect((await call({ prompt: "fix it", cwd: "/etc", op: "run" })).error).toMatch(/refused/);
  });
  it("xfer.unpack demands a checksum even when everything else is valid", async () => {
    const r = await call({ prompt: "__UNPACK__", cwd: join(dir, "work", "repo"), transferId: "t1", op: "xfer.unpack" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sha256/);
  });
  it("rejects malformed params", async () => {
    expect(JSON.parse(await handleOpencodeRun("{not json"))).toMatchObject({ ok: false, protocol: PROTOCOL_VERSION });
    expect(JSON.parse(await handleOpencodeRun(null))).toMatchObject({ ok: false });
  });
  it("xfer.receive then xfer.send round trip through the real handler", async () => {
    const work = join(dir, "work");
    const rcv = await call({ prompt: "__RECEIVE__", cwd: "/", transferId: "rt1", op: "xfer.receive", chunks: [{ index: 0, data: "QUJD" }] });
    expect(rcv).toMatchObject({ ok: true, received: 1 });
    const again = await call({ prompt: "__RECEIVE__", cwd: "/", transferId: "rt1", op: "xfer.receive", chunks: [{ index: 0, data: "QUJD" }] });
    expect(again).toMatchObject({ ok: true, received: 1 });
    const conflict = await call({ prompt: "__RECEIVE__", cwd: "/", transferId: "rt1", op: "xfer.receive", chunks: [{ index: 0, data: "WFla" }] });
    expect(conflict.ok).toBe(false);
    void work;
  });
});

function fakeCtx(replies: Array<{ ok: boolean; message?: string; payload?: unknown }>, params: unknown, nodeId = "n1") {
  const calls: unknown[] = [];
  const ctx: PolicyCtx = {
    params,
    node: { nodeId },
    invokeNode: async (input) => {
      calls.push(input?.params);
      const r = replies.shift();
      if (!r) throw new Error("unexpected extra invoke");
      return r;
    },
  };
  return { ctx, calls };
}

describe("issue #43: gateway policy", () => {
  it("stamps the op on the forwarded request and returns the payload (a plain run needs no protocol)", async () => {
    const { ctx, calls } = fakeCtx([{ ok: true, payload: { ok: true, protocol: 1 } }], { prompt: "do work", cwd: "/w" });
    const r = await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(r).toEqual({ ok: true, payload: { ok: true, protocol: 1 } });
    expect(calls[0]).toMatchObject({ prompt: "do work", op: "run" });
    expect("protocol" in (calls[0] as object)).toBe(false);
  });
  it("derives the op from a sentinel prompt (legacy callers)", async () => {
    const { ctx, calls } = fakeCtx([{ ok: true, payload: {} }], { prompt: "__DIFF__", cwd: "/w" });
    await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(calls[0]).toMatchObject({ op: "diff" });
  });
  it("rejects an op that disagrees with the prompt and basic malformed requests", async () => {
    const mismatch = fakeCtx([], { prompt: "do work", cwd: "/w", op: "xfer.unpack" });
    expect((await handleOpencodeRunPolicy(mismatch.ctx, newProtocolCache())).ok).toBe(false);
    expect((await handleOpencodeRunPolicy(fakeCtx([], { prompt: "  ", cwd: "/w" }).ctx, newProtocolCache())).ok).toBe(false);
    expect((await handleOpencodeRunPolicy(fakeCtx([], { prompt: "x" }).ctx, newProtocolCache())).ok).toBe(false);
  });
  it("a non-default harness on a protocol-0 node is refused instead of silently running opencode", async () => {
    const { ctx, calls } = fakeCtx([{ ok: true, payload: { ok: false, status: "never-started" } }], { prompt: "do work", cwd: "/w", harness: "pi" });
    const r = await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/protocol 0/);
    expect(calls).toHaveLength(1); // only the probe; the task was never sent
    expect(calls[0]).toMatchObject({ prompt: "__RUN_STATUS__", op: "run.status" });
  });
  it("a non-default harness on a current node probes once, then runs; the version is cached", async () => {
    const cache = newProtocolCache();
    const a = fakeCtx([{ ok: true, payload: { protocol: 1 } }, { ok: true, payload: { ok: true, protocol: 1 } }], { prompt: "do work", cwd: "/w", harness: "pi" });
    expect((await handleOpencodeRunPolicy(a.ctx, cache)).ok).toBe(true);
    expect(a.calls).toHaveLength(2);
    const b = fakeCtx([{ ok: true, payload: { ok: true, protocol: 1 } }], { prompt: "more", cwd: "/w", harness: "pi" });
    expect((await handleOpencodeRunPolicy(b.ctx, cache)).ok).toBe(true);
    expect(b.calls).toHaveLength(1); // no second probe
  });
  it("the default harness never probes", async () => {
    const { ctx, calls } = fakeCtx([{ ok: true, payload: {} }], { prompt: "do work", cwd: "/w", harness: "opencode" });
    await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(calls).toHaveLength(1);
  });
  it("a cached version expires", async () => {
    const cache = newProtocolCache();
    let t = 0;
    const now = () => t;
    const first = fakeCtx([{ ok: true, payload: { protocol: 1 } }, { ok: true, payload: { protocol: 1 } }], { prompt: "x1", cwd: "/w", harness: "pi" });
    await handleOpencodeRunPolicy(first.ctx, cache, now);
    t = 10 * 60_000;
    const later = fakeCtx([{ ok: true, payload: { protocol: 1 } }, { ok: true, payload: { protocol: 1 } }], { prompt: "x2", cwd: "/w", harness: "pi" });
    await handleOpencodeRunPolicy(later.ctx, cache, now);
    expect(later.calls).toHaveLength(2); // probed again
  });
  it("a failed probe or node error is surfaced, not swallowed", async () => {
    const probeFail = fakeCtx([{ ok: false, message: "node offline" }], { prompt: "x", cwd: "/w", harness: "pi" });
    const r = await handleOpencodeRunPolicy(probeFail.ctx, newProtocolCache());
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/node offline/);
    const runFail = fakeCtx([{ ok: false, message: "boom" }], { prompt: "x", cwd: "/w" });
    expect(await handleOpencodeRunPolicy(runFail.ctx, newProtocolCache())).toEqual({ ok: false, message: "boom" });
  });
  it("fleet_dispatch rejects a task prompt that is a control sentinel", () => {
    const src = gatewaySrc();
    expect(src).toContain("is reserved for node control messages");
  });
});
