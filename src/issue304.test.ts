/**
 * Issue #304: the dispatch-readiness rubric.
 *
 * The deterministic baseline runs for free (no model call) and returns ACTIONABLE GUIDANCE when
 * a criterion fails — the "push back and guide" behaviour: a refused dispatch is never just "no",
 * it names what is missing and how to fix it. The S1 `readiness.dispatch` point is additive
 * evidence in shadow, compared against this baseline via pointReport before earning enforce.
 *
 * Contract:
 *   1. A well-formed spec is ready with no guidance.
 *   2. Each failed criterion produces a Guidance with the criterion id AND a concrete fix.
 *   3. The live failure ("determine why …") is caught as `concrete-change`.
 *   4. The rubric is pure: same spec, same verdict.
 */

import { describe, expect, it } from "vitest";
import { readinessOf, readinessSignals, READINESS_CRITERIA } from "./readiness.js";
import { BUILTIN_POINTS, pointById } from "./builtin-points.js";
import type { TaskSpec } from "./spec.js";

const GOOD: TaskSpec = {
  goal: "Add `verifyAnswer` to src/answer.ts returning 42 for input 6.",
  acceptance: ["verifyAnswer(6) returns 42"],
  verify: { command: "./scripts/check.sh" },
  scope: { files: ["src/answer.ts"] },
};

describe("#304: readinessBaseline — the deterministic, guided verdict", () => {
  it("a well-formed spec is ready with no guidance", () => {
    const r = readinessOf(GOOD);
    expect(r.ready).toBe(true);
    expect(r.guidance).toEqual([]);
  });

  it("the live failure ('determine why …') is caught, with a fix that names the remedy", () => {
    const spec: TaskSpec = { ...GOOD, goal: "Determine why the run-checkout link is orphaned across a restart." };
    const r = readinessOf(spec);
    expect(r.ready).toBe(false);
    const g = r.guidance.find((x) => x.criterion === "concrete-change");
    expect(g).toBeDefined();
    expect(g!.fix).toMatch(/diagnosis|state the change/i);
  });

  it("each failed criterion carries a concrete fix (never a bare 'no')", () => {
    const bare: TaskSpec = { goal: "Improve the design." };
    const r = readinessOf(bare);
    expect(r.ready).toBe(false);
    expect(r.guidance.length).toBeGreaterThan(0);
    for (const g of r.guidance) {
      expect(g.criterion).toBeTruthy();
      expect(g.what.length).toBeGreaterThan(0);
      expect(g.fix.length).toBeGreaterThan(0);
    }
  });

  it("a missing verify gate is its own criterion", () => {
    const r = readinessOf({ ...GOOD, verify: undefined });
    expect(r.guidance.map((x) => x.criterion)).toContain("verify-tests-acceptance");
  });

  it("quality-adjective-only acceptance is uncheckable; a concrete one is not", () => {
    expect(readinessSignals({ ...GOOD, acceptance: ["the design is clean"] }).acceptanceUncheckable).toBe(true);
    expect(readinessSignals({ ...GOOD, acceptance: ["f() returns 42"] }).acceptanceUncheckable).toBe(false);
    // "the tests pass" carries no assertable token, so the conservative heuristic flags it —
    // it wants something concrete. "scripts/verify.sh exits 0" names an exit, so it clears.
    expect(readinessSignals({ ...GOOD, acceptance: ["the tests pass"] }).acceptanceUncheckable).toBe(true);
    expect(readinessSignals({ ...GOOD, acceptance: ["scripts/verify.sh exits 0"] }).acceptanceUncheckable).toBe(false);
  });

  it("an unnamed deliverable with no scope is caught; a named one is not", () => {
    expect(readinessSignals({ goal: "make it better" }).noDeliverable).toBe(true);
    expect(readinessSignals(GOOD).noDeliverable).toBe(false);
  });

  it("is pure: same spec, same verdict", () => {
    const a = readinessOf(GOOD);
    const b = readinessOf(GOOD);
    expect(a).toEqual(b);
  });

  it("the rubric declares the six criteria as a versioned set", () => {
    expect(READINESS_CRITERIA.map((c) => c.id)).toEqual([
      "concrete-change",
      "deliverable-named",
      "decisions-made",
      "acceptance-checkable",
      "verify-tests-acceptance",
      "right-sized",
    ]);
    for (const c of READINESS_CRITERIA) {
      expect(c.what.length).toBeGreaterThan(0);
      expect(c.why.length).toBeGreaterThan(0);
      expect(c.fix.length).toBeGreaterThan(0);
    }
  });
});

describe("#304: the readiness.dispatch decision point", () => {
  it("is declared, shadow-only, with a push-back safe default (never a silent dispatch)", () => {
    const p = pointById("readiness.dispatch");
    expect(p).toBeDefined();
    expect(p!.mode).toBe("shadow");
    expect(p!.safeDefault).toBe("needs-clarification");
    expect(p!.uncertainAction).toBe("needs-clarification");
    expect(p!.question.wording).toMatch(/defined well enough/i);
  });
  it("the built-in set still parses with the new point", () => {
    expect(BUILTIN_POINTS.map((p) => p.id)).toContain("readiness.dispatch");
  });
});
