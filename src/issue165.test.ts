/**
 * Issue #165: S1 PROGRESS JUDGE inside fleet_iterate, shadow-first.
 *
 * fleet_iterate already escalates on no progress via STRING EQUALITY of
 * consecutive iteration fingerprints. This slice adds an OPTIONAL judgeProgress
 * param: when enabled, between iterations the S1 decider (decide() in
 * decision.ts) is asked a narrow stated-criteria boolean:
 *
 *   Given (a) the spec's acceptance criteria, (b) the previous attempt's
 *   failure output, and (c) this attempt's result + verify output, is this
 *   attempt strictly closer to the acceptance criteria than the last?
 *   -> probabilityTrue
 *
 * Behaviour contract:
 *   - Escalate when S1 judges progress unlikely (probabilityTrue below
 *     threshold, default 0.5) across TWO consecutive iterations — IN ADDITION
 *     to the existing string-equality check.
 *   - Fail-safe: any S1 failure/timeout/absent decision falls back to the
 *     deterministic string-diff result; S1 is additive evidence, never
 *     permission.
 *   - judgeProgress absent/false => byte-identical behaviour (decide() is
 *     never called, no fields added to the launch path).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgressQuestion, evaluateProgress, DEFAULT_PROGRESS_THRESHOLD } from "./progressJudge.js";
import { loadEntry, loadPlugin, nodeReply, type FakeNode, type Loaded } from "./testkit/plugin.js";

const entry = await loadEntry();

// ---------------------------------------------------------------------------
// Default arguments for evaluateProgress — every field optional except the
// sequence itself; the helper is deterministic and pure.
// ---------------------------------------------------------------------------

function evalArgs(over: Partial<Parameters<typeof evaluateProgress>[0]> = {}) {
  return {
    iterations: [] as Array<{ probabilityTrue?: number; error?: string; judgeError?: string; prevOutput?: string; nextOutput?: string }>,
    identicalConsecutive: false as boolean | undefined,
    decide: undefined as unknown as Parameters<typeof evaluateProgress>[0]["decide"],
    ...over,
  };
}

describe("issue #165: progress judge helper (pure)", () => {
  it("exports the S1 question builder and default threshold (0.5)", () => {
    expect(DEFAULT_PROGRESS_THRESHOLD).toBe(0.5);
    const q = buildProgressQuestion({
      acceptanceCriteria: "tests pass",
      prevFailureOutput: "Error: boom (iteration 2)",
      thisResult: "Error: boom (iteration 3)",
      verifyOutput: "verified: true",
    });
    expect(q.type).toBe("boolean");
    expect(q.instructions).toContain("strictly closer");
    expect(q.instructions).toContain("acceptance criteria");
    // All three named inputs must be present in the stated criteria.
    expect(q.instructions).toContain("tests pass");
    expect(q.instructions).toContain("Error: boom (iteration 2)");
    expect(q.instructions).toContain("Error: boom (iteration 3)");
    expect(q.instructions).toContain("verified: true");
  });

  it("two consecutive below-threshold S1 estimates => escalate", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [
          { probabilityTrue: 0.4 },
          { probabilityTrue: 0.3 },
        ],
        identicalConsecutive: false,
      }),
    );
    expect(r.escalate).toBe(true);
    expect(r.reason).toContain("S1");
    expect(r.s1Estimates).toEqual([0.4, 0.3]);
  });

  it("two consecutive at-or-above-threshold estimates => continue", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [
          { probabilityTrue: 0.5 },
          { probabilityTrue: 0.9 },
        ],
        identicalConsecutive: false,
      }),
    );
    expect(r.escalate).toBe(false);
  });

  it("one below then one above threshold => continue (needs TWO consecutive)", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [
          { probabilityTrue: 0.4 },
          { probabilityTrue: 0.7 },
        ],
      }),
    );
    expect(r.escalate).toBe(false);
    // And the reverse order (recovered then regressed once) also continues.
    const r2 = evaluateProgress(
      evalArgs({
        iterations: [
          { probabilityTrue: 0.8 },
          { probabilityTrue: 0.3 },
        ],
      }),
    );
    expect(r2.escalate).toBe(false);
  });

  it("identical strings (deterministic baseline) escalate even if S1 says progress", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [{ probabilityTrue: 1.0 }],
        identicalConsecutive: true,
      }),
    );
    expect(r.escalate).toBe(true);
    expect(r.reason).toContain("identical");
  });

  it("estimates strictly below the STRICT threshold (< not <=)", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [{ probabilityTrue: DEFAULT_PROGRESS_THRESHOLD }, { probabilityTrue: DEFAULT_PROGRESS_THRESHOLD }],
      }),
    );
    expect(r.escalate).toBe(false);
  });

  it("escalation evidence cites the S1 estimate AND deterministic signals", () => {
    const r = evaluateProgress(
      evalArgs({
        iterations: [{ probabilityTrue: 0.1 }, { probabilityTrue: 0.2 }],
        identicalConsecutive: false,
      }),
    );
    const text = `${r.reason} ${r.recommendation ?? ""}`;
    // S1 estimate cited…
    expect(text).toContain("0.1");
    expect(text).toContain("0.2");
    // …and the deterministic signals named (identical-output check status).
    expect(text).toContain("identical output");
  });
});

describe("issue #165: progress judge fail-safety", () => {
  it("S1 failure (undefined estimate) => falls back to string-diff result, does not throw", () => {
    // String-diff says progress (not identical) => continue despite two S1
    // failures: absent decisions are additive evidence, never permission.
    const r = evaluateProgress(
      evalArgs({
        iterations: [{ judgeError: "S1 request failed: connect ECONNREFUSED" }, { judgeError: "timeout" }],
        identicalConsecutive: false,
      }),
    );
    expect(r.escalate).toBe(false);
    expect(r.fallback).toBe(true);

    // String-diff says NO progress (identical) => escalate anyway.
    const r2 = evaluateProgress(
      evalArgs({
        iterations: [{ judgeError: "S1 returned HTTP 500" }],
        identicalConsecutive: true,
      }),
    );
    expect(r2.escalate).toBe(true);
    expect(r2.fallback).toBe(true);
  });

  it("decider is NOT invoked when judgeProgress is absent/false", () => {
    const onDecide = vi.fn();
    const r = evaluateProgress(evalArgs({ decide: onDecide }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(r.judgeUsed).toBe(false);
  });

  it("decider IS invoked exactly once per iteration with judgeProgress enabled", () => {
    // DecideTransport receives built questions; signature takes (q) -> estimate.
    const onDecide = vi.fn((q: unknown) => {
      void q;
      return { probabilityTrue: 0.6 };
    });
    const r = evaluateProgress(
      evalArgs({
        iterations: [{ prevOutput: "a", nextOutput: "b" }, { prevOutput: "b", nextOutput: "c" }],
        decide: onDecide,
      }),
    );
    expect(onDecide).toHaveBeenCalledTimes(2);
    expect(r.judgeUsed).toBe(true);
    expect(r.s1Estimates).toEqual([0.6, 0.6]);
  });
});

// ---------------------------------------------------------------------------
// Issue #165 review: TOOL-LEVEL wiring tests. These drive the REAL fleet_iterate
// tool (not the pure helper), so reverting the index.ts wiring makes them FAIL.
// A fake node returns a run result that never succeeds, forcing iterations.
// ---------------------------------------------------------------------------
describe.skipIf(!entry)("#165 wiring: fleet_iterate judgeProgress (tool level)", () => {
  let p: Loaded | undefined;
  const NODES: FakeNode[] = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] } as unknown as FakeNode];

  afterEach(() => { p?.dispose(); p = undefined; });

  // Every iteration reports the SAME failure => string-diff would escalate; we
  // assert judgeProgress is off by default (no S1 field anywhere in the result).
  it("judgeProgress absent => no S1 fields in the result (byte-identical)", async () => {
    let n = 0;
    p = loadPlugin(entry!, { nodes: NODES, invoke: () => nodeReply({ ok: false, summary: "still failing " + (n++), error: "boom" }) });
    const r = await p.call("fleet_iterate", { node: "dev2", cwd: "/w/p", prompt: "do it", maxIterations: 2 });
    expect(r.s1ProgressEstimates).toBeUndefined();
    expect(r.s1ShadowProgress).toBeUndefined();
  }, 30_000);

  it("judgeProgress on with NO expect => a judgeWarning is surfaced in the result", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: { s1: { mode: "shadow" } }, invoke: () => nodeReply({ ok: false, summary: "failing", error: "boom" }) });
    const r = await p.call("fleet_iterate", { node: "dev2", cwd: "/w/p", prompt: "do it", maxIterations: 2, judgeProgress: true });
    expect(String(r.judgeWarning ?? "")).toMatch(/no .*expect/i);
  }, 30_000);

  it("invalid progressThreshold is rejected before any launch", async () => {
    p = loadPlugin(entry!, { nodes: NODES, invoke: () => nodeReply({ ok: false, summary: "x" }) });
    const r = await p.call("fleet_iterate", { node: "dev2", cwd: "/w/p", prompt: "do it", judgeProgress: true, progressThreshold: 2 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/progressThreshold/);
    expect(p.invokes).toEqual([]);
  }, 30_000);
});
