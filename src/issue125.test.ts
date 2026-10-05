import { describe, expect, it } from "vitest";
import {
  applyReplan, classifyFailure, declineReplan, dispatchKey, graphErrors, missionStatus, newMission, plan, reduce,
  type Action, type MissionSpec, type MissionState, type OutcomeSignals, type PlanContext, type PlanDiff,
} from "./mission-supervisor.js";

const spec = (id: string, deps: string[] = [], scope?: string[]): MissionSpec => ({ id, goal: `do ${id}`, deps, ...(scope ? { scope: { files: scope } } : {}) });
const PASS: OutcomeSignals = { ok: true, verified: true };
const GATE_FAIL = (why: string): OutcomeSignals => ({ ok: true, verified: false, evidence: why });
const FLAKY: OutcomeSignals = { ok: false, verified: null, endedBy: "idle-watchdog", error: "[stuck: no output for 120s]" };
const HAND_RAISE: OutcomeSignals = { ok: false, verified: null, handRaised: true, question: "which API shape do you want?" };
const CTX = (slots: Record<string, number> = { dev2: 4, dev3: 4 }): PlanContext => ({ freeSlots: slots, nowMs: 1_000 });
const mk = (specs: MissionSpec[], limits = {}) => { const r = newMission("m1", specs, limits); if (!r.ok) throw new Error(r.errors.join("; ")); return r.state; };

// ---------------------------------------------------------------------------
// A tiny world: a node that remembers launches (it survives a supervisor crash) and scripted outcomes.
// ---------------------------------------------------------------------------
type Script = Record<string, Array<OutcomeSignals>>;
class Crash extends Error {}
interface World { runs: Map<string, { runId: string; specId: string; attempt: number }>; launches: string[]; script: Script }
const newWorld = (script: Script): World => ({ runs: new Map(), launches: [], script });
const attemptOf = (key: string): number => Number(key.split(":").pop());
const outcomeFor = (w: World, key: string): OutcomeSignals => {
  const r = w.runs.get(key)!;
  const list = w.script[r.specId] ?? [PASS];
  return list[Math.min(r.attempt - 1, list.length - 1)]!;
};

/** The supervisor loop, as thin as it should be: persist after every reduce; effects between. */
function drive(start: MissionState, w: World, opts: { crashAt?: { n: number; phase: "after-intent" | "after-launch" }; decomposer?: (s: MissionState, specId: string) => PlanDiff | undefined; ctx?: PlanContext; maxTicks?: number } = {}): MissionState {
  let persisted = start;
  let nIntents = 0;
  let crashed = false;
  const save = (s: MissionState): MissionState => (persisted = JSON.parse(JSON.stringify(s)) as MissionState);
  for (let tick = 0; tick < (opts.maxTicks ?? 200); tick++) {
    try {
      let st = persisted;
      const actions: Action[] = plan(st, opts.ctx ?? CTX());
      for (const a of actions) {
        if (a.type === "dispatch") {
          st = save(reduce(st, { type: "dispatch-intent", specId: a.specId, node: a.node, key: a.key, nowMs: 1_000 }));
          nIntents++;
          if (opts.crashAt && !crashed && nIntents === opts.crashAt.n && opts.crashAt.phase === "after-intent") { crashed = true; throw new Crash(); }
          if (!w.runs.has(a.key)) { w.runs.set(a.key, { runId: `run-${a.key}`, specId: a.specId, attempt: attemptOf(a.key) }); w.launches.push(a.key); }
          if (opts.crashAt && !crashed && nIntents === opts.crashAt.n && opts.crashAt.phase === "after-launch") { crashed = true; throw new Crash(); }
          st = save(reduce(st, { type: "dispatched", specId: a.specId, runId: `run-${a.key}`, key: a.key }));
        } else if (a.type === "reconcile") {
          const found = w.runs.get(a.key);
          st = save(found ? reduce(st, { type: "dispatched", specId: a.specId, runId: found.runId, key: a.key }) : reduce(st, { type: "intent-void", specId: a.specId, key: a.key, reason: "the node has no run for this key: it never launched" }));
        } else if (a.type === "replan") {
          const diff = opts.decomposer?.(st, a.specId);
          if (!diff) st = save(declineReplan(st, a.specId, "no decomposer available"));
          else { const r = applyReplan(st, diff); st = save(r.ok ? r.state : declineReplan(st, a.specId, `replan refused: ${r.error}`)); }
        }
      }
      for (const s of Object.values(st.specs)) {
        if (s.status === "running" && s.dispatchKey && w.runs.has(s.dispatchKey)) st = save(reduce(st, { type: "outcome", specId: s.spec.id, runId: s.runId, signals: outcomeFor(w, s.dispatchKey) }));
      }
      const status = missionStatus(persisted, opts.ctx ?? CTX()).status;
      if (status !== "running") return persisted;
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      // Restart: all the supervisor has is what it persisted.
    }
  }
  throw new Error("mission did not settle");
}
const statuses = (s: MissionState): Record<string, string> => Object.fromEntries(Object.values(s.specs).map((x) => [x.spec.id, x.status]));

