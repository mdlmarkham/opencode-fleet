/**
 * Reviewer calibration (issue #127): you cannot tell a good reviewer from one that always answers
 * "fine" without measuring. Pure and deterministic: a versioned corpus of planted defects and clean
 * diffs, per-reviewer metrics (engine x model x role version), a dated report, rotation, canaries, and
 * the gate an L3 (unattended) mission needs. Running the reviewers against the corpus is the live part;
 * this module scores what comes back.
 *
 * Honesty rules: a metric over fewer than `minCases` cases is withheld (null), a reviewer without a
 * recent report for its CURRENT model version is uncalibrated, and "no evidence" never counts as a find.
 */

export const CORPUS_VERSION = 1;
export const DEFAULT_MIN_CASES = 5;

export interface CorpusCase {
  id: string;
  kind: "planted" | "clean";
  /** Where the case came from (a past PR/issue), so each is checkable. */
  source: string;
  baseCommit: string;
  /** The diff the reviewer is shown (unified diff text). */
  diff: string;
  /** planted only: where the defect is. A finding matches if it cites this file (and a line within `lineSlack`, when both given). */
  expected?: { file: string; line?: number; lineSlack?: number; summary: string };
  /** clean only: why a reviewer might wrongly object (scary-looking but correct). */
  scary?: string;
}
export interface Corpus { version: number; name: string; date: string; cases: CorpusCase[] }

export type LoadResult = { ok: true; corpus: Corpus } | { ok: false; error: string };
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}$/;

/** Strict loader: a case that cannot be checked (no expected location, bad sha) is rejected. */
export function loadCorpus(text: string): LoadResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "corpus is not valid JSON" }; }
  if (!isRec(raw) || raw.version !== CORPUS_VERSION) return { ok: false, error: `corpus version must be ${CORPUS_VERSION}` };
  if (typeof raw.name !== "string" || typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return { ok: false, error: "corpus needs a name and an ISO date" };
  if (!Array.isArray(raw.cases) || raw.cases.length === 0 || raw.cases.length > 500) return { ok: false, error: "cases must be an array of 1-500" };
  const seen = new Set<string>();
  const cases: CorpusCase[] = [];
  for (const [i, c] of raw.cases.entries()) {
    if (!isRec(c) || typeof c.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(c.id)) return { ok: false, error: `cases[${i}]: bad id` };
    if (seen.has(c.id)) return { ok: false, error: `duplicate case id ${c.id}` };
    seen.add(c.id);
    if (c.kind !== "planted" && c.kind !== "clean") return { ok: false, error: `${c.id}: kind must be planted|clean` };
    if (typeof c.source !== "string" || !c.source.trim()) return { ok: false, error: `${c.id}: source is required` };
    if (typeof c.baseCommit !== "string" || !SHA.test(c.baseCommit)) return { ok: false, error: `${c.id}: baseCommit must be a 40-hex sha` };
    if (typeof c.diff !== "string" || !c.diff.trim()) return { ok: false, error: `${c.id}: diff is required` };
    if (c.kind === "planted") {
      const e = c.expected;
      if (!isRec(e) || typeof e.file !== "string" || typeof e.summary !== "string") return { ok: false, error: `${c.id}: a planted case needs expected {file, summary}` };
      cases.push({ id: c.id, kind: "planted", source: c.source, baseCommit: c.baseCommit, diff: c.diff, expected: { file: e.file, summary: e.summary, ...(typeof e.line === "number" ? { line: e.line } : {}), ...(typeof e.lineSlack === "number" ? { lineSlack: e.lineSlack } : {}) } });
    } else {
      if (c.expected !== undefined) return { ok: false, error: `${c.id}: a clean case has no expected finding` };
      cases.push({ id: c.id, kind: "clean", source: c.source, baseCommit: c.baseCommit, diff: c.diff, ...(typeof c.scary === "string" ? { scary: c.scary } : {}) });
    }
  }
  return { ok: true, corpus: { version: CORPUS_VERSION, name: raw.name, date: raw.date, cases } };
}

export interface ReviewerId { engine: string; model: string; roleVersion: string; family: string }
export const reviewerKey = (r: ReviewerId): string => `${r.engine}/${r.model}@${r.roleVersion}`;

export interface CaseResult {
  caseId: string;
  reviewer: ReviewerId;
  /** Findings the reviewer reported that carried evidence (a reproduction or a cite). Unevidenced claims are not passed in. */
  findings: Array<{ file: string; line?: number; reproduced: boolean }>;
  latencyMs?: number;
  costUsd?: number;
  /** The reviewer failed (timeout, malformed, unavailable) on this case. */
  failed?: boolean;
}

