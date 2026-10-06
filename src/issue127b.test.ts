import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildReport, loadCorpus, meetsBar, type CaseResult, type ReviewerId } from "./reviewer-calibration.js";

const text = readFileSync(new URL("../calibration/reviewer-corpus.json", import.meta.url), "utf8");
const loaded = loadCorpus(text);

describe("#127: the seeded reviewer corpus", () => {
  it("loads under the strict loader with enough of each kind to score", () => {
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const planted = loaded.corpus.cases.filter((c) => c.kind === "planted");
    const clean = loaded.corpus.cases.filter((c) => c.kind === "clean");
    expect(planted.length).toBeGreaterThanOrEqual(5);
    expect(clean.length).toBeGreaterThanOrEqual(5);
  });
  it("every planted case's expected file is part of the diff the reviewer is shown", () => {
    if (!loaded.ok) throw new Error("corpus did not load");
    for (const c of loaded.corpus.cases.filter((x) => x.kind === "planted")) {
      expect(c.diff, c.id).toContain(c.expected!.file);
      expect(c.source, c.id).toMatch(/introduced by [0-9a-f]{12}.*repaired by [0-9a-f]{12}/);
    }
  });
  it("no diff carries a test file or a secret-looking token (what a reviewer sees is source only)", () => {
    if (!loaded.ok) throw new Error("corpus did not load");
    for (const c of loaded.corpus.cases) {
      expect(c.diff, c.id).not.toMatch(/^diff --git a\/src\/.*\.test\.ts/m);
      expect(c.diff, c.id).not.toMatch(/sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/);
    }
  });
  it("a perfect reviewer scores recall 1 / FPR 0 and clears the bar; an always-fine reviewer does not", () => {
    if (!loaded.ok) throw new Error("corpus did not load");
    const rv = (model: string, family: string): ReviewerId => ({ engine: "opencode", model, roleVersion: "r1", family });
    const perfect = rv("a", "fa"), perfect2 = rv("b", "fb"), lazy = rv("c", "fc");
    const results: CaseResult[] = [];
    for (const c of loaded.corpus.cases) {
      for (const r of [perfect, perfect2]) results.push({ caseId: c.id, reviewer: r, findings: c.kind === "planted" ? [{ file: c.expected!.file, line: c.expected!.line, reproduced: true }] : [] });
      results.push({ caseId: c.id, reviewer: lazy, findings: [] });
    }
    const report = buildReport(loaded.corpus, results, "2026-10-06");
    const m = (r: ReviewerId) => report.reviewers.find((x) => x.reviewer.model === r.model)!;
    expect(m(perfect)).toMatchObject({ recall: 1, falsePositiveRate: 0 });
    expect(m(lazy).recall).toBe(0);
    expect(meetsBar(report, [perfect, perfect2], new Date("2026-10-07")).ok).toBe(true);
    expect(meetsBar(report, [perfect, lazy], new Date("2026-10-07")).ok).toBe(false);
  });
});
