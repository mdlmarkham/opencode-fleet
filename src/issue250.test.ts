/**
 * Issue #250: `progress.rubric` — a per-tick convergence verdict against the
 * charter's success criteria.
 *
 * The mission loop knew only per-run verify gates; nothing asked "is this
 * mission ON TRACK against its charter, or done?". This adds the verdict as a
 * deterministic baseline (the loop is never blind when S1 is down) plus a
 * shadow-only decision point the registry can later promote.
 *
 * Contract:
 *   1. `rubricBaseline` returns: blocked (a spec escalated) > on-track (specs
 *      remain) > drifting (all specs done, a criterion unchecked) > converged
 *      (all specs done AND every provided criterion passed).
 *   2. The `progress.rubric` built-in point exists, is shadow, with a safe
 *      default and an uncertain action (never a blank default).
 *   3. A mission tick records the verdict as a `progress-rubric` journal entry
 *      and reports it on the TickResult — every tick, regardless of phase move.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POINTS, pointById, rubricBaseline } from "./builtin-points.js";
import { tick, type TickDeps } from "./mission-runner.js";
import { createMission, readJournal, setPhase } from "./mission-store.js";

describe("#250: rubricBaseline (pure, the deterministic verdict)", () => {
  it("blocked wins over everything when a spec escalated", () => {
    expect(rubricBaseline({ specsTotal: 2, specsDone: 2, escalated: 1, criteriaTotal: 3, criteriaPassed: 3 })).toBe("blocked");
  });
  it("on-track while specs remain", () => {
    expect(rubricBaseline({ specsTotal: 3, specsDone: 1, escalated: 0, criteriaTotal: 0, criteriaPassed: 0 })).toBe("on-track");
  });
  it("drifting when all specs are done but a criterion is unchecked or unmet", () => {
    expect(rubricBaseline({ specsTotal: 2, specsDone: 2, escalated: 0, criteriaTotal: 3, criteriaPassed: 2 })).toBe("drifting");
    // a mission with NO criteria provided cannot claim convergence — it drifts
    expect(rubricBaseline({ specsTotal: 2, specsDone: 2, escalated: 0, criteriaTotal: 0, criteriaPassed: 0 })).toBe("drifting");
  });
  it("converged only when every spec is done AND every provided criterion passed", () => {
    expect(rubricBaseline({ specsTotal: 2, specsDone: 2, escalated: 0, criteriaTotal: 3, criteriaPassed: 3 })).toBe("converged");
  });
  it("an empty mission is on-track (nothing to converge yet)", () => {
    expect(rubricBaseline({ specsTotal: 0, specsDone: 0, escalated: 0, criteriaTotal: 0, criteriaPassed: 0 })).toBe("on-track");
  });
});

describe("#250: the progress.rubric decision point is declared, shadow, with a safe default", () => {
  it("exists with a safeDefault and uncertainAction, and is shadow", () => {
    const p = pointById("progress.rubric");
    expect(p).toBeDefined();
    expect(p!.mode).toBe("shadow");
    expect(p!.safeDefault.length).toBeGreaterThan(0);
    expect(p!.uncertainAction.length).toBeGreaterThan(0);
  });
  it("asks about convergence (high probabilityTrue = converged)", () => {
    const p = pointById("progress.rubric")!;
    expect(p.question.wording).toMatch(/success criteria/i);
  });
  it("the built-in set parses (no invalid point)", () => {
    expect(BUILTIN_POINTS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("#250: a mission tick records the verdict every tick", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet250-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const specs = [{ id: "a", goal: "first", deps: [] as string[] }];

  it("an executing mission with a pending spec reports on-track and journals the verdict", async () => {
    await createMission(root, "m1", specs as never);
    await setPhase(root, "m1", "awaiting-approval", "d");
    await setPhase(root, "m1", "executing", "ok");
    const deps: TickDeps = {
      nowMs: () => 1_000_000,
      freeSlots: async () => ({ n1: 4 }),
      launch: async (a) => ({ ok: true, runId: `run-${a.specId}` }),
      reconcile: async () => ({ state: "unknown" }),
      poll: async () => ({}),
    };
    const r = await tick(root, "m1", deps);
    expect(r.verdict).toBe("on-track");
    const journal = await readJournal(root, "m1");
    expect(journal.some((e) => (e as { type?: string }).type === "progress-rubric")).toBe(true);
  });
});
