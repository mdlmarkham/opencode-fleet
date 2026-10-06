/**
 * Issue #259 slice 1: tests for the pure task cost classifier (cost-class.ts).
 * Covers each class and both numeric boundaries (acceptance 1 vs 2, scope 9 vs
 * 10) plus the sensitive-surface rule. Classification ONLY — nothing here
 * touches dispatch.
 */
import { describe, expect, it } from "vitest";
import { costClassOf, HEAVY_MIN_ACCEPTANCE, HEAVY_MIN_SCOPE_PATTERNS, TRIVIAL_MAX_ACCEPTANCE, TRIVIAL_MAX_SCOPE_PATTERNS } from "./cost-class.js";

const acc = (n: number) => Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);
const scope = (n: number) => ({ files: Array.from({ length: n }, (_, i) => `src/dir-${i}.ts`) });

describe("#259 costClassOf: each class", () => {
  it("trivial: no acceptance, no scope", () => {
    expect(costClassOf({ goal: "rename a variable" })).toBe("trivial");
  });

  it("trivial: absent acceptance and absent scope objects", () => {
    expect(costClassOf({ goal: "tweak a comment", acceptance: [], scope: { files: [] } })).toBe("trivial");
  });

  it("standard: mid-size measures without any heavy signal", () => {
    expect(costClassOf({ goal: "refactor the parser", acceptance: acc(3), scope: scope(5) })).toBe("standard");
  });

  it("heavy: 6 acceptance items", () => {
    expect(costClassOf({ goal: "do a big refactor", acceptance: acc(HEAVY_MIN_ACCEPTANCE) })).toBe("heavy");
  });

  it("heavy: 10 scope patterns", () => {
    expect(costClassOf({ goal: "do a wide cleanup", scope: scope(HEAVY_MIN_SCOPE_PATTERNS) })).toBe("heavy");
  });

  it("heavy: goal names a sensitive surface", () => {
    expect(costClassOf({ goal: "tweak the guard comment" })).toBe("heavy");
    expect(costClassOf({ goal: "bump deny-baseline version" })).toBe("heavy");
    expect(costClassOf({ goal: "rotate ssh key doc" })).toBe("heavy");
    expect(costClassOf({ goal: "re-provision the runner" })).toBe("heavy");
    expect(costClassOf({ goal: "note secret rotation policy" })).toBe("heavy");
    expect(costClassOf({ goal: "extend auth middleware test" })).toBe("heavy");
    expect(costClassOf({ goal: "document credential env var" })).toBe("heavy");
  });
});

describe("#259 costClassOf: boundaries", () => {
  it("acceptance 1 is trivial, 2 is standard (below heavy)", () => {
    const goal = "tidy helper docs";
    expect(costClassOf({ goal, acceptance: acc(TRIVIAL_MAX_ACCEPTANCE) })).toBe("trivial");
    expect(costClassOf({ goal, acceptance: acc(TRIVIAL_MAX_ACCEPTANCE + 1) })).toBe("standard");
  });

  it("scope 1 is trivial, 2 is standard (below heavy)", () => {
    const goal = "tidy helper docs";
    expect(costClassOf({ goal, scope: scope(TRIVIAL_MAX_SCOPE_PATTERNS) })).toBe("trivial");
    expect(costClassOf({ goal, scope: scope(TRIVIAL_MAX_SCOPE_PATTERNS + 1) })).toBe("standard");
  });

  it("scope 9 is standard, 10 is heavy", () => {
    const goal = "sweep the tree";
    expect(costClassOf({ goal, scope: scope(HEAVY_MIN_SCOPE_PATTERNS - 1) })).toBe("standard");
    expect(costClassOf({ goal, scope: scope(HEAVY_MIN_SCOPE_PATTERNS) })).toBe("heavy");
  });

  it("sensitive surface wins even at trivial sizes; heavy size wins regardless", () => {
    expect(costClassOf({ goal: "doc the ssh flag", acceptance: [], scope: { files: [] } })).toBe("heavy");
    expect(costClassOf({ goal: "clean work", acceptance: acc(HEAVY_MIN_ACCEPTANCE), scope: scope(HEAVY_MIN_SCOPE_PATTERNS) })).toBe("heavy");
  });
});