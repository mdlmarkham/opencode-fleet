/**
 * Issue #269: a dead detached run must not hold a slot or read as in-flight.
 *
 * Observed live 2026-10-06: a reviewer run killed mid-step by a gateway restart
 * left the ledger at `state: "running", alive: false` with no completion record,
 * and nothing settled it. It held a concurrency slot and made `fleet_board`
 * report "nothing needs attention" while the ledger disagreed.
 *
 * Contract of `reconcileDeadRuns` (pure over the entry list + what a caller
 * observed for each run):
 *   1. running + observed `alive:false` + no completion record -> settled `failed`.
 *   2. running + a completion record (`finishedAt`) -> UNTOUCHED (the run-result
 *      path owns the terminal state and the gate classification).
 *   3. running + alive, or not observed at all -> UNTOUCHED (never void live work,
 *      never touch a run the caller was not told about).
 *   4. non-running entries are never touched.
 */

import { describe, expect, it } from "vitest";
import { reconcileDeadRuns, type LedgerEntry } from "./ledger.js";

const run = (over: Partial<LedgerEntry> & { runId: string }): LedgerEntry => ({
  node: "dev2",
  cwd: "/w",
  prompt: "x",
  startedAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
  state: "running",
  ...over,
} as LedgerEntry);

describe("#269: reconcileDeadRuns settles a dead, record-less run", () => {
  it("running + alive:false + no finishedAt -> failed", () => {
    const runs = [run({ runId: "r1" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map([["r1", { alive: false }]]));
    expect(settled).toEqual(["r1"]);
    expect(out[0].state).toBe("failed");
    expect(String(out[0].summary)).toMatch(/no completion record/i);
  });

  it("running + a completion record -> untouched (the run-result path owns it)", () => {
    const runs = [run({ runId: "r1" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map([["r1", { alive: false, finishedAt: "2026-10-06T00:01:00Z" }]]));
    expect(settled).toEqual([]);
    expect(out[0].state).toBe("running");
  });

  it("running + alive -> untouched (never void a live run)", () => {
    const runs = [run({ runId: "r1" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map([["r1", { alive: true }]]));
    expect(settled).toEqual([]);
    expect(out[0].state).toBe("running");
  });

  it("a run the caller did not observe is untouched", () => {
    const runs = [run({ runId: "r1" }), run({ runId: "r2" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map([["r1", { alive: false }]]));
    expect(settled).toEqual(["r1"]);
    expect(out.find((r) => r.runId === "r2")!.state).toBe("running");
  });

  it("non-running entries are never touched", () => {
    const runs = [run({ runId: "r1", state: "completed" }), run({ runId: "r2", state: "failed" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map([["r1", { alive: false }], ["r2", { alive: false }]]));
    expect(settled).toEqual([]);
    expect(out.map((r) => r.state)).toEqual(["completed", "failed"]);
  });

  it("an empty observation map changes nothing (and returns the same entries)", () => {
    const runs = [run({ runId: "r1" })];
    const { runs: out, settled } = reconcileDeadRuns(runs, new Map());
    expect(settled).toEqual([]);
    expect(out).toEqual(runs);
  });
});
