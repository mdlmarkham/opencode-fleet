import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneStateDir } from "./node/runtime.js";
import { handleOpencodeRun } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { OP_MIN_PROTOCOL, PROTOCOL_VERSION } from "./protocol.js";

const DAY = 86_400_000;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet63b-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const put = (name: string, ageDays: number) => {
  const p = join(dir, name);
  writeFileSync(p, "x");
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
};

describe("#63: pruneStateDir", () => {
  it("removes a finished run's files only when ALL are older than the cutoff", async () => {
    for (const f of ["run-old.json", "run-old.sh", "run-old.log", "done-old.json"]) put(f, 10);
    for (const f of ["run-new.json", "run-new.sh"]) put(f, 10);
    put("done-new.json", 1);
    const r = await pruneStateDir(dir, 7 * DAY, new Set());
    expect(r.removedRuns).toEqual(["old"]);
    expect(existsSync(join(dir, "run-old.sh"))).toBe(false);
    expect(existsSync(join(dir, "done-old.json"))).toBe(false);
    for (const f of ["run-new.json", "run-new.sh", "done-new.json"]) expect(existsSync(join(dir, f)), f).toBe(true);
  });
  it("never touches a run whose script is alive, however old its files are", async () => {
    for (const f of ["run-live.json", "run-live.sh", "run-live.log"]) put(f, 90);
    const r = await pruneStateDir(dir, 7 * DAY, new Set(["live"]));
    expect(r.keptAlive).toEqual(["live"]);
    expect(r.removedRuns).toEqual([]);
    expect(existsSync(join(dir, "run-live.sh"))).toBe(true);
  });
  it("leaves unrelated files alone and prunes stale transfer staging", async () => {
    put("notes.txt", 100);
    put("run-x.sh.bak", 100);
    put("xfer-t1.bundle", 30);
    mkdirSync(join(dir, "xfer-t2"));
    writeFileSync(join(dir, "xfer-t2", "chunk"), "x");
    const old = (Date.now() - 30 * DAY) / 1000;
    utimesSync(join(dir, "xfer-t2", "chunk"), old, old);
    utimesSync(join(dir, "xfer-t2"), old, old);
    const r = await pruneStateDir(dir, 7 * DAY, new Set());
    expect(r.removedTransfers.sort()).toEqual(["t1", "t2"]);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "run-x.sh.bak"))).toBe(true);
    expect(existsSync(join(dir, "xfer-t2"))).toBe(false);
  });
  it("does not follow a symlink: the link is removed, its target survives", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fleet63b-out-"));
    try {
      writeFileSync(join(outside, "precious"), "keep");
      symlinkSync(outside, join(dir, "xfer-evil"));
      const r = await pruneStateDir(dir, 0, new Set(), Date.now() + DAY);
      expect(r.errors).toEqual([]);
      expect(existsSync(join(dir, "xfer-evil"))).toBe(false);
      expect(existsSync(join(outside, "precious"))).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("a missing state dir is not an error", async () => {
    expect(await pruneStateDir(join(dir, "nope"), DAY, new Set())).toMatchObject({ removedRuns: [], errors: [] });
  });
});

describe("#63: the state.prune op", () => {
  const prev = process.env.FLEET_STATE_DIR;
  afterEach(() => { if (prev === undefined) delete process.env.FLEET_STATE_DIR; else process.env.FLEET_STATE_DIR = prev; });
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__PRUNE__", op: "state.prune", cwd: "/", ...p })));
  it("prunes through the node handler, with a cwd of '/', and rejects silly retention", async () => {
    const state = join(dir, "state");
    mkdirSync(state, { mode: 0o700 });
    process.env.FLEET_STATE_DIR = state;
    writeFileSync(join(state, "run-old.sh"), "x");
    utimesSync(join(state, "run-old.sh"), 1, 1);
    const r = await call({ olderThanDays: 7 });
    expect(r).toMatchObject({ ok: true, removedRuns: ["old"] });
    expect((await call({ olderThanDays: 0 })).ok).toBe(false);
    expect((await call({ olderThanDays: 99999 })).ok).toBe(false);
  });
});

describe("#63: the gateway never sends state.prune to a node that predates it", () => {
  const nodeOf = (pv: number) => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = (params: Record<string, unknown>): PolicyCtx => ({
      params, node: { nodeId: "n1" },
      invokeNode: async (a: { params: Record<string, unknown> }) => {
        seen.push(a.params);
        return { ok: true as const, payload: { ok: true, ...(pv > 0 ? { protocol: pv } : {}) } };
      },
    } as unknown as PolicyCtx);
    return { seen, ctx };
  };
  for (const pv of [0, 1, 2]) {
    it(`a protocol-${pv} node is refused by the gateway; only the probe is sent`, async () => {
      const n = nodeOf(pv);
      const r = await handleOpencodeRunPolicy(n.ctx({ prompt: "__PRUNE__", op: "state.prune", cwd: "/", olderThanDays: 7 }), newProtocolCache());
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/cannot honor op state.prune/);
      expect(n.seen).toHaveLength(1);
      expect(n.seen[0]).toMatchObject({ prompt: "__RUN_STATUS__" });
    });
  }
  it("a current node gets it, stamped with the minimum protocol", async () => {
    const n = nodeOf(PROTOCOL_VERSION);
    const r = await handleOpencodeRunPolicy(n.ctx({ prompt: "__PRUNE__", op: "state.prune", cwd: "/", olderThanDays: 7 }), newProtocolCache());
    expect(r.ok).toBe(true);
    expect(n.seen[1]).toMatchObject({ op: "state.prune", protocol: OP_MIN_PROTOCOL["state.prune"] });
  });
});
