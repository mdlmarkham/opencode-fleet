import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAcknowledgements, evaluateDesignGate, objection, parseAcknowledge, type InFlightRun } from "./design-gate.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { loadLedger, upsertRun } from "./ledger.js";
import type { TaskSpec } from "./spec.js";

const GOOD: TaskSpec = { goal: "add x", acceptance: ["x works"], verify: { command: "scripts/check.sh" }, scope: { files: ["src/x/"] } };
const run = (over: Partial<InFlightRun> = {}): InFlightRun => ({ runId: "r1", node: "dev2", cwd: "/w", scope: { files: ["src/x/a.ts"] }, ...over });
const gate = (spec: TaskSpec, ctx = {}, acks: Array<{ objectionId: string; reason: string }> = []) => {
  const r = evaluateDesignGate(spec, ctx, acks);
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
const ids = (spec: TaskSpec, ctx = {}) => gate(spec, ctx).objections.map((o) => o.id);

describe("#117: deterministic checks (each with a positive and a near-miss)", () => {
  it("a complete spec with nothing in flight is a plain accept", () => {
    expect(gate(GOOD)).toMatchObject({ verdict: "accept", objections: [], blocked: false });
  });
  it("completeness: each missing part is its own nudge", () => {
    expect(ids({ goal: "g" })).toEqual(["spec.no-acceptance", "spec.no-verify", "spec.no-scope"]);
    expect(ids({ ...GOOD, acceptance: [] })).toEqual(["spec.no-acceptance"]);
    expect(ids({ ...GOOD, verify: { files: ["a.txt"] } })).toEqual([]);
    expect(gate({ goal: "g" }).verdict).toBe("accept-with-nudges");
    expect(gate({ goal: "g" }).blocked).toBe(false);
  });
  it("size: over the bound is decompose; at the bound is fine; bounds are configurable", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `src/m${i}/`);
    expect(gate({ ...GOOD, scope: { files: many(21) } })).toMatchObject({ verdict: "decompose", blocked: true });
    expect(ids({ ...GOOD, scope: { files: many(20) } })).toEqual([]);
    expect(gate({ ...GOOD, acceptance: Array(16).fill("a") }).verdict).toBe("decompose");
    expect(ids({ ...GOOD, scope: { files: many(3) } }, { bounds: { maxScopePatterns: 2 } })).toEqual(["spec.too-large"]);
    const o = gate({ ...GOOD, scope: { files: many(21) } }).objections[0];
    expect(o.evidence).toContain("21 patterns (limit 20)");
  });
  it("overlap: an in-flight run on the shared checkout with overlapping scope rejects, citing the run id", () => {
    const r = gate(GOOD, { inFlight: [run()] });
    expect(r).toMatchObject({ verdict: "reject-with-reason", blocked: true });
    expect(r.objections[0]).toMatchObject({ id: "overlap.in-flight", evidence: expect.stringContaining("r1 (dev2)") });
  });
  it("overlap near-misses: disjoint scope, an isolated run, an isolated new run", () => {
    expect(ids(GOOD, { inFlight: [run({ scope: { files: ["docs/"] } })] })).toEqual([]);
    expect(ids(GOOD, { inFlight: [run({ isolated: true })] })).toEqual(["overlap.merge"]);
    expect(gate(GOOD, { inFlight: [run()], isolated: true })).toMatchObject({ verdict: "accept-with-nudges", blocked: false });
  });
  it("unknown scope on either side is a nudge, never a block", () => {
    expect(ids(GOOD, { inFlight: [run({ scope: undefined })] })).toEqual(["overlap.unknown"]);
    const noScope = ids({ ...GOOD, scope: undefined }, { inFlight: [run()] });
    expect(noScope).toContain("overlap.unknown");
    expect(noScope).not.toContain("overlap.in-flight");
    expect(gate({ ...GOOD, scope: undefined }, { inFlight: [run()] }).blocked).toBe(false);
  });
  it("every objection has evidence; one without is refused", () => {
    for (const o of gate({ goal: "g", acceptance: Array(16).fill("a") }, { inFlight: [run()] }).objections) expect(o.evidence.trim()).not.toBe("");
    expect(() => objection({ id: "x", severity: "nudge", message: "m", evidence: " ", suggestion: "s" })).toThrow(/no evidence/);
  });
});