describe("#125: graph and classification", () => {
  it("refuses unknown dependencies, self-dependencies and cycles", () => {
    expect(graphErrors([spec("a", ["x"])])[0]).toContain("unknown spec x");
    expect(graphErrors([spec("a", ["a"])])[0]).toContain("itself");
    expect(graphErrors([spec("a", ["b"]), spec("b", ["a"])])[0]).toContain("cycle");
    expect(graphErrors([spec("a"), spec("b", ["a"])])).toEqual([]);
    expect(newMission("m", [spec("a", ["b"]), spec("b", ["a"])])).toMatchObject({ ok: false });
    expect(newMission("bad id!", [spec("a")])).toMatchObject({ ok: false });
    expect(newMission("m", [spec("a")], { maxParallel: 0 })).toMatchObject({ ok: false });
  });
  it("classifies deterministically: hand-raise, relay/env, timeouts, gate failures", () => {
    expect(classifyFailure(HAND_RAISE).class).toBe("flawed-spec");
    expect(classifyFailure({ ok: false, verified: null, endedBy: "watch-relay" }).class).toBe("environment");
    expect(classifyFailure({ ok: false, verified: null, error: "FLEET_ERROR: cannot enter cwd" }).class).toBe("environment");
    expect(classifyFailure(FLAKY).class).toBe("flaky");
    expect(classifyFailure({ ok: false, verified: null, endedBy: "wall-clock" }).class).toBe("flaky");
    expect(classifyFailure(GATE_FAIL("npm test: 3 failed")).class).toBe("real");
  });
});

describe("#125: scheduling", () => {
  it("runs disjoint independent specs in parallel and holds a dependent until its dependency is verified", () => {
    let s = mk([spec("a", [], ["src/a/**"]), spec("c", [], ["src/c/**"]), spec("b", ["a"], ["src/b/**"])]);
    const first = plan(s, CTX()).filter((x) => x.type === "dispatch");
    expect(first.map((x) => x.specId).sort()).toEqual(["a", "c"]);
    expect(first.every((x) => x.type === "dispatch" && x.key.startsWith("m1:"))).toBe(true);
    s = reduce(s, { type: "dispatch-intent", specId: "a", node: "dev2", key: "m1:a:1", nowMs: 1 });
    s = reduce(s, { type: "dispatched", specId: "a", runId: "r1", key: "m1:a:1" });
    s = reduce(s, { type: "outcome", specId: "a", runId: "r1", signals: PASS });
    expect(plan(s, CTX()).some((x) => x.type === "dispatch" && x.specId === "b")).toBe(true);
  });
  it("serialises overlapping scopes; a spec with no scope runs only when nothing else does", () => {
    const s = mk([spec("a", [], ["src/**"]), spec("b", [], ["src/x.ts"]), spec("n")]);
    expect(plan(s, CTX()).filter((x) => x.type === "dispatch").map((x) => x.specId)).toEqual(["a"]);
    const solo = mk([spec("n"), spec("m", [], ["docs/**"])]);
    expect(plan(solo, CTX()).filter((x) => x.type === "dispatch").map((x) => x.specId)).toEqual(["n"]);
  });
  it("respects per-node slots and the mission-wide parallel cap, and waiting for a slot is not stuck", () => {
    const s = mk([spec("a", [], ["a/"]), spec("b", [], ["b/"]), spec("c", [], ["c/"])], { maxParallel: 2 });
    expect(plan(s, CTX({ dev2: 1, dev3: 0 })).filter((x) => x.type === "dispatch")).toHaveLength(1);
    expect(plan(s, CTX()).filter((x) => x.type === "dispatch")).toHaveLength(2);
    expect(missionStatus(s, CTX({ dev2: 0 })).status).toBe("running");
  });
});

