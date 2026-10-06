import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkeleton, checkTimeBox, overturnedCount, pickSkeleton, planReadiness, planStaleness, type Plan, type PlanSpec } from "./mission-plan.js";
import { addAssumption, createMission, loadMission, readJournal } from "./mission-store.js";

const spec = (id: string, o: Partial<PlanSpec> = {}): PlanSpec => ({ id, goal: id, acceptance: ["`npm test` exits 0"], verify: { command: "./v.sh" }, scope: { files: [`src/${id}/`] }, ...o });
const plan = (o: Partial<Plan> = {}): Plan => ({ specs: [spec("a"), spec("b", { deps: ["a"] })], testPlan: { writtenBeforeCode: true, items: ["unit tests for a"] }, risks: [{ id: "r1", text: "slow", severity: "medium", owner: "kev", mitigation: "cache" }], assumptions: [{ text: "notes are small", check: "skeleton parses 10k notes" }], questions: [{ text: "which db?", answer: "sqlite" }], budget: { maxCostUsd: 20 }, ...o });

describe("#129: readiness", () => {
  it("a complete plan is ready", () => expect(planReadiness(plan())).toEqual({ verdict: "ready", missing: [] }));
  it("a plan with no test plan or untestable acceptance is needs-more, with specifics", () => {
    const r = planReadiness(plan({ testPlan: undefined, specs: [spec("a", { acceptance: ["it works properly"], verify: undefined })] }));
    expect(r.verdict).toBe("needs-more");
    expect(r.missing).toEqual(expect.arrayContaining([{ area: "test plan", what: "no test plan" }, { area: "spec a", what: expect.stringContaining("untestable") }, { area: "spec a", what: "no verify gate" }]));
  });
  it("catches a test plan written after the code, ownerless risks, unchecked assumptions, open questions, no budget, overlapping scopes, missing scope/acceptance", () => {
    const r = planReadiness(plan({
      testPlan: { writtenBeforeCode: false, items: ["x"] },
      risks: [{ id: "r2", text: "t", severity: "high" }],
      assumptions: [{ text: "a thing nobody can check" }],
      questions: [{ text: "which db?" }],
      budget: {},
      specs: [spec("a", { scope: { files: ["src/"] } }), spec("b", { scope: { files: ["src/x.ts"] } }), spec("c", { acceptance: [], scope: undefined })],
    }));
    const text = r.missing.map((m) => `${m.area}: ${m.what}`).join("\n");
    for (const re of [/not written before the code/, /risk r2: .*owner and a mitigation/, /no way to be confirmed/, /neither answered nor deferred/, /budget: no budget/, /specs a and b overlap/, /spec c: no acceptance/, /spec c: no scope/]) expect(text).toMatch(re);
  });
  it("a deferred question and dependent specs with shared scope are fine", () => {
    expect(planReadiness(plan({ questions: [{ text: "q", deferredAsRisk: "r1" }], specs: [spec("a", { scope: { files: ["src/"] } }), spec("b", { deps: ["a"], scope: { files: ["src/x.ts"] } })] })).verdict).toBe("ready");
  });
});

describe("#129: time-box", () => {
  const box = { maxMs: 3_600_000, maxUsd: 5 };
  it("within, then forces a decision rather than more analysis", () => {
    expect(checkTimeBox({ startedAtMs: 0, spentUsd: 1, nowMs: 600_000 }, box)).toEqual({ state: "within", remainingMs: 3_000_000 });
    expect(checkTimeBox({ startedAtMs: 0, spentUsd: 1, nowMs: 4_000_000 }, box)).toMatchObject({ state: "exceeded", options: ["proceed-with-recorded-risk", "narrow-scope"], why: expect.stringContaining("over the 60 min box") });
    expect(checkTimeBox({ startedAtMs: 0, spentUsd: 9, nowMs: 1 }, box)).toMatchObject({ state: "exceeded", why: expect.stringContaining("$9.00") });
  });
});