describe("#117: overrides", () => {
  it("an acknowledged block-candidate no longer blocks, and the reason is recorded", () => {
    const r = gate(GOOD, { inFlight: [run()] }, [{ objectionId: "overlap.in-flight", reason: "r1 is finishing" }]);
    expect(r).toMatchObject({ blocked: false, verdict: "accept-with-nudges", acknowledged: [{ objectionId: "overlap.in-flight", reason: "r1 is finishing" }] });
    expect(r.objections[0].acknowledged).toBe("r1 is finishing");
  });
  it("acknowledging an unknown objection is refused, naming the real ones", () => {
    const r = evaluateDesignGate(GOOD, { inFlight: [run()] }, [{ objectionId: "nope", reason: "x" }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("overlap.in-flight") });
  });
  it("an operator `block` objection cannot be acknowledged away", () => {
    const blockObj = objection({ id: "op.rule", severity: "block", message: "m", evidence: "rule op.rule", suggestion: "s" });
    expect(applyAcknowledgements([blockObj], [{ objectionId: "op.rule", reason: "please" }])).toMatchObject({ ok: false, error: expect.stringContaining("operator block") });
  });
  it("parseAcknowledge validates shape and bounds", () => {
    expect(parseAcknowledge(undefined)).toEqual({ ok: true, acks: [] });
    for (const bad of ["x", [1], [{ objectionId: "a" }], [{ objectionId: "a", reason: " " }], [{ objectionId: "a", reason: "x".repeat(501) }], Array(51).fill({ objectionId: "a", reason: "r" })]) {
      expect(parseAcknowledge(bad).ok, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });
});

const entry = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the design-gate tool tests really ran", () => { expect(entry).toBeDefined(); });

describe.skipIf(!entry)("#117: tools", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = (project?: Record<string, unknown>) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(project ? { project } : {}) });
  const ok = () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
  // Issue #196: a genuinely-running entry must be FRESH (updated within staleAfterMs) to count as
  // in-flight — the old pin seeded 2026-01-01 timestamps, pinning the bug where finished/stale runs
  // polluted overlap evidence.
  const seedRunning = () => upsertRun(p!.rootDir, { runId: "live1", node: "dev2", cwd: "/w/proj", prompt: "p", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "running", spec: { goal: "g", scope: { files: ["src/x/"] } } } as never);
  const call = (args: Record<string, unknown>) => p!.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", ...args });

  it("fleet_design_check is a dry run: verdict out, nothing dispatched, overlap checked when node+cwd given", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: ok });
    await seedRunning();
    const bad = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/proj" }) as { verdict: string; overlapChecked: boolean; objections: Array<{ id: string }> };
    expect(bad).toMatchObject({ ok: true, verdict: "reject-with-reason", overlapChecked: true });
    expect(bad.objections[0].id).toBe("overlap.in-flight");
    expect(await p.call("fleet_design_check", { spec: GOOD })).toMatchObject({ verdict: "accept", overlapChecked: false });
    expect(await p.call("fleet_design_check", { spec: { acceptance: ["x"] } })).toMatchObject({ ok: false });
    expect(p.invokes).toHaveLength(0);
  });
  it("advise (default): the verdict rides along, the dispatch still happens", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: ok });
    const r = await call({ spec: { goal: "g" } }) as { design?: { verdict: string }; dev2?: unknown };
    expect(r.design?.verdict).toBe("accept-with-nudges");
    expect(await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__")).toBeDefined();
  });
  it("a prompt-only dispatch and a clean spec carry no design field at all", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: ok });
    expect("design" in (await call({ prompt: "just do it" }) as object)).toBe(false);
    // a different checkout, so the first dispatch is not "in flight on the same checkout"
    expect("design" in (await call({ cwd: "/w/other", spec: GOOD }) as object)).toBe(false);
  });
  it("gate off: even a bare spec is untouched", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ gate: "off" }), invoke: ok });
    expect("design" in (await call({ spec: { goal: "g" } }) as object)).toBe(false);
  });
  it("enforce refuses while a blocking objection stands, before touching the node; acknowledging lets it through and is recorded", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ gate: "enforce" }), invoke: ok });
    await seedRunning();
    const refused = await call({ spec: GOOD }) as { ok: boolean; design: { verdict: string } };
    expect(refused).toMatchObject({ ok: false, design: { verdict: "reject-with-reason" } });
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(0);
    await call({ spec: GOOD, acknowledge: [{ objectionId: "overlap.in-flight", reason: "live1 is wrapping up" }] });
    expect(await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__")).toBeDefined();
    const ledger = await loadLedger(p.rootDir);
    expect(ledger.find((e) => e.runId !== "live1")?.gateAcknowledged).toEqual([{ objectionId: "overlap.in-flight", reason: "live1 is wrapping up" }]);
  });
  it("enforce does not block on nudges alone, and a bad acknowledge is a clear refusal", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ gate: "enforce" }), invoke: ok });
    // A verify gate is present (enforce refuses ungated dispatches, #168); the other gaps are nudges.
    expect((await call({ spec: { goal: "g", verify: { command: "scripts/check.sh" } } }) as { design?: unknown }).design).toBeDefined();
    expect(await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__")).toBeDefined();
    expect(await call({ spec: GOOD, acknowledge: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("acknowledge") });
  });
});
