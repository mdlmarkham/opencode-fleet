import { describe, expect, it } from "vitest";
import { applyNudgeBudget, regretReport, wentBadly } from "./override-regret.js";
import type { LedgerEntry } from "./ledger.js";
import { upsertRun } from "./ledger.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

let n = 0;
const run = (ids: string[], bad: boolean, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ runId: `r${n++}`, node: "n", cwd: "/w", prompt: "p", startedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:05:00.000Z", state: bad ? "failed-verification" : "completed", filesChanged: 1, design: { verdict: "accept-with-nudges", objectionIds: ids }, ...extra }) as LedgerEntry;

describe("#119: wentBadly", () => {
  it("failed, failed gate, scope violations and a clean no-op are bad; a clean change is not", () => {
    expect(wentBadly(run([], true))).toBe(true);
    expect(wentBadly(run([], false, { scopeViolations: ["x"] }))).toBe(true);
    expect(wentBadly(run([], false, { filesChanged: 0 }))).toBe(true);
    expect(wentBadly(run([], false))).toBe(false);
    expect(wentBadly(run([], false, { filesChanged: undefined }))).toBe(false);
  });
});

describe("#119: regretReport on a synthetic history", () => {
  // spec.no-verify: fired on 12 runs, 9 bad. spec.no-scope: fired on 12 runs, 1 bad. Control (neither) 12 runs, 2 bad.
  const history = [
    ...Array.from({ length: 12 }, (_, i) => run(["spec.no-verify"], i < 9, i < 3 ? { gateAcknowledged: [{ objectionId: "spec.no-verify", reason: "r" }] } : {})),
    ...Array.from({ length: 12 }, (_, i) => run(["spec.no-scope"], i < 1)),
    ...Array.from({ length: 12 }, (_, i) => run([], i < 2)),
  ];
  const r = regretReport(history);
  it("ranks by regret, labels right vs noise, and proposes edits with the evidence", () => {
    expect(r.objections.map((o) => [o.objectionId, o.verdict])).toEqual([["spec.no-scope", "noise"], ["spec.no-verify", "right"]].reverse());
    const nv = r.objections.find((o) => o.objectionId === "spec.no-verify")!;
    expect(nv).toMatchObject({ overridden: 3, overriddenBad: 3 });
    expect(nv.proposal).toMatch(/9\/12 runs where it fired went badly vs 3\/24/);
    expect(nv.proposal).toMatch(/correlated/);
    expect(r.objections.find((o) => o.objectionId === "spec.no-scope")!.proposal).toMatch(/downgrading/);
  });
  it("withholds any verdict below the minimum sample and changes nothing", () => {
    const small = regretReport(history.slice(0, 5));
    expect(small.objections.every((o) => o.verdict === "insufficient" && o.proposal === undefined && o.fired.badRate === null)).toBe(true);
    expect(JSON.stringify(history)).toContain("spec.no-verify"); // input untouched
  });
  it("ignores runs with no recorded design and unfinished runs; stores ids and counts, not prompts", () => {
    const rr = regretReport([run(["a"], true, { state: "running" }), { ...run(["a"], true), design: undefined }]);
    expect(rr.runs).toBe(0);
    expect(JSON.stringify(r)).not.toContain('"prompt"');
  });
});

describe("#119: nudge budget", () => {
  const obs = [{ id: "a", severity: "nudge" }, { id: "b", severity: "nudge" }, { id: "c", severity: "block-candidate" }, { id: "d", severity: "nudge" }];
  it("drops the lowest-value nudges first, never a blocker, and is a no-op under budget", () => {
    const report = { runs: 0, minN: 10, note: "", objections: [{ objectionId: "b", verdict: "noise" }, { objectionId: "d", verdict: "right" }] } as never;
    expect(applyNudgeBudget(obs, 2, report).map((o) => o.id)).toEqual(["a", "c", "d"]);
    expect(applyNudgeBudget(obs, 0).map((o) => o.id)).toEqual(["c"]);
    expect(applyNudgeBudget(obs, 5)).toEqual(obs);
  });
});

describe("#119: surfaced in fleet_spec_quality", () => {
  it("adds the regret section", async () => {
    const t = loadPlugin((await loadEntry())!, {});
    try {
      await upsertRun(t.rootDir, run(["spec.no-verify"], true, { runId: "x1" }));
      const r = await t.call("fleet_spec_quality", {});
      expect(r.regret).toMatchObject({ runs: 1, objections: [{ objectionId: "spec.no-verify", verdict: "insufficient" }] });
    } finally { t.dispose(); }
  });
});