describe("#129: walking skeleton", () => {
  it("picks the marked spec, else the root the most specs hang off", () => {
    expect(pickSkeleton([spec("a"), spec("b", { skeleton: true })])).toBe("b");
    expect(pickSkeleton([spec("a"), spec("b"), spec("c", { deps: ["b"] }), spec("d", { deps: ["b"] })])).toBe("b");
    expect(pickSkeleton([])).toBeUndefined();
  });
  describe("durable", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet129-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const specs = [{ id: "a", goal: "g", deps: [] }];
    it("a skeleton that overturns an assumption triggers a recorded replan before the bulk of the work", async () => {
      await createMission(root, "m1", specs);
      await addAssumption(root, "m1", "notes are small", "agent");
      await addAssumption(root, "m1", "sqlite is enough", "agent");
      const r = await applySkeleton(root, "m1", [{ assumptionId: "a1", status: "overturned", evidence: "50k notes took 40 min" }, { assumptionId: "a2", status: "confirmed", evidence: "queries fast" }]);
      expect(r).toMatchObject({ ok: true, replan: true, record: { planVersion: 2, planDiffs: [{ version: 2, summary: expect.stringContaining("a1") }] } });
      const m = await loadMission(root, "m1");
      expect(m.ok && overturnedCount(m.record)).toEqual({ overturned: 1, total: 2 });
      const j = await readJournal(root, "m1");
      expect(j.map((e) => e.type)).toEqual(expect.arrayContaining(["assumption-overturned", "assumption-confirmed", "replan-triggered"]));
    });
    it("all confirmed means no replan; an unknown assumption is refused and changes nothing", async () => {
      await createMission(root, "m1", specs);
      await addAssumption(root, "m1", "x", "agent");
      expect(await applySkeleton(root, "m1", [{ assumptionId: "a1", status: "confirmed", evidence: "ok" }])).toMatchObject({ ok: true, replan: false, record: { planVersion: 1 } });
      expect(await applySkeleton(root, "m1", [{ assumptionId: "zz", status: "overturned", evidence: "?" }])).toMatchObject({ ok: false });
      const m = await loadMission(root, "m1");
      expect(m.ok && m.record.planVersion).toBe(1);
    });
  });
});

describe("#129: staleness", () => {
  const specs = [{ id: "a", scope: { files: ["src/a/"] }, status: "pending" as const }, { id: "b", scope: { files: ["src/b/"] }, status: "verified" as const }];
  const base = { changedOnDefault: [], specs, baselineWasPassing: true, baselineNowPassing: true, dependencyFilesChanged: false };
  it("nothing moved: continue", () => expect(planStaleness(base)).toEqual({ outcome: "continue", evidence: [] }));
  it("a scoped file changed on the default branch is flagged before the next stage: replan if pending, escalate if already built", () => {
    expect(planStaleness({ ...base, changedOnDefault: ["src/a/x.ts", "README.md"] })).toMatchObject({ outcome: "replan", evidence: [expect.stringContaining("src/a/x.ts changed on the default branch inside spec a's scope (pending)")] });
    expect(planStaleness({ ...base, changedOnDefault: ["src/b/y.ts"] }).outcome).toBe("escalate");
  });
  it("a new failing baseline escalates; changed dependencies replan; escalate outranks replan", () => {
    expect(planStaleness({ ...base, baselineNowPassing: false })).toMatchObject({ outcome: "escalate" });
    expect(planStaleness({ ...base, changedOnDefault: ["package.json"] })).toMatchObject({ outcome: "replan", evidence: ["dependency manifests changed on the default branch"] });
    expect(planStaleness({ ...base, changedOnDefault: ["package-lock.json", "src/b/y.ts"] }).outcome).toBe("escalate");
    expect(planStaleness({ ...base, baselineWasPassing: null, baselineNowPassing: false }).outcome).toBe("continue");
  });
});