export interface ReviewerMetrics {
  reviewer: ReviewerId;
  planted: number;
  clean: number;
  failures: number;
  /** Share of planted defects found; null below minCases. */
  recall: number | null;
  /** Share of clean diffs with any finding; null below minCases. */
  falsePositiveRate: number | null;
  /** Of the matching finds, how many came with a reproduction. */
  reproductionRate: number | null;
  meanLatencyMs: number | null;
  meanCostUsd: number | null;
  missed: string[];
  falseAlarms: string[];
}

const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const rate = (k: number, n: number, min: number): number | null => (n >= min ? Math.round((k / n) * 1000) / 1000 : null);

const matches = (c: CorpusCase, f: { file: string; line?: number }): boolean => {
  const e = c.expected;
  if (!e || f.file !== e.file) return false;
  return e.line === undefined || f.line === undefined || Math.abs(f.line - e.line) <= (e.lineSlack ?? 3);
};

/** Score every reviewer in `results` against the corpus. A failed case is neither a find nor a clean pass. */
export function scoreReviewers(corpus: Corpus, results: CaseResult[], minCases = DEFAULT_MIN_CASES): ReviewerMetrics[] {
  const byCase = new Map(corpus.cases.map((c) => [c.id, c]));
  const reviewers = new Map<string, ReviewerId>();
  for (const r of results) reviewers.set(reviewerKey(r.reviewer), r.reviewer);
  return [...reviewers].sort(([a], [b]) => a.localeCompare(b)).map(([key, reviewer]) => {
    const mine = results.filter((r) => reviewerKey(r.reviewer) === key && byCase.has(r.caseId));
    const ok = mine.filter((r) => !r.failed);
    const planted = ok.filter((r) => byCase.get(r.caseId)!.kind === "planted");
    const clean = ok.filter((r) => byCase.get(r.caseId)!.kind === "clean");
    const found = planted.filter((r) => r.findings.some((f) => matches(byCase.get(r.caseId)!, f)));
    const reproduced = found.filter((r) => r.findings.some((f) => matches(byCase.get(r.caseId)!, f) && f.reproduced));
    const alarms = clean.filter((r) => r.findings.length > 0);
    const costs = ok.flatMap((r) => (typeof r.costUsd === "number" ? [r.costUsd] : []));
    return {
      reviewer, planted: planted.length, clean: clean.length, failures: mine.length - ok.length,
      recall: rate(found.length, planted.length, minCases),
      falsePositiveRate: rate(alarms.length, clean.length, minCases),
      reproductionRate: rate(reproduced.length, found.length, minCases),
      meanLatencyMs: mean(ok.flatMap((r) => (typeof r.latencyMs === "number" ? [r.latencyMs] : []))),
      meanCostUsd: costs.length ? Math.round((costs.reduce((x, y) => x + y, 0) / costs.length) * 1000) / 1000 : null,
      missed: planted.filter((r) => !found.includes(r)).map((r) => r.caseId),
      falseAlarms: alarms.map((r) => r.caseId),
    };
  });
}

export interface Report { corpus: string; corpusVersion: number; date: string; minCases: number; reviewers: ReviewerMetrics[]; ranking: string[]; note: string }

/** The dated report: reviewers ranked by recall, then false-positive rate, uncalibrated (null) last. */
export function buildReport(corpus: Corpus, results: CaseResult[], date: string, minCases = DEFAULT_MIN_CASES): Report {
  const reviewers = scoreReviewers(corpus, results, minCases);
  const score = (m: ReviewerMetrics): number => (m.recall === null || m.falsePositiveRate === null ? -1 : m.recall - m.falsePositiveRate);
  const ranking = [...reviewers].sort((a, b) => score(b) - score(a) || reviewerKey(a.reviewer).localeCompare(reviewerKey(b.reviewer))).map((m) => reviewerKey(m.reviewer));
  return { corpus: corpus.name, corpusVersion: corpus.version, date, minCases, reviewers, ranking, note: `A metric needs at least ${minCases} cases of its kind; below that it is null and the reviewer counts as uncalibrated.` };
}

export interface Bar { minRecall: number; maxFalsePositiveRate: number; /** The report must be at most this many days old. */ maxAgeDays: number; minReviewers: number; minFamilies: number }
export const DEFAULT_BAR: Bar = { minRecall: 0.8, maxFalsePositiveRate: 0.2, maxAgeDays: 30, minReviewers: 2, minFamilies: 2 };

/**
 * Does the configured reviewer set meet the bar for L3? Every configured reviewer must be calibrated on
 * the CURRENT model version in a recent report; the passing set must be big and diverse enough.
 */
