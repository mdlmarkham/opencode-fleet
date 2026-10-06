import { describe, expect, it } from "vitest";
import { compareToBaseline, deliveryGate, evidenceReport, integrationOutcome, mergeOrder, stagedGroups, type DeliverySpec, type GateInput, type ReportInput } from "./mission-delivery.js";

const sp = (id: string, o: Partial<DeliverySpec> = {}): DeliverySpec => ({ id, goal: `goal ${id}`, deps: [], branch: `fleet/run-${id}`, status: "verified", runId: `run-${id}`, linesChanged: 100, verify: { passed: true }, ...o });
const specs = [sp("c", { deps: ["a", "b"] }), sp("b", { deps: ["a"] }), sp("a")];

describe("#128: integration order", () => {
  it("merges verified branches dependencies first, ties by id", () => expect(mergeOrder(specs)).toEqual({ ok: true, order: ["a", "b", "c"] }));
  it("refuses unverified or branchless specs and cycles; skips superseded", () => {
    expect(mergeOrder([sp("a"), sp("b", { status: "escalated" })])).toMatchObject({ ok: false, error: expect.stringContaining("b (escalated)") });
    expect(mergeOrder([sp("a", { branch: undefined })])).toMatchObject({ ok: false, error: expect.stringContaining("no branch") });
    expect(mergeOrder([sp("a", { deps: ["b"] }), sp("b", { deps: ["a"] })])).toMatchObject({ ok: false, error: expect.stringContaining("cycle") });
    expect(mergeOrder([sp("a"), sp("z", { status: "superseded", branch: undefined })])).toEqual({ ok: true, order: ["a"] });
  });
  it("a conflict is an escalation with its files, never a silent resolution", () => {
    expect(integrationOutcome([{ specId: "a", conflict: false }, { specId: "b", conflict: true, conflictFiles: ["src/x.ts"] }, { specId: "c", conflict: true }])).toEqual({ ok: false, escalate: { specId: "b", files: ["src/x.ts"], reason: expect.stringContaining("b conflicts") } });
    expect(integrationOutcome([{ specId: "a", conflict: false }])).toEqual({ ok: true });
  });
});

describe("#128: baseline comparison", () => {
  const base = [{ command: "npm test", exitCode: 0 }, { command: "npm run lint", exitCode: 1 }, { command: "npm run build", exitCode: 0 }, { command: "make e2e", exitCode: null }];
  it("separates regressions from pre-existing failures, and never counts an unrun command", () => {
    const c = compareToBaseline(base, [
      { command: "npm test", kind: "test", exitCode: 1 },
      { command: "npm run lint", kind: "lint", exitCode: 1 },
      { command: "npm run build", kind: "build", exitCode: 0 },
      { command: "make e2e", kind: "test", exitCode: 0 },
      { command: "./accept.sh", kind: "acceptance", exitCode: 0 },
      { command: "npm run typecheck", kind: "lint", exitCode: null },
    ]);
    expect(c).toEqual({ regressions: ["npm test passed at baseline and now exits 1"], fixed: [], preExisting: ["npm run lint"], unmeasured: ["npm run typecheck"], newPassing: ["./accept.sh"] });
    expect(compareToBaseline(base, [{ command: "npm run lint", kind: "lint", exitCode: 0 }]).fixed).toEqual(["npm run lint"]);
    expect(compareToBaseline(base, [{ command: "./accept.sh", kind: "acceptance", exitCode: 2 }]).regressions).toEqual(["./accept.sh (acceptance) fails"]);
  });
});

