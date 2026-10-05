/**
 * Per-node concurrency slots (issue #39, slice 1). Pure helpers over the run ledger.
 *
 * A slot is held by a ledger entry in state `running`. The ledger is the only record the gateway
 * has, and an entry stays `running` until something observes the run finish, so a run whose
 * process died unobserved would hold its slot forever. Entries older than `staleAfterMs` are
 * therefore not counted (and are reported as suspected stale for a human or fleet_recover to
 * settle) rather than blocking the node indefinitely.
 */

import type { LedgerEntry } from "./ledger.js";

export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60_000;
export const MAX_CONCURRENT_LIMIT = 64;

export interface CapacityConfig {
  maxConcurrentPerNode?: unknown;
  staleAfterMs?: unknown;
}

export type Limit = { ok: true; limit?: number } | { ok: false; error: string };

const validLimit = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_CONCURRENT_LIMIT;

/** A node's slot limit: its own `maxConcurrent`, else the global `capacity.maxConcurrentPerNode`, else unlimited. Invalid values are errors, never silently "unlimited". */
export function slotLimit(capacity: CapacityConfig | undefined, member: { maxConcurrent?: unknown } | undefined): Limit {
  if (member?.maxConcurrent !== undefined) {
    return validLimit(member.maxConcurrent) ? { ok: true, limit: member.maxConcurrent } : { ok: false, error: `nodes.<name>.maxConcurrent must be an integer 1-${MAX_CONCURRENT_LIMIT}` };
  }
  if (capacity?.maxConcurrentPerNode !== undefined) {
    return validLimit(capacity.maxConcurrentPerNode) ? { ok: true, limit: capacity.maxConcurrentPerNode } : { ok: false, error: `capacity.maxConcurrentPerNode must be an integer 1-${MAX_CONCURRENT_LIMIT}` };
  }
  return { ok: true };
}

export function staleAfter(capacity: CapacityConfig | undefined): number {
  const v = capacity?.staleAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 60_000 ? v : DEFAULT_STALE_AFTER_MS;
}


/** Running entries on a node, split into those holding a slot and those suspected stale. */
export function liveRuns(runs: LedgerEntry[], nodeNames: string[], now: number, staleAfterMs: number): { live: LedgerEntry[]; stale: LedgerEntry[] } {
  const names = new Set(nodeNames);
  const live: LedgerEntry[] = [];
  const stale: LedgerEntry[] = [];
  for (const r of runs) {
    if (r.state !== "running" || !names.has(r.node)) continue;
    const t = Date.parse(r.updatedAt || r.startedAt);
    (Number.isFinite(t) && now - t > staleAfterMs ? stale : live).push(r);
  }
  return { live, stale };
}

/** What the design gate needs from the ledger: live conflict evidence + informational recent history (issue #196). */
export interface InFlightRun { runId: string; node: string; cwd: string; scope?: { files: string[] }; isolated?: boolean }
export type LedgerLike = {
  runId: string; node: string; cwd: string; state: string;
  startedAt?: string; updatedAt?: string; finishedAt?: string;
  spec?: { scope?: { files?: string[] } } | unknown;
  runCwd?: string;
  [k: string]: unknown;
};

/** Shape a ledger entry into the design gate's InFlightRun: spec scope rides along; a separate runCwd marks the run isolated. */
export function ledgerToInFlight(r: LedgerLike): InFlightRun {
  const spec = r.spec as { scope?: { files?: string[] } } | undefined;
  return {
    runId: r.runId,
    node: r.node,
    cwd: r.cwd,
    ...(spec?.scope && Array.isArray(spec.scope.files) && spec.scope.files.length ? { scope: { files: spec.scope.files } } : {}),
    ...(r.runCwd ? { isolated: true } : {}),
  };
}

/**
 * The ledger input for the design gate (issue #196): only genuinely-running entries
 * (state=running, not past staleAfterMs — the same reconcile fleet_capacity uses) are
 * in-flight conflict evidence. Finished entries ride ONLY as informational
 * `recentlyFinished`; a run that expired the stale window also drops out (fleet_capacity
 * already treats those as suspected-stale, not live).
 */
export function capacityInputFromLedger(
  runs: LedgerLike[],
  opts: { nodeNames?: string[]; cwd?: string; excludeRunId?: string; now: number; staleAfterMs: number },
): { inFlight: InFlightRun[]; recentlyFinished: LedgerLike[] } {
  const names = opts.nodeNames ? new Set(opts.nodeNames) : undefined;
  const inFlight: InFlightRun[] = [];
  const recentlyFinished: LedgerLike[] = [];
  for (const r of runs) {
    if (opts.excludeRunId && r.runId === opts.excludeRunId) continue;
    if (names && !names.has(r.node)) continue;
    if (opts.cwd && r.cwd !== opts.cwd) continue;
    if (r.state === "running") {
      const t = Date.parse(r.updatedAt || r.startedAt || "");
      if (Number.isFinite(t) && opts.now - t <= opts.staleAfterMs) { inFlight.push(ledgerToInFlight(r)); continue; }
    }
    if (r.state !== "running" && r.finishedAt) recentlyFinished.push(r);
  }
  return { inFlight, recentlyFinished };
}

export interface NoCapacity {
  ok: false;
  retryable: true;
  reason: "no-capacity";
  error: string;
  node: string;
  limit: number;
  running: string[];
}

export function noCapacity(node: string, limit: number, running: LedgerEntry[]): NoCapacity {
  return {
    ok: false,
    retryable: true,
    reason: "no-capacity",
    error: `node ${node} is at its concurrency limit (${running.length}/${limit}); retry when a run finishes or use another node`,
    node,
    limit,
    running: running.map((r) => r.runId),
  };
}
