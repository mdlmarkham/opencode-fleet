import { describe, expect, it } from "vitest";
import { DEFAULT_BAR, buildReport, canaryReport, caseFromEscapedDefect, chooseReviewers, loadCorpus, meetsBar, needsRecalibration, pickCanaries, reviewerKey, type CaseResult, type ReviewerId } from "./reviewer-calibration.js";

const SHA = "a".repeat(40);
const planted = (id: string, file = `src/${id}.ts`) => ({ id, kind: "planted", source: `PR ${id}`, baseCommit: SHA, diff: "--- a\n+++ b\n+x", expected: { file, line: 10, summary: `defect ${id}` } });
const clean = (id: string) => ({ id, kind: "clean", source: `PR ${id}`, baseCommit: SHA, diff: "--- a\n+++ b\n+y", scary: "looks like a leak but is a test fixture" });
const corpusText = JSON.stringify({ version: 1, name: "seed", date: "2026-10-06", cases: [...Array.from({ length: 5 }, (_, i) => planted(`p${i}`)), ...Array.from({ length: 5 }, (_, i) => clean(`c${i}`))] });
const load = () => { const r = loadCorpus(corpusText); if (!r.ok) throw new Error(r.error); return r.corpus; };
const R = (model: string, family: string, roleVersion = "r1"): ReviewerId => ({ engine: "opencode", model, roleVersion, family });
const good = R("good", "gpt"), lazy = R("lazy", "claude"), noisy = R("noisy", "kimi");

/** good: finds all 5 (4 reproduced), no false alarms. lazy: always "fine". noisy: finds all, flags 3 of 5 clean diffs. */
const results = (): CaseResult[] => {
  const out: CaseResult[] = [];
  for (let i = 0; i < 5; i++) {
    out.push({ caseId: `p${i}`, reviewer: good, findings: [{ file: `src/p${i}.ts`, line: 11, reproduced: i < 4 }], latencyMs: 1000, costUsd: 0.1 });
    out.push({ caseId: `c${i}`, reviewer: good, findings: [], latencyMs: 800, costUsd: 0.05 });
    out.push({ caseId: `p${i}`, reviewer: lazy, findings: [] });
    out.push({ caseId: `c${i}`, reviewer: lazy, findings: [] });
    out.push({ caseId: `p${i}`, reviewer: noisy, findings: [{ file: `src/p${i}.ts`, reproduced: true }] });
    out.push({ caseId: `c${i}`, reviewer: noisy, findings: i < 3 ? [{ file: "src/x.ts", reproduced: false }] : [] });
  }
  return out;
};

describe("#127: corpus loading", () => {
  it("loads a labelled, dated, versioned corpus", () => { expect(load().cases).toHaveLength(10); });
  it("rejects what cannot be checked: bad sha, planted without expected, clean with expected, duplicates, wrong version", () => {
    const base = JSON.parse(corpusText);
    const mut = (f: (c: any) => void) => { const c = JSON.parse(corpusText); f(c); return JSON.stringify(c); };
    for (const bad of [mut((c) => { c.cases[0].baseCommit = "abc"; }), mut((c) => { delete c.cases[0].expected; }), mut((c) => { c.cases[5].expected = { file: "x", summary: "y" }; }), mut((c) => { c.cases[1].id = c.cases[0].id; }), mut((c) => { c.version = 2; }), mut((c) => { c.date = "yesterday"; }), "{", JSON.stringify({ ...base, cases: [] })]) {
      expect(loadCorpus(bad).ok).toBe(false);
    }
  });
});

describe("#127: the dated report ranks reviewers", () => {
  const rep = buildReport(load(), results(), "2026-10-06");
  const m = (r: ReviewerId) => rep.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(r))!;
  it("computes recall, false-positive rate, reproduction rate, latency and cost per reviewer", () => {
    expect(m(good)).toMatchObject({ recall: 1, falsePositiveRate: 0, reproductionRate: 0.8, meanLatencyMs: 900, meanCostUsd: 0.075, missed: [], falseAlarms: [] });
    expect(m(lazy)).toMatchObject({ recall: 0, falsePositiveRate: 0, missed: ["p0", "p1", "p2", "p3", "p4"] });
    expect(m(noisy)).toMatchObject({ recall: 1, falsePositiveRate: 0.6, falseAlarms: ["c0", "c1", "c2"] });
  });
  it("ranks good > noisy > lazy; a reviewer that always says fine is exposed", () => {
    expect(rep.ranking).toEqual([reviewerKey(good), reviewerKey(noisy), reviewerKey(lazy)]);
  });
  it("withholds rates below the minimum sample and counts failures separately", () => {
    const few = buildReport(load(), results().filter((r) => r.caseId === "p0" || r.caseId === "c0"), "2026-10-06");
    expect(few.reviewers.every((x) => x.recall === null && x.falsePositiveRate === null)).toBe(true);
    const failing = buildReport(load(), [...results(), { caseId: "p0", reviewer: good, findings: [], failed: true }], "2026-10-06");
    expect(failing.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(good))).toMatchObject({ failures: 1, recall: 1 });
  });
  it("a finding on the wrong file or far from the line does not count as a find", () => {
    const r = buildReport(load(), results().map((x) => (x.reviewer === good && x.caseId === "p0" ? { ...x, findings: [{ file: "src/other.ts", reproduced: true }] } : x.reviewer === good && x.caseId === "p1" ? { ...x, findings: [{ file: "src/p1.ts", line: 99, reproduced: true }] } : x)), "2026-10-06");
    expect(r.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(good))!.missed).toEqual(["p0", "p1"]);
  });
});

