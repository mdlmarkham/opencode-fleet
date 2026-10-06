import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L0_CONTRACT, abortMission, actionAllowed, buildDigest, checkLevel, evaluateHardStops, haltMission, parseContract, routeQuestion, tighten, type Contract, type Facts } from "./mission-autonomy.js";
import { addAssumption, createMission, loadMission, readJournal, setPhase, updateMission } from "./mission-store.js";
import { loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

const raw = (o: Record<string, unknown> = {}) => ({ level: "L2", allowed: ["clone-work", "fleet-branches", "open-pr"], forbidden: ["protected-branch-publish", "credential-use", "network-egress"], limits: { wallMs: 3_600_000, costUsd: 20, tokens: 2_000_000, maxRetries: 2, maxReplans: 2, maxConcurrent: 4, sameSpecGateFailures: 3 }, hardStops: undefined, ...o });
const c = (o: Record<string, unknown> = {}): Contract => { const r = parseContract(raw(o)); if (!r.ok) throw new Error(r.error); return r.contract; };
const facts = (o: Partial<Facts> = {}): Facts => ({ elapsedMs: 1000, spentUsd: 1, tokens: 100, gateFailuresBySpec: {}, replans: 0, ...o });

describe("#124: contract as data", () => {
  it("parses, defaults every hard stop on, and rejects unknown keys, bad levels and contradictions", () => {
    expect(c().hardStops).toHaveLength(9);
    for (const bad of [{ surprise: 1 }, { level: "L9" }, { allowed: ["clone-work"], forbidden: ["clone-work"] }, { allowed: ["rm-rf"] }, { limits: { wallMs: -1 } }, { limits: undefined }]) expect(parseContract(raw(bad)).ok, JSON.stringify(bad)).toBe(false);
    expect(parseContract(raw({ limits: { ...raw().limits, maxConcurrent: 0 } })).ok).toBe(false);
  });
  it("a repo may only tighten", () => {
    const op = c();
    expect(tighten(op, c({ level: "L1", limits: { ...raw().limits, costUsd: 5 } })).ok).toBe(true);
    for (const loose of [c({ level: "L3" }), c({ allowed: ["clone-work", "credential-use"], forbidden: ["protected-branch-publish", "network-egress"] }), c({ forbidden: ["credential-use"] }), c({ hardStops: ["budget-exhausted"] }), c({ limits: { ...raw().limits, costUsd: 99 } }), c({ limits: { ...raw().limits, sameSpecGateFailures: 9 } })]) {
      expect(tighten(op, loose).ok).toBe(false);
    }
  });
  it("forbidden wins, and nothing not explicitly allowed is allowed", () => {
    expect(actionAllowed(c(), "open-pr").ok).toBe(true);
    expect(actionAllowed(c(), "credential-use")).toMatchObject({ ok: false, error: expect.stringContaining("forbidden") });
    expect(actionAllowed(L0_CONTRACT, "clone-work").ok).toBe(false);
  });
  it("L3 is refused without its prerequisites, naming each missing one", () => {
    expect(checkLevel("L2", { sandbox: false, budgets: false, reviewerCalibration: false }).ok).toBe(true);
    const r = checkLevel("L3", { sandbox: true, budgets: false, reviewerCalibration: false });
    expect(r).toMatchObject({ ok: false, missing: ["budgets (#39)", "reviewer calibration (M-4, #127)"] });
    expect(checkLevel("L3", { sandbox: true, budgets: true, reviewerCalibration: true }).ok).toBe(true);
  });
});

describe("#124: every hard stop halts a mission with cited evidence", () => {
  const cases: Array<[string, Partial<Facts>, RegExp]> = [
    ["budget-exhausted", { spentUsd: 25 }, /\$25\.00 >= limit \$20/],
    ["budget-exhausted", { tokens: 3_000_000 }, /3000000 tokens/],
    ["wall-time", { elapsedMs: 4_000_000 }, /4000s >= limit 3600s/],
    ["repeat-gate-failure", { gateFailuresBySpec: { a: 3 } }, /spec a failed its gate 3 time/],
    ["scope-violation", { scopeViolations: [{ specId: "b", files: ["secrets.env"] }] }, /b: secrets.env/],
    ["security-rule", { securityRuleHit: { rule: "no-curl-pipe", evidence: "curl x | sh" } }, /no-curl-pipe: curl x/],
    ["checkpoint-blocked", { checkpointBlocked: { checkpoint: "C2", evidence: "no verify" } }, /C2: no verify/],
    ["plan-ambiguity", { ambiguity: { specId: "c", question: "which db?" } }, /spec c: which db\?/],
    ["plan-stale", { planStale: { evidence: "main moved 40 commits" } }, /main moved/],
    ["reviewer-disagreement", { reviewerDisagreement: { evidence: "A pass, B fail" } }, /A pass, B fail/],
    ["plan-ambiguity", { replans: 3 }, /3 replans exceed/],
  ];
  for (const [kind, f, ev] of cases) {
    it(`${kind}: ${Object.keys(f)[0]}`, () => {
      const s = evaluateHardStops(c(), facts(f));
      expect(s.map((x) => x.kind)).toContain(kind);
      expect(s.find((x) => x.kind === kind)!.evidence).toMatch(ev);
    });
  }
  it("healthy facts stop nothing, and a stop the contract does not list is not enforced", () => {
    expect(evaluateHardStops(c(), facts())).toEqual([]);
    expect(evaluateHardStops(c({ hardStops: ["wall-time"] }), facts({ spentUsd: 99 }))).toEqual([]);
  });
});

describe("#124: questions are batched or defaulted, never interrupts", () => {
  it("a default or an unblocking question becomes an assumption; a blocking one parks only dependents", () => {
    expect(routeQuestion({ text: "tabs or spaces?", safeDefault: "spaces" })).toMatchObject({ route: "assume", assumption: expect.stringContaining("spaces") });
    expect(routeQuestion({ text: "naming?" })).toMatchObject({ route: "assume" });
    expect(routeQuestion({ text: "which db?", blocks: ["b", "c", "b"] })).toMatchObject({ route: "park", parked: ["b", "c"] });
  });
});

describe("#124: halting, digest and kill switch (durable)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet124-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const specs = [{ id: "a", goal: "g", deps: [] }, { id: "b", goal: "g", deps: [] }];
  const toExecuting = async () => { await createMission(root, "m1", specs); await setPhase(root, "m1", "awaiting-approval", "d"); await setPhase(root, "m1", "executing", "ok"); };

  it("a hard stop blocks an executing mission and journals the evidence; repeating it changes nothing", async () => {
    await toExecuting();
    const stops = evaluateHardStops(c(), facts({ spentUsd: 30 }));
    const r = await haltMission(root, "m1", stops);
    expect(r).toMatchObject({ ok: true, record: { phase: "blocked" } });
    const j = await readJournal(root, "m1");
    expect(j.find((e) => e.type === "hard-stop")).toMatchObject({ why: "budget-exhausted", evidence: expect.stringContaining("$30.00") });
    expect(await haltMission(root, "m1", stops)).toMatchObject({ unchanged: true });
    expect((await readJournal(root, "m1")).filter((e) => e.type === "hard-stop")).toHaveLength(1);
  });
  it("digest summarises progress, open assumptions, risks and recent events", async () => {
    await toExecuting();
    await addAssumption(root, "m1", "notes are small", "agent");
    await updateMission(root, "m1", (r) => ({ ...r, risks: [{ id: "r1", text: "slow disks", severity: "high" }], supervisor: { ...r.supervisor, specs: { ...r.supervisor.specs, a: { ...r.supervisor.specs.a!, status: "verified" } } } }));
    const m = await loadMission(root, "m1");
    const d = buildDigest((m as unknown as { record: never }).record, await readJournal(root, "m1"), 3.5);
    expect(d).toMatchObject({ progress: { total: 2, verified: 1, pending: 1 }, assumptionsOpen: ["notes are small"], risks: ["high: slow disks"], spentUsd: 3.5 });
    expect(d.recent.length).toBeGreaterThan(0);
  });
  it("the kill switch aborts live runs, reports unconfirmed ones, and is idempotent", async () => {
    await toExecuting();
    await updateMission(root, "m1", (r) => ({ ...r, supervisor: { ...r.supervisor, specs: { ...r.supervisor.specs, a: { ...r.supervisor.specs.a!, status: "running", runId: "run-a", node: "n1" }, b: { ...r.supervisor.specs.b!, status: "running", runId: "run-b", node: "n1" } } } }));
    const calls: string[] = [];
    const deps = { abortRun: async ({ runId }: { runId: string }) => { calls.push(runId); if (runId === "run-b") throw new Error("node down"); return { confirmed: true }; } };
    const r1 = await abortMission(root, "m1", "operator stop", deps);
    expect(r1).toMatchObject({ ok: true, alreadyAborted: false, aborted: [{ runId: "run-a", confirmed: true }, { runId: "run-b", confirmed: false, note: "node down" }] });
    const m = await loadMission(root, "m1");
    expect(m.ok && m.record.phase).toBe("aborted");
    const r2 = await abortMission(root, "m1", "again", deps);
    expect(r2).toMatchObject({ ok: true, alreadyAborted: true });
    expect((await readJournal(root, "m1")).filter((e) => e.type === "abort")).toHaveLength(1);
    expect((await readJournal(root, "m1")).map((e) => e.type)).toContain("run-abort-unconfirmed");
  });
  it("fleet_mission_abort drives the real abort op and reports confirmation", async () => {
    const t = loadPlugin((await loadEntry())!, { nodes: [{ nodeId: "n1", displayName: "kev", connected: true }], invoke: () => nodeReply({ ok: true, aborted: true, confirmed: true }) });
    try {
      await createMission(t.rootDir, "m2", specs);
      await setPhase(t.rootDir, "m2", "awaiting-approval", "d"); await setPhase(t.rootDir, "m2", "executing", "ok");
      await updateMission(t.rootDir, "m2", (r) => ({ ...r, supervisor: { ...r.supervisor, specs: { ...r.supervisor.specs, a: { ...r.supervisor.specs.a!, status: "running", runId: "run-9", node: "kev" } } } }));
      const r = await t.call("fleet_mission_abort", { missionId: "m2", reason: "stop" });
      expect(r).toMatchObject({ ok: true, aborted: [{ runId: "run-9", confirmed: true }] });
      expect(t.invokes[0]!.params).toMatchObject({ prompt: "__ABORT__", runId: "run-9" });
      expect((await t.call("fleet_mission_abort", { missionId: "nope", reason: "x" })).ok).toBe(false);
    } finally { t.dispose(); }
  });
});
