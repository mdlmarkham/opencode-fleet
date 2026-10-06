/**
 * Spec-quality signals against run outcomes (issue #166). A DERIVED VIEW over the run ledger: the only
 * data persisted for it is `design` ({verdict, objectionIds}) and `filesChanged` on the entry. Facts
 * and ids only, never spec text, so a record can be shared or exported. Observation only: nothing here
 * changes dispatch.
 *
 * Small-n honesty: a rate over fewer than `minN` runs is anecdote, so it is withheld (`rate: null`)
 * rather than printed.
 */

import type { LedgerEntry } from "./ledger.js";

export const DEFAULT_MIN_N = 10;

export type Outcome = "no-op" | "failed-verification" | "failed" | "complete";

export interface QualityRecord {
  runId: string;
  startedAt: string;
  verdict: string | null;
  objectionIds: string[];
  hadSpec: boolean;
  hadAcceptance: boolean;
  hadVerify: boolean;
  hadScope: boolean;
  outcome: Outcome;
  verified: boolean | null;
  tokens: number | null;
  wallMs: number | null;
}

const TERMINAL = new Set(["completed", "failed", "failed-verification"]);

/** One terminal ledger entry as spec facts + outcome; undefined for a run that has not finished. */
export function qualityRecord(e: LedgerEntry): QualityRecord | undefined {
  if (!TERMINAL.has(e.state)) return undefined;
  const v = e.spec?.verify;
  const hadVerify = !!v && (!!v.command || (v.commands?.length ?? 0) > 0 || (v.files?.length ?? 0) > 0);
  const failed = e.state === "failed";
  // "no-op" = the run exited 0 and demonstrably changed nothing; an unknown capture (null) is never a no-op.
  const outcome: Outcome = e.state === "failed-verification" ? "failed-verification" : failed ? "failed" : e.filesChanged === 0 ? "no-op" : "complete";
  const start = Date.parse(e.startedAt);
  const end = Date.parse(e.updatedAt);
  return {
    runId: e.runId,
    startedAt: e.startedAt,
    verdict: e.design?.verdict ?? null,
    objectionIds: e.design?.objectionIds ?? [],
    hadSpec: e.spec !== undefined,
    hadAcceptance: (e.spec?.acceptance?.length ?? 0) > 0,
    hadVerify,
    hadScope: (e.spec?.scope?.files.length ?? 0) > 0,
    outcome,
    verified: typeof e.verified === "boolean" ? e.verified : null,
    tokens: typeof e.usage?.tokens === "number" ? e.usage.tokens : null,
    wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
  };
}

export interface Bucket {
  n: number;
  /** Share of runs whose gate failed, or that exited clean having changed nothing; null when n < minN. */
  badRate: number | null;
  noOp: number;
  failedVerification: number;
  failed: number;
  complete: number;
}

const bucket = (rs: QualityRecord[], minN: number): Bucket => {
  const c = { "no-op": 0, "failed-verification": 0, failed: 0, complete: 0 };
  for (const r of rs) c[r.outcome]++;
  const bad = c["no-op"] + c["failed-verification"] + c.failed;
  return { n: rs.length, badRate: rs.length >= minN ? Math.round((bad / rs.length) * 1000) / 1000 : null, noOp: c["no-op"], failedVerification: c["failed-verification"], failed: c.failed, complete: c.complete };
};

export interface QualityReport {
  n: number;
  minN: number;
  note: string;
  overall: Bucket;
  byFact: Record<"hadAcceptance" | "hadVerify" | "hadScope", { with: Bucket; without: Bucket }>;
  byVerdict: Record<string, Bucket>;
  byObjection: Record<string, Bucket>;
}

/** Correlate spec facts with outcomes over spec-bearing terminal runs started at or after `sinceMs`. */
export function qualityReport(entries: LedgerEntry[], opts: { sinceMs?: number; minN?: number } = {}): QualityReport {
  const minN = opts.minN !== undefined && Number.isInteger(opts.minN) && opts.minN >= 1 ? opts.minN : DEFAULT_MIN_N;
  const rs = entries
    .map(qualityRecord)
    .filter((r): r is QualityRecord => r !== undefined && r.hadSpec && (opts.sinceMs === undefined || Date.parse(r.startedAt) >= opts.sinceMs));
  const split = (pick: (r: QualityRecord) => boolean) => ({ with: bucket(rs.filter(pick), minN), without: bucket(rs.filter((r) => !pick(r)), minN) });
  const group = (key: (r: QualityRecord) => string[]): Record<string, Bucket> => {
    const m = new Map<string, QualityRecord[]>();
    for (const r of rs) for (const k of key(r)) m.set(k, [...(m.get(k) ?? []), r]);
    return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, bucket(v, minN)]));
  };
  return {
    n: rs.length,
    minN,
    note: `A rate is shown only for groups of at least ${minN} runs; smaller groups are counts only. Correlation, not causation. Runs dispatched before design was recorded have no verdict.`,
    overall: bucket(rs, minN),
    byFact: { hadAcceptance: split((r) => r.hadAcceptance), hadVerify: split((r) => r.hadVerify), hadScope: split((r) => r.hadScope) },
    byVerdict: group((r) => [r.verdict ?? "unrecorded"]),
    byObjection: group((r) => r.objectionIds),
  };
}
