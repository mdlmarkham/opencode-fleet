/**
 * Issue #260 (merge-queue slice): a shared-line collision between two ACTIVE
 * claims is flagged AT DISPATCH TIME as a `scopeOverlap` warning — naming the
 * other runId and the overlapping patterns — NEVER a refusal (blocking stays
 * the design gate's decision with its acknowledge path).
 *
 * Contract proven here end to end through the real tool against the fake
 * harness (the #260 sibling-test pattern):
 *   1. An active run seeded in the ledger with scope `src/foo/**` + a second
 *      dispatch scoped `src/foo/bar.ts` -> the dispatch result carries
 *      `scopeOverlap` naming `r-live`, and the run STILL LAUNCHES.
 *   2. A disjoint scope (`src/other/**`), a different checkout, a FINISHED
 *      run, a STALE run (past the same stale window the capacity machinery
 *      reconciles on), and a scope-less dispatch -> no field at all (the
 *      result shape change is purely additive).
 *   3. Several live competitors all appear, across nodes.
 *   4. Default advise mode: the warning coexists with the gate verdict — the
 *      gate's overlap.in-flight objection is unchanged alongside it.
 *
 * Matching REUSES `scopeOverlap` from src/scope.ts — the one matcher the
 * scope machinery reports scopeViolations with — over the same ledger ->
 * in-flight shape (`capacityInputFromLedger`) the gate's overlap evidence
 * uses; no second glob engine exists. The warning cases FAIL if the flag is
 * removed; the negative cases FAIL if it fires on non-collisions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { upsertRun } from "./ledger.js";

const entry = await loadEntry();

const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
// gate off: the warning must stand on its own, independent of the design gate.
const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false } }, project: { gate: "off" } };
const LAUNCH = nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 });
const STALE = new Date(Date.now() - 7 * 60 * 60_000).toISOString(); // past the 6h DEFAULT_STALE_AFTER_MS

interface OverlapWarning {
  note: string;
  runs: Array<{ runId: string; node: string; files: string[] }>;
}
const warningOf = (r: unknown): OverlapWarning | undefined => (r as Record<string, unknown>).scopeOverlap as never;

describe.skipIf(!entry)("#260 merge-queue slice: scopeOverlap warning at dispatch time", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  const load = (config: Record<string, unknown> = CFG) => {
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    p = loadPlugin(entry!, { nodes: NODES, config, invoke: () => LAUNCH });
  };
  const seed = (over: Record<string, unknown> = {}) =>
    upsertRun(p!.rootDir, {
      runId: "r-live", node: "dev2", cwd: "/w/p", prompt: "p",
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      state: "running",
      spec: { goal: "the first run's own goal", scope: { files: ["src/foo/**"] } },
      ...over,
    } as never);
  const dispatch = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    p!.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", spec, ...extra });

  it("an ACTIVE run with scope src/foo/** + a dispatch scoped src/foo/bar.ts -> warning naming r-live, and the run STILL LAUNCHES", async () => {
    load();
    await seed();
    const r = (await dispatch({ goal: "the second run's goal", scope: { files: ["src/foo/bar.ts"] } })) as Record<string, unknown>;
    const w = warningOf(r);
    expect(w, JSON.stringify(r).slice(0, 400)).toBeDefined();
    expect(w!.runs.map((x) => x.runId)).toEqual(["r-live"]);
    expect(w!.runs[0]!.node).toBe("dev2");
    expect(w!.runs[0]!.files).toHaveLength(1);
    expect(w!.runs[0]!.files[0]).toContain("src/foo/bar.ts");
    expect(w!.runs[0]!.files[0]).toContain("src/foo/**");
    expect(w!.note).toMatch(/[Nn]ot a refusal/);
    expect(p!.invokes.some((c) => c.params.prompt === "__RUN_START__")).toBe(true);
  });

  it("a disjoint scope, a different checkout, and a scope-less dispatch add NO field at all", async () => {
    load();
    await seed();
    const disjoint = (await dispatch({ goal: "disjoint goal", scope: { files: ["src/other/**"] } })) as Record<string, unknown>;
    expect("scopeOverlap" in disjoint, JSON.stringify(disjoint).slice(0, 400)).toBe(false);
    // A live run with a disjoint scope (from that dispatch) does not collide either.
    const overlap = (await dispatch({ goal: "another goal", scope: { files: ["src/foo/baz.ts"] } })) as Record<string, unknown>;
    expect(warningOf(overlap)!.runs.map((x) => x.runId)).toEqual(["r-live"]);
    // The collision key is the checkout path: same scope, different cwd -> no warning.
    const otherRepo = (await dispatch({ goal: "elsewhere", scope: { files: ["src/foo/deep.ts"] } }, { cwd: "/w/other" })) as Record<string, unknown>;
    expect("scopeOverlap" in otherRepo).toBe(false);
  });

  it("a FINISHED run and a STALE one never collide (only ACTIVE claims do)", async () => {
    for (const c of [
      { over: { state: "completed", finishedAt: new Date().toISOString() }, why: "finished" },
      { over: { startedAt: STALE, updatedAt: STALE }, why: "stale" },
    ]) {
      p?.dispose(); p = undefined;
      load();
      await seed(c.over);
      const r = (await dispatch({ goal: "g2", scope: { files: ["src/foo/bar.ts"] } })) as Record<string, unknown>;
      expect("scopeOverlap" in r, c.why).toBe(false);
    }
  });

  it("two live competitors on the same line both appear, across nodes", async () => {
    load();
    await seed({ runId: "r-live1" });
    await seed({ runId: "r-live2", node: "dev3" });
    const r = (await dispatch({ goal: "g2", scope: { files: ["src/foo/y.ts"] } })) as Record<string, unknown>;
    const w = warningOf(r)!;
    expect([...w.runs.map((x) => `${x.runId}@${x.node}`)].sort()).toEqual(["r-live1@dev2", "r-live2@dev3"]);
    expect(new Set(w.runs.flatMap((x) => x.files))).toEqual(new Set(["src/foo/y.ts ↔ src/foo/**"]));
  });

  it("default advise mode: the warning coexists with the gate verdict, nothing blocked, run launched", async () => {
    p?.dispose(); p = undefined;
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: (c: { params: Record<string, unknown> }) => (c.params.prompt === "__PROJECT_READ__"
        ? nodeReply({ ok: false, error: "node refused" })
        : nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 })),
    });
    await seed();
    const r = (await dispatch({ goal: "g2", scope: { files: ["src/foo/bar.ts"] } })) as Record<string, any>;
    expect(warningOf(r)).toBeDefined();
    expect((r.design?.objections ?? []).map((o: { id: string }) => o.id)).toContain("overlap.in-flight");
    expect(r.ok).not.toBe(false);
    expect(p.invokes.some((c: { params: Record<string, unknown> }) => c.params.prompt === "__RUN_START__")).toBe(true);
  });
});