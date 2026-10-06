/**
 * Issue #288: the design gate could never say `needs-design`.
 *
 * Observed live 2026-10-06: a spec that asked the worker to "determine why a
 * restart orphans the run→checkout link" burned 28 minutes and 287k tokens before
 * hitting the wall-clock limit and returning an EMPTY clone. It passed every shape
 * check — it had acceptance criteria, a verify gate, and a scope — because the
 * checks measured form, not intent. `needs-design` was declared in the Verdict
 * vocabulary and emitted by no check.
 *
 * Contract of `discoverySignal` / the gate:
 *   1. A goal that asks the worker to DISCOVER a cause or design (determine why,
 *      figure out, investigate, diagnose, propose a design) => `spec.needs-design`,
 *      verdict `needs-design`, blocked.
 *   2. A merely investigation-flavoured goal (explore/consider/approach) nudges on
 *      its own; two or more become `spec.design-adjacent`.
 *   3. A concrete change ("add x", "rename y to z") is unaffected — no new objection.
 *   4. A `needs-design` objection can be acknowledged (it is block-candidate), and
 *      acknowledging it clears the verdict — the escape hatch stays open.
 *   5. `needs-design` outranks `decompose`: splitting an unanswerable spec does not
 *      make it answerable.
 */

import { describe, expect, it } from "vitest";
import { discoverySignal, evaluateDesignGate } from "./design-gate.js";
import type { TaskSpec } from "./spec.js";

const GOOD: TaskSpec = { goal: "add x", acceptance: ["x works"], verify: { command: "scripts/check.sh" }, scope: { files: ["src/x/"] } };
const gate = (spec: TaskSpec, acks: Array<{ objectionId: string; reason: string }> = []) => {
  const r = evaluateDesignGate(spec, {}, acks);
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
const ids = (goal: string) => gate({ ...GOOD, goal }).objections.map((o) => o.id);

describe("#288: an open-ended investigation is needs-design, not a dispatch", () => {
  it("the exact live failure: 'determine why … orphans …' is needs-design", () => {
    const spec: TaskSpec = {
      ...GOOD,
      goal: "Determine why the run→checkout link is orphaned across a node restart and fix it.",
    };
    const r = gate(spec);
    expect(r.verdict).toBe("needs-design");
    expect(r.blocked).toBe(true);
    expect(r.objections.map((o) => o.id)).toContain("spec.needs-design");
  });

  it("other strong discovery phrasings are caught", () => {
    for (const goal of [
      "Figure out why the ledger loses its link after a restart.",
      "Investigate the cause of the orphaned entries.",
      "Diagnose the restart-orphan bug.",
      "Find the root cause of the failure.",
      "Propose a design for the merge queue.",
      "Evaluate the options for scheduler placement.",
    ]) {
      expect(ids(goal), goal).toContain("spec.needs-design");
    }
  });

  it("a concrete change is unaffected", () => {
    expect(ids("add x")).not.toContain("spec.needs-design");
    expect(ids("rename the field to startedAtMs and update callers")).not.toContain("spec.needs-design");
    expect(ids("add a test proving the digest changes when a deep module changes")).not.toContain("spec.needs-design");
    expect(gate(GOOD).verdict).toBe("accept");
  });

  // Independent review (2026-10-06) found the first cut false-positived on ordinary
  // tasks; under project.gate:"enforce" a block-candidate STOPS a normal dispatch, so
  // precision matters more than recall. These are the reviewer's exact counterexamples
  // — every one must NOT be needs-design.
  it("REVIEW: ordinary tasks with design/plan/diagnose/why-not wording are NOT flagged", () => {
    for (const goal of [
      "Add a plan field to the mission record",
      "Add a design section to the README explaining the gate",
      "Rename why-not-retry to explain-retry",
      "Diagnose output should be redacted: add redaction to the diagnose helper",
      // Re-review finding: IMPERATIVE_TAIL must be ANCHORED to the text right after the verb,
      // else a later `a`/`the` satisfies it — `troubleshoot` + "... a section" was a false block.
      "Troubleshoot guide: add a section for dispatch failures",
      "Debug logging should include the run id",
      "Use the debug flag",
    ]) {
      expect(ids(goal), goal).not.toContain("spec.needs-design");
      expect(gate({ ...GOOD, goal }).verdict, goal).not.toBe("needs-design");
    }
  });

  it("REVIEW: a goal that names a concrete change verb is a fix, even with investigation wording", () => {
    // "Investigate and fix ..." names `fix` — it is a fix, not a discovery.
    expect(ids("Investigate and fix the flaky timeout in issue30.test.ts")).not.toContain("spec.needs-design");
    expect(ids("diagnose and then update the helper")).not.toContain("spec.needs-design");
  });

  it("weak investigation flavour nudges alone; two or more are design-adjacent", () => {
    // one soft phrase: no objection (it is genuinely weak on its own)
    expect(ids("explore the caching layer")).not.toContain("spec.design-adjacent");
    // two or more: design-adjacent
    expect(ids("consider the trade-offs and decide the approach")).toContain("spec.design-adjacent");
  });

  it("needs-design outranks decompose (splitting an unanswerable spec does not help)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/m${i}/`);
    const r = gate({ ...GOOD, goal: "determine why x breaks", scope: { files: many } });
    expect(r.verdict).toBe("needs-design");
  });

  it("the escape hatch stays open: acknowledging needs-design clears it", () => {
    const spec: TaskSpec = { ...GOOD, goal: "determine why x breaks" };
    const blocked = gate(spec);
    expect(blocked.verdict).toBe("needs-design");
    const acked = gate(spec, [{ objectionId: "spec.needs-design", reason: "diagnosis done in a session; this is the defined fix" }]);
    expect(acked.verdict).toBe("accept-with-nudges");
    expect(acked.blocked).toBe(false);
  });

  it("discoverySignal is pure and reports what it matched", () => {
    expect(discoverySignal({ goal: "determine why the link is orphaned" }).phrases.length).toBeGreaterThan(0);
    expect(discoverySignal({ goal: "add a test" }).phrases).toEqual([]);
    expect(discoverySignal({ goal: "add a test" }).soft).toEqual([]);
  });
});