describe("#125: bounded self-correction (simulated missions)", () => {
  const scope = (n: string) => [`src/${n}/**`];
  it("a flaky failure is retried and then verified; the journal says why", () => {
    const w = newWorld({ c: [FLAKY, PASS] });
    const end = drive(mk([spec("a", [], scope("a")), spec("c", [], scope("c")), spec("b", ["a"], scope("b"))]), w);
    expect(statuses(end)).toEqual({ a: "verified", c: "verified", b: "verified" });
    expect(missionStatus(end, CTX()).status).toBe("complete");
    const retry = end.journal.find((j) => j.type === "retry")!;
    expect(retry).toMatchObject({ specId: "c", why: expect.stringContaining("flaky") });
    expect(w.launches.filter((k) => k.startsWith("m1:c:"))).toEqual(["m1:c:1", "m1:c:2"]);
  });

  it("a real failure gets ONE repair carrying the evidence; a different second failure escalates with evidence", () => {
    const w = newWorld({ e: [GATE_FAIL("npm test: 3 failed"), GATE_FAIL("tsc: 2 errors")] });
    const s = mk([spec("e", [], scope("e")), spec("f", ["e"], scope("f"))]);
    const end = drive(s, w, { ctx: CTX() });
    expect(statuses(end)).toEqual({ e: "escalated", f: "pending" });
    expect(end.specs.e!.escalation).toMatchObject({ reason: expect.stringContaining("repair"), evidence: "tsc: 2 errors" });
    // The repair attempt carried the first failure's evidence.
    const repair = end.journal.find((j) => j.type === "dispatch-intent" && j.specId === "e" && j.evidence?.includes("npm test: 3 failed"));
    expect(repair).toBeDefined();
    expect(missionStatus(end, CTX())).toMatchObject({ status: "escalated", escalations: [{ specId: "e" }] });
  });

  it("the same failure repeating after a repair means the spec is wrong: replan, and the replan is a recorded diff", () => {
    const w = newWorld({ e: [GATE_FAIL("npm test: 3 failed"), GATE_FAIL("npm test: 3 failed"), PASS] });
    const end = drive(mk([spec("e", [], scope("e"))]), w, {
      decomposer: (_s, id) => ({ reason: "acceptance cannot be met as written; narrowed", modify: { [id]: { goal: "do e (narrowed)" } } }),
    });
    expect(statuses(end)).toEqual({ e: "verified" });
    expect(end.replans).toBe(1);
    expect(end.journal.find((j) => j.type === "replan")).toMatchObject({ why: expect.stringContaining("narrowed") });
    expect(end.specs.e!.spec.goal).toBe("do e (narrowed)");
  });

  it("a flawed spec (hand-raise) asks for a replan, the diff adds work, and verified work is untouched", () => {
    const w = newWorld({ d: [HAND_RAISE, PASS] });
    const end = drive(mk([spec("a", [], scope("a")), spec("d", ["a"], scope("d"))]), w, {
      decomposer: (_s, id) => ({ reason: "clarified the API shape", add: [spec("d0", [], scope("d0"))], modify: { [id]: { deps: ["a", "d0"] } } }),
    });
    expect(statuses(end)).toEqual({ a: "verified", d: "verified", d0: "verified" });
    expect(end.replans).toBe(1);
  });

  it("an exit-0 run with no verification gate is NOT success (it asks for a replan, here unavailable, so it escalates)", () => {
    const w = newWorld({ g: [{ ok: true, verified: null }] });
    const end = drive(mk([spec("g", [], scope("g"))]), w);
    expect(statuses(end)).toEqual({ g: "escalated" });
    expect(end.specs.g!.escalation!.reason).toContain("no decomposer");
  });

  it("environment failures retry up to the limit, then escalate", () => {
    const env: OutcomeSignals = { ok: false, verified: null, endedBy: "watch-relay", error: "relay failed" };
    const end = drive(mk([spec("h", [], scope("h"))], { maxRetries: 2 }), newWorld({ h: [env] }));
    expect(statuses(end)).toEqual({ h: "escalated" });
    expect(end.specs.h!.retries).toBe(2);
    expect(end.specs.h!.attempts).toBe(3);
  });
});

