import { describe, expect, it } from "vitest";
import { CHECKPOINT_DEFS, depthFor, parseFindings, resolveCheckpoint, reviewCacheKey, stageMayAdvance, verifyIndependence, type Finding, type Party, type ReviewOutcome, type ReviewSession } from "./checkpoints.js";

const C = "a".repeat(40);
const author: Party = { kind: "agent", family: "claude", sessionId: "s-author", cloneDir: "/w/author", node: "n1" };
const sess = (id: string, o: Partial<ReviewSession> = {}): ReviewSession => ({ reviewerId: id, kind: "agent", family: "gpt", sessionId: `s-${id}`, cloneDir: `/w/${id}`, node: "n2", commit: C, sawAuthorContext: false, pass: "blind", ...o });
const repro: Finding = { severity: "blocking", summary: "off by one in parse", reproduction: { testPath: "t/x.test.ts", failsAtCommit: C, output: "expected 3 got 2" } };
const reviewed = (id: string, findings: Finding[] = [], o: Partial<ReviewSession> = {}): ReviewOutcome => ({ status: "reviewed", session: sess(id, o), findings });
const resolve = (outcomes: ReviewOutcome[], extra: Record<string, unknown> = {}) => resolveCheckpoint({ checkpoint: "C2", commit: C, depth: "one", author, outcomes, ...extra } as never);

describe("#126: depth tiers", () => {
  it("sensitive > rule surface/large > trivial skip > one", () => {
    expect(depthFor({ filesChanged: 1, linesChanged: 5, touchesRuleSurface: false, touchesSensitive: true })).toBe("two-blind+human");
    expect(depthFor({ filesChanged: 2, linesChanged: 5, touchesRuleSurface: true, touchesSensitive: false })).toBe("two-blind");
    expect(depthFor({ filesChanged: 11, linesChanged: 5, touchesRuleSurface: false, touchesSensitive: false })).toBe("two-blind");
    expect(depthFor({ filesChanged: 1, linesChanged: 5, touchesRuleSurface: false, touchesSensitive: false, trivial: true })).toBe("none");
    expect(depthFor({ filesChanged: 3, linesChanged: 50, touchesRuleSurface: false, touchesSensitive: false })).toBe("one");
  });
  it("an advisory audit and a trivial tier never block", () => {
    expect(CHECKPOINT_DEFS.audit.mode).toBe("advisory");
    expect(resolveCheckpoint({ checkpoint: "C2", commit: C, depth: "none", author, outcomes: [] })).toMatchObject({ state: "satisfied", canAdvance: true });
  });
});

describe("#126: independence is enforced", () => {
  const rules = (s: ReviewSession, others: ReviewSession[] = []) => verifyIndependence(author, s, C, undefined, others).map((v) => v.rule);
  it("rejects same family, shared session, shared clone, context leak, wrong commit, no clone, unknown family", () => {
    expect(rules(sess("r", { family: "Claude" }))).toEqual(["same-family"]);
    expect(rules(sess("r", { sessionId: "s-author" }))).toEqual(["shared-session"]);
    expect(rules(sess("r", { cloneDir: "/w/author" }))).toEqual(["shared-clone"]);
    expect(rules(sess("r", { sawAuthorContext: true }))).toEqual(["context-leak"]);
    expect(rules(sess("r", { commit: "b".repeat(40) }))).toEqual(["wrong-commit"]);
    expect(rules(sess("r", { cloneDir: undefined }))).toEqual(["no-clean-clone"]);
    expect(rules(sess("r", { family: undefined }))).toEqual(["unknown-family"]);
  });
  it("a rationale pass may see the author's context; a clean different-family review has no violations", () => {
    expect(rules(sess("r", { pass: "rationale", sawAuthorContext: true }))).toEqual([]);
    expect(rules(sess("r"))).toEqual([]);
  });
  it("two reviewers must not share a session or clone with each other", () => {
    expect(rules(sess("a", { cloneDir: "/w/shared" }), [sess("b", { cloneDir: "/w/shared" })])).toEqual(["shared-clone"]);
  });
  it("a human reviewer is a reviewer type on the same path (no clone or family needed)", () => {
    expect(rules({ ...sess("h"), kind: "human", family: undefined, cloneDir: undefined })).toEqual([]);
  });
  it("a review that violates the policy does not count: the checkpoint stays unsatisfied", () => {
    const r = resolve([reviewed("r1", [], { family: "claude" })]);
    expect(r).toMatchObject({ state: "unsatisfied", canAdvance: false, rejected: [{ rule: "same-family" }] });
    expect(r.reasons.join()).toMatch(/rejected for independence/);
  });
});

