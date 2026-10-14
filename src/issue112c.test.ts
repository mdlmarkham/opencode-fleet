import { describe, expect, it, vi } from "vitest";
import { isIntervention, observationFromRecord, renderReport, summarize, type BenchObservation } from "./benchmark.js";
import { runOne, type DispatchFn, type StatusFn } from "./bench-cli.js";

/**
 * Issue #112 bounded slice: intervention-rate tracking in the benchmark report.
 *
 * An intervention is a run a manager/human had to get involved in:
 * verified:false, aborted, hand-raise, failed gate. Derived from the fields
 * the fleet already records (ledger entry / run result / run status) — no new
 * ledger. The seeded records below are the REAL recorded shapes, not a
 * bespoke fixture.
 */

// A seeded mix of audit-shape records, as the ledger/node record them.
const auditRecords = [
  // A clean run: gated, passed, no hand-raise.
  { taskId: "t1", engine: "opencode", model: "glm", verified: true, durationMs: 10, costUsd: 0.01 },
  // The gate FAILED: a manager must look at it.
  { taskId: "t2", engine: "opencode", model: "glm", verified: false },
  // Hand-raise: the worker stopped to ask.
  { taskId: "t3", engine: "opencode", model: "glm", verified: true, handRaised: true, question: "which db?" },
  // Aborted.
  { taskId: "t4", engine: "opencode", model: "glm", state: "aborted" },
  // Verified false AND hand-raised is still ONE intervention, not two.
  { taskId: "t5", engine: "opencode", model: "glm", verified: false, handRaised: true },
] as const;

describe("#112: intervention derivation from audit records", () => {
  it("names exactly the abnormal outcomes as interventions", () => {
    expect(isIntervention({ verified: false })).toBe(true);
    expect(isIntervention({ handRaised: true })).toBe(true);
    expect(isIntervention({ state: "aborted" })).toBe(true);
    expect(isIntervention({ state: "timed-out" })).toBe(true);
    expect(isIntervention({ state: "failed" })).toBe(true);
    expect(isIntervention({ state: "failed-verification" })).toBe(true);
    expect(isIntervention({ gateTimedOut: true })).toBe(true);
    expect(isIntervention({ gateUnavailable: true })).toBe(true);
    expect(isIntervention({ failed: true })).toBe(true);
  });

  it("verified:true with no hand-raise is CLEAN — never folded into interventions", () => {
    expect(isIntervention({ verified: true })).toBe(false);
    expect(isIntervention({ verified: true, handRaised: false })).toBe(false);
  });

  it("verified:null WITHOUT a named abnormal cause is UNKNOWN, not an intervention (no double count)", () => {
    expect(isIntervention({ verified: null })).toBe(false);
    expect(isIntervention({})).toBe(false);
    // but null WITH a cause is an intervention
    expect(isIntervention({ verified: null, gateTimedOut: true })).toBe(true);
  });

  it("hand-raise and a failed gate are ONE intervention, not two", () => {
    expect(isIntervention({ verified: false, handRaised: true })).toBe(true);
  });

  it("derives intervened from a record shape, and carries the measurement fields", () => {
    const o = observationFromRecord({ taskId: "t1", engine: "opencode", model: "glm", verified: true, durationMs: 1200, tokens: 500, costUsd: 0.02 });
    expect(o).toEqual({ taskId: "t1", engine: "opencode", model: "glm", verified: true, durationMs: 1200, tokens: 500, costUsd: 0.02 });
    const bad = observationFromRecord({ taskId: "t2", engine: "opencode", verified: false, durationMs: 4000 });
    expect(bad.intervened).toBe(true);
  });

  it("a run that ended verified:null is untouched by an absent verified field (record predates the gate)", () => {
    const o = observationFromRecord({ taskId: "t3", engine: "pi", model: "m", durationMs: 3000 });
    expect(o.verified).toBeNull();
    expect(o.intervened).toBeUndefined();
  });
});

