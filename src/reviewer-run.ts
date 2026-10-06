/**
 * Run a reviewer set over the calibration corpus and render the dated report (issue #127). The review itself is injected
 * (`ReviewFn`): the live adapter, which shows a reviewer the case's diff at its base commit, is the part that needs a
 * node and a model; everything else (fan-out, failure accounting, timeouts, the report text) is pure and tested here.
 *
 * Failure discipline: a reviewer that throws or times out on a case is recorded `failed`, which `scoreReviewers` counts as
 * neither a find nor a clean pass: a flaky reviewer is never scored as a good one by omission.
 */

import { buildReport, reviewerKey, type Corpus, type CaseResult, type CorpusCase, type Report, type ReviewerId } from "./reviewer-calibration.js";

export interface ReviewOutcome {
  findings: CaseResult["findings"];
  latencyMs?: number;
  costUsd?: number;
}
export type ReviewFn = (c: CorpusCase, reviewer: ReviewerId, signal: AbortSignal) => Promise<ReviewOutcome>;

export interface RunOptions {
  /** Cases in flight at once (1-8, default 2). */
  concurrency?: number;
  /** Per-case wall clock, ms (default 10 minutes). */
  timeoutMs?: number;
  now?: () => number;
}

/** Review every case with every reviewer; never throws for a reviewer failure. Order of results is stable (reviewer, then case). */
export async function runCorpus(corpus: Corpus, reviewers: ReviewerId[], review: ReviewFn, opts: RunOptions = {}): Promise<CaseResult[]> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const width = Math.min(8, Math.max(1, Math.floor(opts.concurrency ?? 2)));
  const jobs = reviewers.flatMap((reviewer) => corpus.cases.map((c) => ({ reviewer, c })));
  const results: CaseResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { reviewer, c } = jobs[i]!;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const t0 = now();
      try {
        const out = await Promise.race([
          review(c, reviewer, ctl.signal),
          new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("timed out")), { once: true })),
        ]);
        results[i] = { caseId: c.id, reviewer, findings: out.findings, latencyMs: out.latencyMs ?? now() - t0, ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}) };
      } catch {
        results[i] = { caseId: c.id, reviewer, findings: [], failed: true, latencyMs: now() - t0 };
      } finally { clearTimeout(timer); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  return results;
}

const pct = (v: number | null): string => (v === null ? "n/a (too few cases)" : `${Math.round(v * 100)}%`);

/** The dated report as markdown, for `calibration/` and the audit trail. */
export function renderReviewerReport(r: Report): string {
  const L = [`# Reviewer calibration — ${r.date}`, "", `Corpus: ${r.corpus} (version ${r.corpusVersion}); a metric needs at least ${r.minCases} cases of its kind.`, "", "| rank | reviewer | planted | clean | recall | false-positive | reproduced | failures |", "|---|---|---|---|---|---|---|---|"];
  for (const key of r.ranking) {
    const m = r.reviewers.find((x) => reviewerKey(x.reviewer) === key)!;
    L.push(`| ${r.ranking.indexOf(key) + 1} | ${key} (${m.reviewer.family}) | ${m.planted} | ${m.clean} | ${pct(m.recall)} | ${pct(m.falsePositiveRate)} | ${pct(m.reproductionRate)} | ${m.failures} |`);
  }
  for (const m of r.reviewers) {
    if (m.missed.length) L.push("", `- **${reviewerKey(m.reviewer)}** missed: ${m.missed.join(", ")}`);
    if (m.falseAlarms.length) L.push(`- **${reviewerKey(m.reviewer)}** flagged clean cases (check the label before counting them): ${m.falseAlarms.join(", ")}`);
  }
  L.push("", r.note);
  return L.join("\n");
}

/** Convenience: run, then build the report. */
export async function calibrateReviewers(corpus: Corpus, reviewers: ReviewerId[], review: ReviewFn, date: string, opts: RunOptions = {}): Promise<{ results: CaseResult[]; report: Report }> {
  const results = await runCorpus(corpus, reviewers, review, opts);
  return { results, report: buildReport(corpus, results, date) };
}