describe("#125: kill and restart never duplicates or loses a run", () => {
  const specs = () => [spec("a", [], ["src/a/**"]), spec("c", [], ["src/c/**"]), spec("b", ["a"], ["src/b/**"]), spec("d", ["b", "c"], ["src/d/**"])];
  const script: Script = { c: [FLAKY, PASS] };
  const baseline = drive(mk(specs()), newWorld(script));

  for (const phase of ["after-intent", "after-launch"] as const) {
    for (let n = 1; n <= 6; n++) {
      it(`crash ${phase} at launch #${n}: same final state, every (spec, attempt) launched at most once`, () => {
        const w = newWorld(script);
        const end = drive(mk(specs()), w, { crashAt: { n, phase } });
        expect(statuses(end)).toEqual(statuses(baseline));
        expect(new Set(w.launches).size).toBe(w.launches.length);
        for (const s of Object.values(end.specs)) expect(s.status).toBe("verified");
        // Same set of launches as the uncrashed mission: nothing lost, nothing extra.
        const w0 = newWorld(script);
        drive(mk(specs()), w0);
        expect([...w.launches].sort()).toEqual([...w0.launches].sort());
      });
    }
  }

  it("a state round-trips through JSON between any two steps", () => {
    const s = mk(specs());
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const stepped = reduce(s, { type: "dispatch-intent", specId: "a", node: "dev2", key: dispatchKey("m1", "a", 1), nowMs: 5 });
    expect(JSON.parse(JSON.stringify(stepped))).toEqual(stepped);
  });

  it("an unacknowledged intent is reconciled, never relaunched; a stale running spec is reconciled too", () => {
    let s = mk([spec("a", [], ["src/a/**"])]);
    s = reduce(s, { type: "dispatch-intent", specId: "a", node: "dev2", key: "m1:a:1", nowMs: 0 });
    const acts = plan(s, CTX());
    expect(acts).toEqual([{ type: "reconcile", specId: "a", key: "m1:a:1" }]);
    s = reduce(s, { type: "dispatched", specId: "a", runId: "r", key: "m1:a:1" });
    expect(plan(s, { ...CTX(), nowMs: 1000 })).toEqual([]);
    expect(plan(s, { ...CTX(), nowMs: 7 * 3600_000 })).toEqual([{ type: "reconcile", specId: "a", key: "m1:a:1", runId: "r" }]);
    // A void intent does not count as an attempt.
    let t = mk([spec("a")]);
    t = reduce(t, { type: "dispatch-intent", specId: "a", node: "dev2", key: "m1:a:1", nowMs: 0 });
    t = reduce(t, { type: "intent-void", specId: "a", key: "m1:a:1", reason: "never launched" });
    expect(t.specs.a).toMatchObject({ status: "pending", attempts: 0 });
    expect(plan(t, CTX())[0]).toMatchObject({ type: "dispatch", key: "m1:a:1" });
  });

  it("stale or mismatched events are ignored and journalled, not applied", () => {
    let s = mk([spec("a")]);
    expect(reduce(s, { type: "outcome", specId: "a", signals: PASS }).specs.a!.status).toBe("pending");
    expect(reduce(s, { type: "dispatched", specId: "a", runId: "r", key: "m1:a:9" }).specs.a!.status).toBe("pending");
    expect(reduce(s, { type: "outcome", specId: "zzz", signals: PASS }).journal.at(-1)!.type).toBe("ignored");
    s = reduce(s, { type: "dispatch-intent", specId: "a", node: "dev2", key: "m1:a:1", nowMs: 0 });
    expect(reduce(s, { type: "dispatched", specId: "a", runId: "r", key: "m1:a:2" }).specs.a!.status).toBe("dispatching");
  });
});

