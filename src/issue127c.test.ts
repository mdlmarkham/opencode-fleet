import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadCorpus, reviewerKey, type ReviewerId } from "./reviewer-calibration.js";
import { calibrateReviewers, renderReviewerReport, runCorpus, type ReviewFn } from "./reviewer-run.js";

const loaded = loadCorpus(readFileSync(new URL("../calibration/reviewer-corpus.json", import.meta.url), "utf8"));
if (!loaded.ok) throw new Error(loaded.error);
const corpus = loaded.corpus;
const rv = (model: string, family: string): ReviewerId => ({ engine: "opencode", model, roleVersion: "r1", family });
const good = rv("good", "fa"), lazy = rv("lazy", "fb"), flaky = rv("flaky", "fc");

const review: ReviewFn = async (c, r) => {
  if (r.model === "flaky") throw new Error("model unavailable");
  if (r.model === "lazy") return { findings: [] };
  return { findings: c.kind === "planted" ? [{ file: c.expected!.file, line: c.expected!.line, reproduced: true }] : [], costUsd: 0.01 };
};

describe("#127: running reviewers over the corpus", () => {
  it("scores each reviewer on every case; a failing reviewer is recorded failed, never as a pass", async () => {
    const { results, report } = await calibrateReviewers(corpus, [good, lazy, flaky], review, "2026-10-06");
    expect(results).toHaveLength(corpus.cases.length * 3);
    expect(results.filter((r) => r.reviewer.model === "flaky").every((r) => r.failed === true)).toBe(true);
    const m = (model: string) => report.reviewers.find((x) => x.reviewer.model === model)!;
    expect(m("good")).toMatchObject({ recall: 1, falsePositiveRate: 0, failures: 0 });
    expect(m("lazy").recall).toBe(0);
    expect(m("flaky")).toMatchObject({ recall: null, falsePositiveRate: null, failures: corpus.cases.length });
    expect(report.ranking[0]).toBe(reviewerKey(good));
    expect(report.ranking[report.ranking.length - 1]).toBe(reviewerKey(flaky));
  });

  it("a hung reviewer times out per case instead of stalling the run", async () => {
    const hang: ReviewFn = () => new Promise(() => { /* never settles */ });
    const small = { ...corpus, cases: corpus.cases.slice(0, 3) };
    const results = await runCorpus(small, [good], hang, { timeoutMs: 20, concurrency: 3 });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.failed === true)).toBe(true);
  });

  it("respects concurrency and keeps result order stable (reviewer, then case)", async () => {
    let live = 0, peak = 0;
    const slow: ReviewFn = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { findings: [] }; };
    const results = await runCorpus(corpus, [good, lazy], slow, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map((r) => `${r.reviewer.model}/${r.caseId}`)).toEqual([good, lazy].flatMap((r) => corpus.cases.map((c) => `${r.model}/${c.id}`)));
  });

  it("renders a dated markdown report with the ranking, misses and clean-case alarms", async () => {
    const noisy: ReviewFn = async (c) => ({ findings: [{ file: c.kind === "planted" ? "wrong.ts" : "x.ts", reproduced: false }] });
    const { report } = await calibrateReviewers(corpus, [good, rv("noisy", "fd")], async (c, r, s) => (r.model === "noisy" ? noisy(c, r, s) : review(c, r, s)), "2026-10-06");
    const md = renderReviewerReport(report);
    expect(md).toContain("# Reviewer calibration — 2026-10-06");
    expect(md).toContain(reviewerKey(good));
    expect(md).toMatch(/\*\*opencode\/noisy@r1\*\* missed:/);
    expect(md).toMatch(/flagged clean cases \(check the label/);
    expect(md).toContain("100%");
  });
});
