import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDeps, type World } from "./mission-node.js";
import { tick } from "./mission-runner.js";
import { createMission, loadMission, readJournal, setPhase } from "./mission-store.js";
import type { LedgerEntry } from "./ledger.js";

// Issue #244 (review findings, hand-fixed): three ways the durable tick could strand or duplicate work.
// These tests drive the REAL nodeDeps (mission-node.ts World injection) with a fake world whose
// ledger the loop cannot force — the exact crash windows the independent reviewer reproduced.

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet125d-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const task = (id: string) => ({ goal: `do ${id}`, acceptance: ["done"], verify: { command: "./v.sh" }, scope: { files: [`${id}/`] } });
const specs = [
  { id: "a", goal: "do a", deps: [], task: task("a"), scope: { files: ["a/"] } },
  { id: "b", goal: "do b", deps: ["a"], task: task("b"), scope: { files: ["b/"] } },
];
const entry = (o: Partial<LedgerEntry> & { runId: string }): LedgerEntry =>
  ({ node: "n1", cwd: "/w", prompt: "p", startedAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", state: "running", ...o }) as LedgerEntry;

const fakeWorld = () => {
  let NOW = 1_000_000;
  const w = {
    dispatched: [] as Array<Record<string, unknown>>,
    ledger: [] as LedgerEntry[],
    statusCalls: [] as string[],
    result: undefined as undefined | Record<string, unknown>,
    finish: {} as Record<string, Partial<LedgerEntry>>,
    advance: (ms: number) => { NOW += ms; },
  };
  const world: World = {
    nodes: async () => ["n1", "n2"],
    limitFor: (n) => (n === "n1" ? 1 : undefined),
    ledger: async () => w.ledger,
    dispatch: async (params) => {
      w.dispatched.push(params);
      if (w.result) return { [String(params.node)]: w.result };
      const runId = `run-${w.dispatched.length}`;
      w.ledger.push(entry({ runId, node: String(params.node), missionKey: String(params.missionKey) }));
      return { [String(params.node)]: { runId, detached: true } };
    },
    status: async (_n, runId) => {
      w.statusCalls.push(runId);
      const f = w.finish[runId];
      if (f) { const e = w.ledger.find((x) => x.runId === runId); if (e) Object.assign(e, f); }
    },
    nowMs: () => NOW,
  };
  return { w, world };
};

const start = async (opts: Record<string, unknown> = {}) => {
  await createMission(root, "m1", specs, { target: { cwd: "/w/proj" }, ...opts });
  await setPhase(root, "m1", "awaiting-approval", "d");
  await setPhase(root, "m1", "executing", "ok");
};
const rec = async () => {
  const m = await loadMission(root, "m1");
  if (!m.ok) throw new Error(m.error);
  return m.record;
};
const depsFor = async (world: World) => nodeDeps(root, await rec(), world);

describe("#125d: the node-backed loop recovers from the crash windows (issue #244 findings)", () => {
  it("a wall-clock timed-out run is terminal: the spec leaves running and gets ONE bounded repair, never a hold", async () => {
    const { w, world } = fakeWorld();
    await start();
    const deps = await depsFor(world);
    const t1 = await tick(root, "m1", deps);
    expect(t1.launched).toEqual(["a"]);
    expect(w.dispatched.length).toBe(1);
    // the node gives up on the run: wall-clock limit
    w.ledger[0]!.state = "timed-out";
    const t2 = await tick(root, "m1", deps);
    expect(t2.outcomes).toEqual(["a"]); // the timed-out run resolved
    const r2 = await rec();
    expect(r2.supervisor.specs.a!.status).toBe("running"); // the bounded repair launched in the same tick
    expect(w.dispatched.length).toBe(2); // exactly one bounded repair launch (maxRepairs honored)
    const jr2 = await readJournal(root, "m1");
    expect(jr2.some((e) => e.type === "repair" || e.type === "retry")).toBe(true);
    expect(jr2.some((e) => String(e.evidence ?? "").includes("wall-clock"))).toBe(true);
    // force the repair run to time out too: the limits hold — no third launch, a human is asked
    w.ledger.find((e) => e.runId === "run-2")!.state = "timed-out";
    const t3 = await tick(root, "m1", deps);
    expect(t3.outcomes).toEqual(["a"]);
    const r3 = await rec();
    expect(w.dispatched.length).toBe(2); // the bound held: no third launch
    expect(["needs-replan", "escalated"]).toContain(r3.supervisor.specs.a!.status);
  });

  it("an acknowledged run whose ledger write was lost is probed via status, then declared lost after the bound — never silently stranded", async () => {
    const { w, world } = fakeWorld();
    await start();
    const deps = await depsFor(world);
    const t1 = await tick(root, "m1", deps);
    expect(t1.launched).toEqual(["a"]);
    w.ledger.length = 0; // THE CRASH WINDOW: the node accepted the run, the manager lost the write
    // within the lost bound: probe (which reconciles the ledger as a side effect), don't panic
    const t2 = await tick(root, "m1", deps);
    expect(t2.outcomes).toEqual([]);
    const r2 = await rec();
    expect(r2.supervisor.specs.a!.status).toBe("running");
    expect(w.statusCalls.length).toBeGreaterThan(0); // the probe happened
    expect(w.dispatched.length).toBe(1); // and no panic relaunch
    // beyond the lost bound: declared lost, bounded repair takes over
    w.advance(901_000);
    const t3 = await tick(root, "m1", deps);
    expect(t3.outcomes).toEqual(["a"]); // declared lost after the bound
    const r3 = await rec();
    expect(r3.supervisor.specs.a!.status).toBe("running"); // the bounded repair launched in the same tick
    expect(w.dispatched.length).toBe(2); // bounded (exactly one re-attempt)
    const jr = await readJournal(root, "m1");
    expect(jr.some((e) => String(e.evidence ?? "").includes("lost"))).toBe(true);
  });

  it("an unconfirmed (ackPending) launch is NEVER voided into a relaunch: it escalates for a human", async () => {
    const { w, world } = fakeWorld();
    w.result = { ok: true, ackPending: true }; // the launch may have happened; no runId (node-agnostic: plan may pick either node)
    await start();
    const deps = await depsFor(world);
    const t1 = await tick(root, "m1", deps);
    expect(w.dispatched.length).toBe(1);
    let r = await rec();
    // t1 leaves the launch UNCONFIRMED and journaled (never failed, never relaunched):
    expect(r.supervisor.specs.a!.status).toBe("dispatching");
    expect((await readJournal(root, "m1")).some((e) => e.type === "launch-unconfirmed")).toBe(true);
    // the next tick reconciles the key: ambiguity detected -> escalate for a human
    await tick(root, "m1", deps);
    r = await rec();
    expect(w.dispatched.length).toBe(1); // THE POINT: no second dispatch while liveness is unknown
    expect(r.supervisor.specs.a!.status).toBe("escalated");
    const jr = await readJournal(root, "m1");
    expect(jr.some((e) => e.type === "launch-unresolved")).toBe(true);
    expect(jr.some((e) => e.type === "launch-unconfirmed")).toBe(true);
  });

  it("a clean refusal (dispatch refused, not ambiguous) still voids and retries through the bounded path", async () => {
    const { w, world } = fakeWorld();
    w.result = { ok: false, error: "policy-refused" };
    await start();
    const deps = await depsFor(world);
    const t1 = await tick(root, "m1", deps);
    expect(w.dispatched.length).toBe(1);
    const r = await rec();
    expect(r.supervisor.specs.a!.status).toBe("pending"); // voided (nothing launched), runnable again
    const jr = await readJournal(root, "m1");
    expect(jr.some((e) => e.type === "intent-void")).toBe(true);
  });
});