describe("#112: intervention-rate flows into the per-combo report", () => {
  it("computes the intervention rate over ALL runs (clean + intervened)", () => {
    const rows = summarize(observationFromRecords(auditRecords));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.runs).toBe(5);
    expect(r.unknown).toBe(1); // the aborted run has no gate outcome
    expect(r.verifiedRate).toBeCloseTo(2 / 4); // decided: clean, failed gate, hand-raised pass, failed+hand-raised
    expect(r.interventionRate).toBeCloseTo(4 / 5); // failed gate, hand-raise, abort, failed+hand-raised
  });

  it("SEPARATES the rates: verified:false is an unknown for verified-rate but IS an intervention", () => {
    const rows = summarize([
      observationFromRecord({ taskId: "a", engine: "e", verified: false }),
      observationFromRecord({ taskId: "b", engine: "e", verified: null }),
    ]);
    expect(rows[0].verifiedRate).toBe(0); // decided=1 (the failed gate), unknown=1
    expect(rows[0].unknown).toBe(1);
    expect(rows[0].interventionRate).toBeCloseTo(0.5); // only the failed gate
  });

  it("renders the intervention column deterministically", () => {
    const rows = summarize(observationFromRecords(auditRecords));
    const txt = renderReport(rows, "1");
    expect(txt).toContain("verified 50% on n=5 (1 unknown)");
    expect(txt).toMatch(/intervene 80%/);
  });

  it("REGRESSION: the report is WRONG if the intervention derivation is removed", () => {
    // Simulate the derivation being deleted from the wiring: every record is
    // reduced to its verified/failed fields only (no intervened flag, no
    // handRaised/state read). The suite must be able to TELL.
    const stripped = observationFromRecords(auditRecords).map((o) => {
      const { ...bare } = o;
      return { ...bare, intervened: undefined } as BenchObservation;
    });
    const rows = summarize(stripped);
    const kept = summarize(observationFromRecords(auditRecords));
    expect(rows.every((r) => r.interventionRate === 0), "stripping must CHANGE the rate").toBe(true);
    expect(kept[0].interventionRate).toBeCloseTo(4 / 5);
    // And the derived rate must survive the wire into the report text.
    expect(renderReport(kept, "1")).toMatch(/intervene 80%/);
    expect(renderReport(rows, "1")).toMatch(/intervene 0%/);
  });

  it("runOne stamps the intervention on a live observation (derived, and overridable)", async () => {
    const dispatch: DispatchFn = vi.fn(async () => ({ runId: "r" }));
    const status: StatusFn = async () => ({ verified: false, failed: false, handRaised: true });
    const o = await runOne("dev2", "t", "g", { command: "true" }, { engine: "opencode" }, dispatch, status);
    expect(o.intervened).toBe(true);

    const statusClean: StatusFn = async () => ({ verified: true, failed: false });
    const clean = await runOne("dev2", "t", "g", { command: "true" }, { engine: "opencode" }, dispatch, statusClean);
    expect(clean.intervened).toBeUndefined();

    // An explicit override from the record reader wins over the derivation.
    // (Cast: the wire may carry the flag even though the happy-path status
    // type does not declare it — the runner must still honor it.)
    const override = (async () => ({ verified: true, failed: false, intervened: true })) as unknown as StatusFn;
    const withOverride = await runOne("dev2", "t", "g", { command: "true" }, { engine: "opencode" }, dispatch, override);
    expect(withOverride.intervened).toBe(true);
  });
});

/** Local helper: records array -> observations (the seeded list is readonly). */
function observationFromRecords(records: ReadonlyArray<{ taskId: string; engine: string; model?: string; verified?: boolean | null; handRaised?: boolean | null; question?: string; state?: string; failed?: boolean; durationMs?: number; tokens?: number; costUsd?: number; gateTimedOut?: boolean; gateUnavailable?: boolean }>): BenchObservation[] {
  return records.map((r) => observationFromRecord(r));
}