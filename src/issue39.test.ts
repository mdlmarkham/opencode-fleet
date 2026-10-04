import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STALE_AFTER_MS, liveRuns, noCapacity, slotLimit, staleAfter } from "./capacity.js";
import { loadLedger, reserveRun, upsertRun, type LedgerEntry } from "./ledger.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({ runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-04T11:59:00Z", updatedAt: "2026-10-04T11:59:00Z", state: "running", ...over });

describe("#39: slot limits", () => {
  it("node setting beats the global default; neither means unlimited; bad values are errors", () => {
    expect(slotLimit(undefined, undefined)).toEqual({ ok: true });
    expect(slotLimit({ maxConcurrentPerNode: 3 }, undefined)).toEqual({ ok: true, limit: 3 });
    expect(slotLimit({ maxConcurrentPerNode: 3 }, { maxConcurrent: 1 })).toEqual({ ok: true, limit: 1 });
    for (const bad of [0, -1, 1.5, "2", 65, null]) {
      expect(slotLimit({ maxConcurrentPerNode: bad }, undefined).ok, String(bad)).toBe(false);
      expect(slotLimit(undefined, { maxConcurrent: bad }).ok, String(bad)).toBe(false);
    }
  });
  it("staleAfterMs has a sane default and floor", () => {
    expect(staleAfter(undefined)).toBe(DEFAULT_STALE_AFTER_MS);
    expect(staleAfter({ staleAfterMs: 10 })).toBe(DEFAULT_STALE_AFTER_MS);
    expect(staleAfter({ staleAfterMs: 120_000 })).toBe(120_000);
  });
  it("liveRuns counts only running entries on that node and splits out stale ones", () => {
    const runs = [
      entry({ runId: "a" }),
      entry({ runId: "b", state: "completed" }),
      entry({ runId: "c", node: "other" }),
      entry({ runId: "old", updatedAt: "2026-10-04T00:00:00Z", startedAt: "2026-10-04T00:00:00Z" }),
      entry({ runId: "byid", node: "n-dev2" }),
    ];
    const r = liveRuns(runs, ["dev2", "n-dev2"], NOW, 6 * 3600_000);
    expect(r.live.map((x) => x.runId)).toEqual(["a", "byid"]);
    expect(r.stale.map((x) => x.runId)).toEqual(["old"]);
  });
  it("noCapacity is retryable and names the runs holding the slots", () => {
    expect(noCapacity("dev2", 1, [entry()])).toMatchObject({ ok: false, retryable: true, reason: "no-capacity", limit: 1, running: ["r1"] });
  });
});

