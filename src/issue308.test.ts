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

  it("whether a prompt names its deliverable is the S1 judge's call, not the fallback's (see issue308b)", () => {
    const p = "Improve the error handling in the codebase so that failures are reported more clearly to the user.";
    const r = readinessOfPrompt(p);
    expect(r).toBeDefined();
    expect(r!.guidance.map((g) => g.criterion)).not.toContain("deliverable-named");
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

describe("#308 review fix: ordinary work is not flagged (false positives are worse than misses)", () => {
  const READY_PROMPTS = [
    "Refactor the retry logic in the ledger module to use exponential backoff with jitter, keeping the public API unchanged",
    "Add a --json flag to the status command so scripts can parse the output, and document it in the README",
    "Debug logging should include the run id on every ledger write so we can trace runs",
    "Investigate and fix the flaky timeout in the issue30 test by raising the bound where it is too tight",
  ];
  for (const p of READY_PROMPTS) it(`stays ready: ${p.slice(0, 48)}…`, () => {
    expect(readinessOfPrompt(p), p).toMatchObject({ ready: true, guidance: [] });
  });
  it("the discovery prompts are still caught (same check as the design gate)", () => {
    expect(readinessOfPrompt("Figure out why fleet_sync reports unverified runs after a restart, and tell me.")!.guidance.map((g) => g.criterion)).toContain("concrete-change");
  });
});