describe("#125: replan rules", () => {
  const running = (): MissionState => {
    let s = mk([spec("a"), spec("b", ["a"]), spec("c")]);
    s = reduce(s, { type: "dispatch-intent", specId: "a", node: "n", key: "m1:a:1", nowMs: 0 });
    s = reduce(s, { type: "dispatched", specId: "a", runId: "r", key: "m1:a:1" });
    s = reduce(s, { type: "outcome", specId: "a", signals: PASS });
    s = reduce(s, { type: "dispatch-intent", specId: "c", node: "n", key: "m1:c:1", nowMs: 0 });
    return reduce(s, { type: "dispatched", specId: "c", runId: "r2", key: "m1:c:1" });
  };
  it("verified and in-flight work is never discarded or rewritten", () => {
    expect(applyReplan(running(), { reason: "x", remove: ["a"] })).toMatchObject({ ok: false, error: expect.stringContaining("never discarded") });
    expect(applyReplan(running(), { reason: "x", modify: { c: { goal: "new" } } })).toMatchObject({ ok: false });
  });
  it("needs a reason, respects the cap, and keeps the graph sound", () => {
    expect(applyReplan(running(), { reason: " " })).toMatchObject({ ok: false });
    expect(applyReplan(running(), { reason: "x", add: [spec("n", ["ghost"])] })).toMatchObject({ ok: false, error: expect.stringContaining("unknown spec ghost") });
    expect(applyReplan(running(), { reason: "x", add: [spec("n1", ["n2"]), spec("n2", ["n1"])] })).toMatchObject({ ok: false, error: expect.stringContaining("cycle") });
    expect(applyReplan(running(), { reason: "x", remove: ["b"], add: [spec("a")] })).toMatchObject({ ok: false });
    const capped = mk([spec("a")], { maxReplans: 0 });
    expect(applyReplan(capped, { reason: "x", add: [spec("z")] })).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
  });
  it("withdrawing a spec something still needs is a dangling dependency, not a silent drop", () => {
    const s = mk([spec("a"), spec("b", ["a"])]);
    expect(applyReplan(s, { reason: "x", remove: ["a"] })).toMatchObject({ ok: false, error: expect.stringContaining("still depends") });
    const ok = applyReplan(s, { reason: "x", remove: ["a"], modify: { b: { deps: [] } } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.state.specs.a!.status).toBe("superseded");
  });
  it("a spec that asked for a replan the diff did not address escalates instead of hanging", () => {
    let s = mk([spec("a"), spec("z")]);
    s = reduce(s, { type: "dispatch-intent", specId: "a", node: "n", key: "m1:a:1", nowMs: 0 });
    s = reduce(s, { type: "dispatched", specId: "a", runId: "r", key: "m1:a:1" });
    s = reduce(s, { type: "outcome", specId: "a", signals: HAND_RAISE });
    expect(s.specs.a!.status).toBe("needs-replan");
    const r = applyReplan(s, { reason: "unrelated change", add: [spec("q")] });
    expect(r.ok && r.state.specs.a!.status).toBe("escalated");
  });
  it("every journal entry carries a reason", () => {
    const end = drive(mk([spec("a", [], ["src/a/**"])]), newWorld({ a: [FLAKY, PASS] }));
    expect(end.journal.length).toBeGreaterThan(3);
    for (const j of end.journal) expect(j.why.length, JSON.stringify(j)).toBeGreaterThan(0);
  });
});