describe("#39: reserveRun is atomic", () => {
  it("N concurrent reservations for a limit of K: exactly K win, none over", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-"));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      reserveRun(root, entry({ runId: `r${i}` }), { nodeNames: ["dev2"], limit: 3, staleAfterMs: 3600_000, now: NOW })));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await loadLedger(root)).filter((r) => r.state === "running")).toHaveLength(3);
  });
  it("other nodes, finished runs and stale runs do not hold a slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-"));
    await upsertRun(root, entry({ runId: "other", node: "elsewhere" }));
    await upsertRun(root, entry({ runId: "done", state: "completed" }));
    await upsertRun(root, entry({ runId: "stale", updatedAt: "2026-10-03T00:00:00Z", startedAt: "2026-10-03T00:00:00Z" }));
    const r = await reserveRun(root, entry({ runId: "new" }), { nodeNames: ["dev2"], limit: 1, staleAfterMs: 3600_000, now: NOW });
    expect(r.ok).toBe(true);
    const full = await reserveRun(root, entry({ runId: "new2" }), { nodeNames: ["dev2"], limit: 1, staleAfterMs: 3600_000, now: NOW });
    expect(full).toMatchObject({ ok: false, running: [{ runId: "new" }] });
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the capacity tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#39: tools", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [
    { nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] },
    { nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] },
  ];
  const cfg = (extra: Record<string, unknown> = {}, node2: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false, ...node2 }, dev3: { roles: ["worker"], ssh: false } }, ...extra });
  const ok = () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
  const dispatch = (args: Record<string, unknown> = {}) => p!.call("fleet_dispatch", { cwd: "/w/proj", prompt: "do it", ...args }) as Promise<Record<string, any>>;

  it("no limit configured: dispatch is unchanged and never says no-capacity", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg(), invoke: ok });
    for (let i = 0; i < 4; i++) {
      const r = await dispatch({ node: "dev2" });
      expect(JSON.stringify(r)).not.toContain("no-capacity");
    }
    expect((await loadLedger(p.rootDir)).filter((e) => e.node === "dev2")).toHaveLength(4);
  });
  it("at the limit a dispatch returns a retryable no-capacity result and starts nothing", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 1 } }), invoke: ok });
    const first = await dispatch({ node: "dev2" });
    expect(first.dev2?.reason).toBeUndefined();
    const second = await dispatch({ node: "dev2" });
    expect(second.dev2).toMatchObject({ ok: false, retryable: true, reason: "no-capacity", limit: 1 });
    expect(second.dev2.running).toHaveLength(1);
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(1);
    expect((await loadLedger(p.rootDir)).filter((e) => e.node === "dev2")).toHaveLength(1);
  });
  it("fan-out: a full node is skipped with no-capacity while a free node still runs", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({}, { maxConcurrent: 1 }), invoke: ok });
    await dispatch({ node: "dev2" });
    const r = await dispatch({});
    expect(r.dev2).toMatchObject({ reason: "no-capacity" });
    expect(r.dev3?.reason).toBeUndefined();
    expect((await loadLedger(p.rootDir)).filter((e) => e.node === "dev3")).toHaveLength(1);
  });
  it("a finished run frees its slot; a stale one does not hold it", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 1, staleAfterMs: 60_000 } }), invoke: ok });
    await upsertRun(p.rootDir, entry({ runId: "old", updatedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z" }));
    expect((await dispatch({ node: "dev2" })).dev2?.reason).toBeUndefined();
    const ledger = await loadLedger(p.rootDir);
    const mine = ledger.find((e) => e.runId !== "old")!;
    await upsertRun(p.rootDir, { ...mine, state: "completed" });
    expect((await dispatch({ node: "dev2" })).dev2?.reason).toBeUndefined();
  });
  it("an invalid limit is a clear refusal for that node, never silently unlimited", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 0 } }), invoke: ok });
    const r = await dispatch({ node: "dev2" });
    expect(r.dev2).toMatchObject({ ok: false, error: expect.stringContaining("maxConcurrentPerNode") });
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(0);
  });
  it("fleet_capacity shows limit, holders, free slots and suspected-stale runs", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 2 } }), invoke: ok });
    await upsertRun(p.rootDir, entry({ runId: "live", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
    await upsertRun(p.rootDir, entry({ runId: "ancient", updatedAt: "2020-01-01T00:00:00Z", startedAt: "2020-01-01T00:00:00Z" }));
    const r = await p.call("fleet_capacity", {}) as { nodes: Array<{ node: string; limit: number | null; free: number | null; running: Array<{ runId: string }>; suspectedStale: Array<{ runId: string }> }> };
    const dev2 = r.nodes.find((n) => n.node === "dev2")!;
    expect(dev2).toMatchObject({ limit: 2, free: 1, running: [{ runId: "live" }], suspectedStale: [{ runId: "ancient" }] });
    expect(r.nodes.find((n) => n.node === "dev3")).toMatchObject({ limit: 2, free: 2, running: [] });
  });
});

describe.skipIf(!loaded)("#39: a refused launch does not leak its slot", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  it("the node says ok:false -> the entry is failed and the slot is free for the next dispatch", async () => {
    const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
    let refuse = true;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, capacity: { maxConcurrentPerNode: 1 } },
      invoke: () => (refuse ? nodeReply({ ok: false, error: "no such cwd" }) : nodeReply({ ok: true, detached: true, runId: "r", pid: 1 })),
    });
    const bad = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(bad.dev2).toMatchObject({ ok: false, error: expect.stringContaining("launch failed") });
    expect((await loadLedger(p.rootDir))[0]).toMatchObject({ state: "failed" });
    refuse = false;
    const good = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "y" }) as Record<string, any>;
    expect(good.dev2?.reason).toBeUndefined();
    expect(good.dev2).toMatchObject({ detached: true, pid: 1 });
  });
});