describe("#127: gate for autonomy, rotation, recalibration", () => {
  const rep = buildReport(load(), results(), "2026-10-06");
  const now = new Date("2026-10-10");
  it("L3 is refused when no reviewer set meets the bar, with reasons; accepted with a calibrated, diverse set", () => {
    const bad = meetsBar(rep, [lazy, noisy], now);
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join("|")).toMatch(/lazy.*recall 0 < 0.8/);
    expect(bad.reasons.join("|")).toMatch(/noisy.*false-positive rate 0.6/);
    const solo = meetsBar(rep, [good], now);
    expect(solo.ok).toBe(false);
    expect(solo.reasons.join("|")).toMatch(/1 calibrated reviewer/);
    const oneFamily = meetsBar(rep, [good, { ...good, model: "good" }], now, { ...DEFAULT_BAR, minReviewers: 1 });
    expect(oneFamily.ok).toBe(false);
    const rep2 = buildReport(load(), [...results(), ...results().filter((r) => r.reviewer === good).map((r) => ({ ...r, reviewer: R("good2", "claude") }))], "2026-10-06");
    expect(meetsBar(rep2, [good, R("good2", "claude")], now)).toMatchObject({ ok: true, passing: expect.any(Array) });
  });
  it("a stale report, or a reviewer on an unmeasured model/role version, fails the bar", () => {
    expect(meetsBar(rep, [good], new Date("2026-12-31")).reasons.join()).toMatch(/days old/);
    expect(meetsBar(rep, [R("good", "gpt", "r2")], now).reasons.join()).toMatch(/uncalibrated/);
  });
  it("rotation picks the best distinct families and rotates the start", () => {
    const rep2 = buildReport(load(), [...results(), ...results().filter((r) => r.reviewer === good).map((r) => ({ ...r, reviewer: R("g2", "claude") })), ...results().filter((r) => r.reviewer === good).map((r) => ({ ...r, reviewer: R("g3", "gpt") }))], "2026-10-06");
    const all = [good, R("g2", "claude"), R("g3", "gpt"), lazy];
    expect(chooseReviewers(rep2, all, 2, 0).map((r) => r.family)).toEqual(["claude", "gpt"].sort().length === 2 ? expect.arrayContaining(["gpt", "claude"]) : []);
    expect(chooseReviewers(rep2, all, 3, 0).some((r) => r.model === "lazy")).toBe(false);
    expect(chooseReviewers(rep2, all, 1, 0)[0]).not.toEqual(chooseReviewers(rep2, all, 1, 1)[0]);
  });
  it("flags a recall drop or a version change", () => {
    const worse = buildReport(load(), results().map((r) => (r.reviewer === good && r.caseId === "p0" ? { ...r, findings: [] } : r.reviewer === good && r.caseId === "p1" ? { ...r, findings: [] } : r)), "2026-10-20");
    expect(needsRecalibration(rep, worse, good)).toMatch(/recall dropped 1 -> 0.6/);
    expect(needsRecalibration(rep, rep, good)).toBeUndefined();
    expect(needsRecalibration(rep, rep, R("good", "gpt", "r9"))).toMatch(/not measured/);
  });
});

describe("#127: canaries and corpus growth", () => {
  it("canary selection is deterministic and respects the share; missed canaries are surfaced per reviewer", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `rv${i}`);
    const a = pickCanaries(ids, 0.1, "seed1");
    expect(a).toEqual(pickCanaries(ids, 0.1, "seed1"));
    expect(a.length).toBeGreaterThan(5);
    expect(a.length).toBeLessThan(40);
    expect(pickCanaries(ids, 0, "s")).toEqual([]);
    expect(canaryReport([{ reviewId: "rv1", reviewer: good, caught: true }, { reviewId: "rv2", reviewer: lazy, caught: false }])).toEqual({ total: 2, caught: 1, missed: [{ reviewId: "rv2", reviewer: reviewerKey(lazy) }] });
  });
  it("an escaped defect becomes a validated planted case", () => {
    expect(caseFromEscapedDefect({ id: "esc-1", source: "issue #76", baseCommit: SHA, diff: "--- a\n+++ b\n+x", file: "src/protocol.ts", line: 40, summary: "older node ignores the field" })).toMatchObject({ ok: true, case: { kind: "planted", expected: { file: "src/protocol.ts" } } });
    expect(caseFromEscapedDefect({ id: "esc-2", source: "x", baseCommit: "nope", diff: "d", file: "f", summary: "s" }).ok).toBe(false);
  });
});
