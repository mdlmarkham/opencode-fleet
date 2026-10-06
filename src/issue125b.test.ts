import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, tick, type TickDeps } from "./mission-runner.js";
import { createMission, loadMission, readJournal, setPhase } from "./mission-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet125b-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const specs = [{ id: "a", goal: "first", deps: [], scope: { files: ["a/"] } }, { id: "b", goal: "second", deps: ["a"], scope: { files: ["b/"] } }];
const start = async (limits = {}) => { await createMission(root, "m1", specs, { limits }); await setPhase(root, "m1", "awaiting-approval", "d"); await setPhase(root, "m1", "executing", "ok"); };
const rec = async () => { const m = await loadMission(root, "m1"); if (!m.ok) throw new Error(m.error); return m.record; };
const OK = { ok: true, verified: true as const };

/** A fake world: runs launched, outcomes the test releases. */
const world = () => {
  const w = { launches: [] as string[], finished: {} as Record<string, { runId?: string; signals: never }>, failLaunch: undefined as undefined | { error: string; ambiguous?: boolean }, known: {} as Record<string, string>, n: 0 };
  const deps: TickDeps = {
    nowMs: () => 1_000_000,
    freeSlots: async () => ({ n1: 4 }),
    launch: async (a) => { if (w.failLaunch) { const f = w.failLaunch; return { ok: false, ...f }; } w.launches.push(`${a.specId}#${a.key}`); const runId = `run-${a.specId}-${++w.n}`; w.known[a.key] = runId; return { ok: true, runId }; },
    reconcile: async (a) => (w.known[a.key] ? { state: "running", runId: w.known[a.key]! } : { state: "unknown" }),
    poll: async (running) => Object.fromEntries(running.filter((r) => w.finished[r.specId]).map((r) => [r.specId, w.finished[r.specId]!])),
  };
  return { w, deps };
};

