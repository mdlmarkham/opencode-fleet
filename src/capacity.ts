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