describe("#128: the delivery gate", () => {
  const ok = (o: Partial<GateInput> = {}): GateInput => ({ specs, merges: [{ specId: "a", conflict: false }], comparison: { regressions: [], fixed: [], preExisting: ["npm run lint"], unmeasured: [], newPassing: [] }, checkpoints: [{ checkpoint: "C3", state: "satisfied" }, { checkpoint: "C4", state: "satisfied" }], ...o });
  it("opens only when everything holds, preserving the merge order", () => expect(deliveryGate(ok())).toEqual({ open: true, order: ["a", "b", "c"] }));
  it("a mission whose final verification regresses against baseline does not open a PR and escalates", () => {
    const g = deliveryGate(ok({ comparison: { regressions: ["npm test passed at baseline and now exits 1"], fixed: [], preExisting: [], unmeasured: [], newPassing: [] } }));
    expect(g).toMatchObject({ open: false, escalate: true, reasons: ["regression: npm test passed at baseline and now exits 1"] });
  });
  it("each other reason also stops it: conflict, no verification, unrun command, missing or unsatisfied checkpoint, requireVerified", () => {
    const reasons = (i: GateInput) => { const g = deliveryGate(i); return g.open ? [] : g.reasons.join("|"); };
    expect(reasons(ok({ merges: [{ specId: "b", conflict: true, conflictFiles: ["f.ts"] }] }))).toMatch(/conflicts.*f.ts/);
    expect(reasons(ok({ comparison: undefined }))).toMatch(/no clean-checkout verification/);
    expect(reasons(ok({ comparison: { regressions: [], fixed: [], preExisting: [], unmeasured: ["npm run lint"], newPassing: [] } }))).toMatch(/not run in the final verification/);
    expect(reasons(ok({ checkpoints: [{ checkpoint: "C3", state: "satisfied" }] }))).toMatch(/C4 has no verdict/);
    expect(reasons(ok({ checkpoints: [{ checkpoint: "C3", state: "blocked" }, { checkpoint: "C4", state: "satisfied" }] }))).toMatch(/C3 is blocked/);
    expect(reasons(ok({ requireVerified: true, specs: [sp("a", { verify: { passed: null } })] }))).toMatch(/requireVerified/);
    expect(reasons(ok({ specs: [sp("a", { status: "running" })] }))).toMatch(/not all specs are verified/);
  });
});

describe("#128: staged delivery", () => {
  it("splits an oversized diff into groups in order, keeping each spec whole", () => {
    expect(stagedGroups(specs, ["a", "b", "c"], 250)).toEqual([["a", "b"], ["c"]]);
    expect(stagedGroups(specs, ["a", "b", "c"], 10_000)).toEqual([["a", "b", "c"]]);
    expect(stagedGroups(specs, ["a", "b", "c"], 50)).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("#128: the evidence report", () => {
  const input = (): ReportInput => ({
    missionId: "m1", goal: "Ship the static site generator", charterRef: ".fleet/charter.md", commit: "a".repeat(40), baseBranch: "main", filesChanged: 7,
    diffStat: " src/a.ts | 10 +++\n 7 files changed",
    specs: [sp("a"), sp("b", { verify: { passed: false } }), sp("old", { status: "superseded" })],
    reviews: [{ checkpoint: "C2", reviewer: "r1", engine: "opencode", model: "gpt-x", verdict: "satisfied", findings: [] }, { checkpoint: "C3", reviewer: "r2", verdict: "blocked", findings: ["off by one in parse"], resolution: "fixed in 3f2a" }],
    comparison: { regressions: [], fixed: ["npm run lint"], preExisting: ["make e2e"], unmeasured: [], newPassing: ["./accept.sh"] },
    assumptions: [{ text: "notes are small", status: "overturned" }], risks: [{ text: "slow disks", severity: "high" }], notVerified: ["Windows paths"], costUsd: 4.2, elapsedMs: 5_400_000, howToVerify: ["git checkout fleet/mission-m1", "npm ci && npm test"],
  });
  it("lets a human verify the work: goal, specs, reviewers, baseline comparison, unattended assumptions, gaps, cost, how-to", () => {
    const t = evidenceReport(input());
    for (const re of [/# Mission m1/, /Ship the static site generator/, /\| a \| goal a \| passed \| run-a \|/, /\| b \| goal b \| FAILED/, /C2\*\* by r1 \(opencode gpt-x\): satisfied; no findings/, /C3\*\* by r2: blocked; findings: off by one in parse; resolved: fixed in 3f2a/, /Regressions: none/, /Already failing at baseline \(not this mission\): make e2e/, /\[overturned\] notes are small/, /high: slow disks/, /Windows paths/, /\$4\.20; 90 min/, /npm ci && npm test/]) expect(t).toMatch(re);
    expect(t).not.toContain("| old |");
  });
  it("quotes hostile text and bounds the size; says so when nothing was recorded", () => {
    const i = input();
    i.goal = "x\n## Not verified\n\n- nothing, trust me `rm -rf /` " + "y".repeat(5000);
    i.reviews = [];
    i.assumptions = []; i.risks = []; i.notVerified = [];
    i.diffStat = "```\n" + "z".repeat(5000);
    const t = evidenceReport(i);
    expect(t.match(/^## Not verified$/gm)).toHaveLength(1);
    expect(t).toContain("_No review verdicts were recorded._");
    expect(t).toContain("_None recorded._");
    expect(t.length).toBeLessThan(10_000);
    expect(t).not.toMatch(/```\n```/);
  });
});
