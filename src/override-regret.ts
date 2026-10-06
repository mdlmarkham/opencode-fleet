/**
 * Override regret (issue #119): every objection the design gate raised is a small experiment. Runs
 * where it fired went fine or went badly; compared with runs where it did not fire, that says whether
 * the nudge is right (fired runs do worse) or noise (they do no worse). A derived view over the ledger:
 * ids and counts only, never prompts or spec text.
 *
 * Advice, not action: proposals are text for a human to turn into a `.fleet/rules.yml` PR, they say
 * "correlated with" (never "caused"), and none is made below `minN` runs on either side. Nothing here
 * changes how any rule behaves.
 */

import type { LedgerEntry } from "./ledger.js";

export const DEFAULT_MIN_N = 10;
/** How much worse (absolute) the fired runs must do than the rest to call a nudge "right". */
export const RIGHT_MARGIN = 0.2;

const TERMINAL = new Set(["completed", "failed", "failed-verification"]);

/** A run went badly: failed, failed its gate, left its declared scope, or exited clean having changed nothing. */
export function wentBadly(e: LedgerEntry): boolean {
  if (e.state === "failed" || e.state === "failed-verification") return true;
  if (Array.isArray(e.scopeViolations) && e.scopeViolations.length > 0) return true;
  return e.state === "completed" && e.filesChanged === 0;
}

export interface Counts { n: number; bad: number; badRate: number | null }
export interface ObjectionRegret {
  objectionId: string;
  fired: Counts;
  notFired: Counts;
  /** Of the fired runs, how many the caller acknowledged past the objection. */
  overridden: number;
  overriddenBad: number;
  verdict: "right" | "noise" | "insufficient";
  proposal?: string;
}

const counts = (rs: LedgerEntry[], minN: number): Counts => {
  const bad = rs.filter(wentBadly).length;
  return { n: rs.length, bad, badRate: rs.length >= minN ? Math.round((bad / rs.length) * 1000) / 1000 : null };
};

export interface RegretReport {
  runs: number;
  minN: number;
  note: string;
  objections: ObjectionRegret[];
}

/** Rank objections by how much worse their fired runs did, strongest evidence first. */
export function regretReport(entries: LedgerEntry[], opts: { minN?: number; sinceMs?: number } = {}): RegretReport {
  const minN = opts.minN !== undefined && Number.isInteger(opts.minN) && opts.minN >= 1 ? opts.minN : DEFAULT_MIN_N;
  const runs = entries.filter((e) => TERMINAL.has(e.state) && e.design !== undefined && (opts.sinceMs === undefined || Date.parse(e.startedAt) >= opts.sinceMs));
  const ids = [...new Set(runs.flatMap((e) => e.design!.objectionIds))].sort();
  const objections: ObjectionRegret[] = ids.map((id) => {
    const fired = runs.filter((e) => e.design!.objectionIds.includes(id));
    const rest = runs.filter((e) => !e.design!.objectionIds.includes(id));
    const over = fired.filter((e) => (e.gateAcknowledged ?? []).some((a) => a.objectionId === id));
    const f = counts(fired, minN);
    const r = counts(rest, minN);
    let verdict: ObjectionRegret["verdict"] = "insufficient";
    let proposal: string | undefined;
    if (f.badRate !== null && r.badRate !== null) {
      const ev = `${f.bad}/${f.n} runs where it fired went badly vs ${r.bad}/${r.n} where it did not`;
      if (f.badRate >= r.badRate + RIGHT_MARGIN) { verdict = "right"; proposal = `Keep or promote ${id}: ${ev}, correlated with the objection (not proven causal).`; }
      else if (f.badRate <= r.badRate) { verdict = "noise"; proposal = `Consider downgrading ${id}: ${ev}, so it looks like noise here (a human should confirm before editing .fleet/rules.yml).`; }
    }
    return { objectionId: id, fired: f, notFired: r, overridden: over.length, overriddenBad: over.filter(wentBadly).length, verdict, ...(proposal ? { proposal } : {}) };
  });
  const rank = (o: ObjectionRegret): number => (o.fired.badRate !== null && o.notFired.badRate !== null ? o.fired.badRate - o.notFired.badRate : -Infinity);
  objections.sort((a, b) => rank(b) - rank(a) || a.objectionId.localeCompare(b.objectionId));
  return {
    runs: runs.length,
    minN,
    note: `A verdict needs at least ${minN} runs on each side. Correlation, not causation; no rule changes automatically.`,
    objections,
  };
}

/**
 * Per-dispatch nudge budget: keep at most `max` nudges, dropping the lowest-value first. Value is the
 * measured regret when known (right > unknown > noise), then the objection's own order. Blocking
 * objections are never dropped. Pure; callers decide whether to apply it.
 */
export function applyNudgeBudget<T extends { id: string; severity: string }>(objections: T[], max: number, report?: RegretReport): T[] {
  const nudges = objections.filter((o) => o.severity === "nudge");
  if (!Number.isInteger(max) || max < 0 || nudges.length <= max) return objections;
  const score = (id: string): number => {
    const v = report?.objections.find((o) => o.objectionId === id)?.verdict;
    return v === "right" ? 2 : v === "noise" ? 0 : 1;
  };
  const keep = new Set([...nudges].map((o, i) => ({ o, i })).sort((a, b) => score(b.o.id) - score(a.o.id) || a.i - b.i).slice(0, max).map((x) => x.o));
  return objections.filter((o) => o.severity !== "nudge" || keep.has(o));
}