describe("#125: durable tick", () => {
  it("runs a mission to delivery: dependency order, outcomes applied, journal mirrored with run ids", async () => {
    await start();
    const { w, deps } = world();
    let r = await tick(root, "m1", deps);
    expect(r).toMatchObject({ launched: ["a"], status: "running" });
    expect((await rec()).supervisor.specs.b!.status).toBe("pending");
    w.finished.a = { signals: OK as never };
    r = await tick(root, "m1", deps);
    expect(r.outcomes).toEqual(["a"]);
    expect(r.launched).toEqual(["b"]);
    w.finished.b = { signals: OK as never };
    r = await tick(root, "m1", deps);
    expect(r).toMatchObject({ status: "complete", phase: "delivering" });
    const j = await readJournal(root, "m1");
    expect(j.map((e) => e.type)).toEqual(expect.arrayContaining(["dispatch-intent", "dispatched", "verified", "phase"]));
    expect(j.find((e) => e.type === "verified" && e.runId)).toBeTruthy();
  });
  it("a tick with nothing to do changes nothing (idempotent); a non-executing mission is skipped", async () => {
    await start();
    const { deps } = world();
    await tick(root, "m1", deps);
    const rev = (await rec()).rev;
    await tick(root, "m1", deps);
    expect((await rec()).rev).toBe(rev);
    await createMission(root, "m2", specs);
    expect(await tick(root, "m2", deps)).toMatchObject({ skipped: expect.stringContaining("designing") });
  });
  it("the launch intent is persisted BEFORE the launch (a crash mid-launch is recoverable)", async () => {
    await start();
    const { w, deps } = world();
    let seenDuringLaunch: string | undefined;
    const d2: TickDeps = { ...deps, launch: async (a, record) => { seenDuringLaunch = record.supervisor.specs[a.specId]!.status; throw new Error("process died"); } };
    const r = await tick(root, "m1", d2);
    expect(seenDuringLaunch).toBe("dispatching");
    expect(r.launched).toEqual([]);
    expect((await rec()).supervisor.specs.a).toMatchObject({ status: "dispatching", attempts: 1 });
    expect((await readJournal(root, "m1")).some((e) => e.type === "launch-unconfirmed")).toBe(true);
    // Issue #244 review fix: a crash MID-LAUNCH is ambiguous — the node may be running it. The next
    // tick reconciles but must NEVER void the intent into a relaunch: it escalates once for a human.
    // (The old pin expected void+relaunch here — precisely the double-dispatch defect the independent
    // review reproduced; see issue125d.test.ts for the recovery matrix.)
    const r2 = await tick(root, "m1", deps);
    expect(r2.reconciled).toEqual(["a"]);
    expect(w.launches).toHaveLength(0); // reconcile never relaunches
    const r3 = await tick(root, "m1", deps);
    expect(r3.launched).toEqual([]); // an ambiguous launch is never retried by the loop
    const spec = (await rec()).supervisor.specs.a!;
    expect(spec.status).toBe("escalated");
    expect(spec.attempts).toBe(1);
    expect((await readJournal(root, "m1")).some((e) => e.type === "launch-unresolved")).toBe(true);
  });
  it("reconcile finds a run that DID launch and adopts it instead of relaunching", async () => {
    await start();
    const { w, deps } = world();
    const d2: TickDeps = { ...deps, launch: async (a) => { w.known[a.key] = "run-ghost"; throw new Error("ack timeout"); } };
    await tick(root, "m1", d2);
    await tick(root, "m1", deps);
    expect((await rec()).supervisor.specs.a).toMatchObject({ status: "running", runId: "run-ghost" });
    expect(w.launches).toHaveLength(0);
  });
  it("a refused launch voids the intent immediately; an unverified exit-0 is a failure to repair, not success", async () => {
    await start({ maxRepairs: 0, maxReplans: 0 });
    const { w, deps } = world();
    w.failLaunch = { error: "no-capacity" };
    await tick(root, "m1", deps);
    expect((await rec()).supervisor.specs.a).toMatchObject({ status: "pending", attempts: 0 });
    w.failLaunch = undefined;
    await tick(root, "m1", deps);
    w.finished.a = { signals: { ok: true, verified: null } as never };
    const r = await tick(root, "m1", deps);
    expect(r.outcomes).toEqual(["a"]);
    expect((await rec()).supervisor.specs.a!.status).not.toBe("verified");
  });
  it("a spec that exhausts its repairs escalates and the mission blocks with the evidence journaled", async () => {
    await start({ maxRepairs: 0, maxReplans: 0 });
    const { w, deps } = world();
    await tick(root, "m1", deps);
    w.finished.a = { signals: { ok: false, verified: false, evidence: "test X fails" } as never };
    const r = await tick(root, "m1", deps);
    expect(r).toMatchObject({ status: "escalated", phase: "blocked" });
    const j = await readJournal(root, "m1");
    expect(j.find((e) => e.type === "escalation")).toMatchObject({ evidence: expect.stringContaining("test X fails") });
  });
  it("a hard stop halts before any new work and blocks the mission", async () => {
    await start();
    const { w, deps } = world();
    const r = await tick(root, "m1", { ...deps, guard: async () => [{ kind: "budget-exhausted", evidence: "$30 >= $20" }] });
    expect(r).toMatchObject({ halted: [{ kind: "budget-exhausted" }], phase: "blocked", launched: [] });
    expect(w.launches).toHaveLength(0);
    expect((await readJournal(root, "m1")).find((e) => e.type === "hard-stop")).toMatchObject({ evidence: "$30 >= $20" });
    expect(await tick(root, "m1", deps)).toMatchObject({ skipped: expect.stringContaining("blocked") });
  });
  it("a flawed spec asks for a replan once, journaled, not every tick", async () => {
    await start({ maxRepairs: 0, maxReplans: 2 });
    const { w, deps } = world();
    await tick(root, "m1", deps);
    w.finished.a = { signals: { ok: false, verified: null, handRaised: true, question: "which db?" } as never };
    delete w.finished.a;
    w.finished.a = { signals: { ok: false, verified: null, handRaised: true, question: "which db?" } as never };
    const r = await tick(root, "m1", deps);
    expect(r.replanRequested).toEqual(["a"]);
    await tick(root, "m1", deps);
    expect((await readJournal(root, "m1")).filter((e) => e.type === "replan-requested")).toHaveLength(1);
  });
  it("applyEvent ignores an event for an unknown spec without corrupting the record", async () => {
    await start();
    const r = await applyEvent(root, "m1", { type: "outcome", specId: "zz", signals: OK });
    expect(r.ok).toBe(true);
    expect((await rec()).supervisor.journal.some((e) => e.type === "ignored")).toBe(true);
  });
});
