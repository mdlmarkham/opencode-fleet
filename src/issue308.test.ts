/**
 * Issue #308: the readiness rubric applied to EVERY prompt sent to a code agent, not only
 * spec-path dispatches. A prompt-only dispatch is the MORE dangerous case (no verify, no scope)
 * and used to bypass the rubric entirely.
 *
 * The load-bearing idea is the TRIVIALITY EXEMPTION: a gate that nags on harmless prompts
 * ("reply with exactly: OK", a self-check) gets ignored, so the rubric judges only SUBSTANTIVE
 * prompts and returns `undefined` for a probe.
 *
 * Contract:
 *   1. A probe / short prompt is NOT judged (`undefined`).
 *   2. A substantive prompt IS judged against the criteria a prompt can satisfy.
 *   3. The live failure shape ("determine why …") is caught on the prompt path too.
 *   4. A substantive, well-formed prompt is ready with no guidance.
 */

import { describe, expect, it } from "vitest";
import { isSubstantivePrompt, readinessOfPrompt } from "./readiness.js";

describe("#308: triviality exemption — probes are not judged", () => {
  it("a bare probe is not substantive", () => {
    for (const p of ["Reply with exactly: OK. Nothing else.", "say ok", "print hello", "echo hi", "run the tests"]) {
      expect(isSubstantivePrompt(p), p).toBe(false);
      expect(readinessOfPrompt(p), p).toBeUndefined();
    }
  });

  it("a short prompt is not substantive, however phrased", () => {
    expect(isSubstantivePrompt("fix it")).toBe(false);
  });

  it("a substantive multi-line prompt IS judged", () => {
    const p = "Make the parser handle empty input without throwing.\nAcceptance: parse('') returns null.\nOnly touch src/parse.ts.";
    expect(isSubstantivePrompt(p)).toBe(true);
    expect(readinessOfPrompt(p)).toBeDefined();
  });
});

describe("#308: the prompt path catches the same failures as the spec path", () => {
  it("the live failure ('determine why …') is caught on the prompt path", () => {
    const p = "Determine why the run-checkout link is orphaned across a node restart, and report what you find.";
    const r = readinessOfPrompt(p);
    expect(r).toBeDefined();
    expect(r!.ready).toBe(false);
    expect(r!.guidance.map((g) => g.criterion)).toContain("concrete-change");
    expect(r!.guidance.find((g) => g.criterion === "concrete-change")!.fix).toMatch(/diagnosis|state the change/i);
  });

  it("a substantive prompt naming no deliverable is flagged, with a fix", () => {
    const p = "Improve the error handling in the codebase so that failures are reported more clearly to the user.";
    const r = readinessOfPrompt(p);
    expect(r).toBeDefined();
    expect(r!.guidance.map((g) => g.criterion)).toContain("deliverable-named");
    expect(r!.guidance.find((g) => g.criterion === "deliverable-named")!.fix.length).toBeGreaterThan(0);
  });

  it("a substantive, well-formed prompt is ready with no guidance", () => {
    const p = "Add `parseEmpty` to src/parse.ts returning null for an empty string, with a test in src/parse.test.ts.";
    const r = readinessOfPrompt(p);
    expect(r).toBeDefined();
    expect(r!.ready).toBe(true);
    expect(r!.guidance).toEqual([]);
  });

  it("is pure: same prompt, same verdict", () => {
    const p = "Determine why the cache misses are frequent under load, and report the cause.";
    expect(readinessOfPrompt(p)).toEqual(readinessOfPrompt(p));
  });

  it("every guidance item carries a concrete fix (never a bare 'no')", () => {
    const r = readinessOfPrompt("Determine why something is broken and let me know what you think the issue might be.");
    expect(r).toBeDefined();
    for (const g of r!.guidance) {
      expect(g.criterion).toBeTruthy();
      expect(g.what.length).toBeGreaterThan(0);
      expect(g.fix.length).toBeGreaterThan(0);
    }
  });
});