export function meetsBar(report: Report, configured: ReviewerId[], now: Date, bar: Bar = DEFAULT_BAR): { ok: boolean; passing: string[]; reasons: string[] } {
  const reasons: string[] = [];
  const ageDays = (now.getTime() - Date.parse(report.date)) / 86_400_000;
  if (!(ageDays >= 0 && ageDays <= bar.maxAgeDays)) reasons.push(`the calibration report is ${Number.isFinite(ageDays) ? Math.round(ageDays) + " days old" : "undated"} (limit ${bar.maxAgeDays})`);
  const passing: ReviewerId[] = [];
  for (const r of configured) {
    const m = report.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(r));
    if (!m) { reasons.push(`${reviewerKey(r)} is not in the report: uncalibrated for its current model/role version`); continue; }
    if (m.recall === null || m.falsePositiveRate === null) reasons.push(`${reviewerKey(r)}: too few cases to measure`);
    else if (m.recall < bar.minRecall) reasons.push(`${reviewerKey(r)}: recall ${m.recall} < ${bar.minRecall}`);
    else if (m.falsePositiveRate > bar.maxFalsePositiveRate) reasons.push(`${reviewerKey(r)}: false-positive rate ${m.falsePositiveRate} > ${bar.maxFalsePositiveRate}`);
    else passing.push(r);
  }
  if (passing.length < bar.minReviewers) reasons.push(`${passing.length} calibrated reviewer(s) meet the bar; ${bar.minReviewers} required`);
  if (new Set(passing.map((p) => p.family.toLowerCase())).size < bar.minFamilies) reasons.push(`passing reviewers span fewer than ${bar.minFamilies} model families`);
  return { ok: reasons.length === 0, passing: passing.map(reviewerKey), reasons };
}

/** Pick `count` reviewers from those that meet the bar: best score first, distinct families first, rotating the starting point by `round`. */
export function chooseReviewers(report: Report, candidates: ReviewerId[], count: number, round = 0, bar: Bar = DEFAULT_BAR): ReviewerId[] {
  const ok = candidates.filter((c) => { const m = report.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(c)); return !!m && m.recall !== null && m.falsePositiveRate !== null && m.recall >= bar.minRecall && m.falsePositiveRate <= bar.maxFalsePositiveRate; });
  const ordered = [...ok].sort((a, b) => report.ranking.indexOf(reviewerKey(a)) - report.ranking.indexOf(reviewerKey(b)));
  const start = ordered.length ? ((round % ordered.length) + ordered.length) % ordered.length : 0;
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  const picked: ReviewerId[] = [];
  for (const r of rotated) if (picked.length < count && !picked.some((p) => p.family.toLowerCase() === r.family.toLowerCase())) picked.push(r);
  for (const r of rotated) if (picked.length < count && !picked.includes(r)) picked.push(r);
  return picked;
}

/** A reviewer whose recall dropped (or whose model/role version changed) since the last report must be re-run. */
export function needsRecalibration(prev: Report | undefined, now: Report, reviewer: ReviewerId, drop = 0.1): string | undefined {
  const cur = now.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(reviewer));
  if (!cur) return "not measured in the current report";
  if (!prev) return undefined;
  const old = prev.reviewers.find((x) => reviewerKey(x.reviewer) === reviewerKey(reviewer));
  if (!old) return "model or role version changed since the previous report: re-run";
  if (old.recall !== null && cur.recall !== null && old.recall - cur.recall > drop) return `recall dropped ${old.recall} -> ${cur.recall}`;
  return undefined;
}

// ---- live canaries --------------------------------------------------------------------------------------

/** Deterministic selection of which real reviews carry an injected canary (clearly marked, never merged). */
export function pickCanaries(reviewIds: string[], share: number, seed: string): string[] {
  if (!(share > 0)) return [];
  const h = (s: string): number => { let x = 2166136261; for (const ch of `${seed}:${s}`) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  return reviewIds.filter((id) => h(id) < Math.min(1, share));
}

export interface CanaryOutcome { reviewId: string; reviewer: ReviewerId; caught: boolean }
/** Canaries the reviewers missed are surfaced, per reviewer. */
export function canaryReport(outcomes: CanaryOutcome[]): { total: number; caught: number; missed: Array<{ reviewId: string; reviewer: string }> } {
  return { total: outcomes.length, caught: outcomes.filter((o) => o.caught).length, missed: outcomes.filter((o) => !o.caught).map((o) => ({ reviewId: o.reviewId, reviewer: reviewerKey(o.reviewer) })) };
}

/** Corpus growth loop: a defect a human found after an unattended review becomes a new planted case. */
export function caseFromEscapedDefect(d: { id: string; source: string; baseCommit: string; diff: string; file: string; line?: number; summary: string }): { ok: true; case: CorpusCase } | { ok: false; error: string } {
  const r = loadCorpus(JSON.stringify({ version: CORPUS_VERSION, name: "x", date: "2000-01-01", cases: [{ id: d.id, kind: "planted", source: d.source, baseCommit: d.baseCommit, diff: d.diff, expected: { file: d.file, summary: d.summary, ...(d.line !== undefined ? { line: d.line } : {}) } }] }));
  return r.ok ? { ok: true, case: r.corpus.cases[0]! } : r;
}