describe("#126: evidence rule", () => {
  it("accepts a reproduction or a cite; rejects a bare claim, bad shapes and unknown keys whole", () => {
    expect(parseFindings([repro, { severity: "minor", summary: "naming", cite: { file: "a.ts", line: 3 } }]).ok).toBe(true);
    for (const bad of [[{ severity: "blocking", summary: "it is wrong" }], [{ ...repro, reproduction: { ...repro.reproduction, failsAtCommit: "abc" } }], [{ ...repro, extra: 1 }], [{ severity: "x", summary: "s", cite: { file: "a", line: 1 } }], [{ severity: "major", summary: "s", cite: { file: "a", line: 0 } }], "nope"]) {
      expect(parseFindings(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("#126: verdict handling", () => {
  it("a planted defect with a reproducing test blocks the stage", () => {
    const r = resolve([reviewed("r1", [repro])]);
    expect(r).toMatchObject({ state: "blocked", canAdvance: false });
    expect(stageMayAdvance(r)).toBe(false);
  });
  it("a bare cite or a reproduction at another commit is advisory, not blocking", () => {
    const r = resolve([reviewed("r1", [{ severity: "major", summary: "smells", cite: { file: "a.ts", line: 9 } }, { ...repro, reproduction: { ...repro.reproduction!, failsAtCommit: "c".repeat(40) } }])]);
    expect(r).toMatchObject({ state: "satisfied", canAdvance: true });
    expect(r.advisory).toHaveLength(2);
  });
  it("a clean independent review satisfies; no review at all does not", () => {
    expect(stageMayAdvance(resolve([reviewed("r1")]))).toBe(true);
    expect(stageMayAdvance(resolve([]))).toBe(false);
    expect(stageMayAdvance(undefined)).toBe(false);
  });
  it("fails closed when a reviewer times out, is unavailable or sends malformed output, even if another passed", () => {
    for (const reason of ["timeout", "unavailable", "malformed"] as const) {
      const r = resolve([reviewed("r1"), { status: "failed", reviewerId: "r2", reason }]);
      expect(r).toMatchObject({ state: "escalate", canAdvance: false });
      expect(r.reasons.join()).toContain(reason);
    }
  });
  it("two-blind needs two independent reviews; disagreement escalates; human tier needs a human pass", () => {
    expect(resolve([reviewed("r1")], { depth: "two-blind" })).toMatchObject({ state: "unsatisfied" });
    expect(resolve([reviewed("r1"), reviewed("r2")], { depth: "two-blind" })).toMatchObject({ state: "satisfied" });
    expect(resolve([reviewed("r1", [repro]), reviewed("r2")], { depth: "two-blind" })).toMatchObject({ state: "escalate" });
    expect(resolve([reviewed("r1", [repro]), reviewed("r2", [repro])], { depth: "two-blind" })).toMatchObject({ state: "blocked" });
    expect(resolve([reviewed("r1"), reviewed("r2")], { depth: "two-blind+human" })).toMatchObject({ state: "unsatisfied" });
    expect(resolve([reviewed("r1"), reviewed("r2")], { depth: "two-blind+human", humanVerdict: "pass" })).toMatchObject({ state: "satisfied" });
    expect(resolve([reviewed("r1"), reviewed("r2")], { depth: "two-blind+human", humanVerdict: "fail" })).toMatchObject({ state: "blocked" });
  });
  it("a contest needs evidence; with it the author's claim goes to a third decider, and a dismissal unblocks", () => {
    const noEvidence = resolve([reviewed("r1", [repro])], { contests: [{ reviewerId: "r1", findingSummary: repro.summary, evidence: " " }] });
    expect(noEvidence.state).toBe("blocked");
    const contest = { reviewerId: "r1", findingSummary: repro.summary, evidence: "the test asserts the wrong constant" };
    expect(resolve([reviewed("r1", [repro])], { contests: [contest] })).toMatchObject({ state: "needs-third-reviewer", canAdvance: false });
    expect(resolve([reviewed("r1", [repro])], { contests: [{ ...contest, decidedBy: { kind: "human", verdict: "dismissed" } }] })).toMatchObject({ state: "satisfied" });
    expect(resolve([reviewed("r1", [repro])], { contests: [{ ...contest, decidedBy: { kind: "human", verdict: "upheld" } }] })).toMatchObject({ state: "blocked" });
  });
  it("review cache key depends on commit, role version and depth", () => {
    const k = reviewCacheKey(C, "reviewer@1", "one");
    expect(k).toBe(reviewCacheKey(C, "reviewer@1", "one"));
    expect(new Set([k, reviewCacheKey("b".repeat(40), "reviewer@1", "one"), reviewCacheKey(C, "reviewer@2", "one"), reviewCacheKey(C, "reviewer@1", "two-blind")]).size).toBe(4);
  });
});
