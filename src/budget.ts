/**
 * Budget accounting + enforcement (issue #39, slice: budget accounting + enforcement).
 * Pure helpers over the run ledger, mirroring capacity.ts (issue #39 slice 1).
 *
 * Spend comes from ledger entries: when the manager reconciles a finished run it records the
 * audit manifest's usage (tokens, costUsd when the engine reports one) on the entry. A run is
 * accounted to the UTC day it STARTED, so the daily window needs no clock of its own — the
 * day's spend is derived from the ledger, and it resets at 00:00 UTC because that is what
 * dayKey buckets. No persistence beyond the ledger.
 *
 * A dispatch over budget gets a retryable "budget-exhausted" result shaped exactly like
 * "no-capacity", so callers retry the same way they retry capacity. Per-dispatch cap
 * overrides take precedence over the config defaults, both stricter and looser.
 */

import type { LedgerEntry, RunUsage } from "./ledger.js";
import { usageOf } from "./ledger.js";

export interface BudgetLimits {
  /** Max total USD spend across the whole fleet per UTC day. */
  dailyCostUsd?: number;
  /** Max total tokens across the whole fleet per UTC day. */
  dailyTokens?: number;
  /** Per-run cost cap, default for every dispatch. */
  perDispatchCostUsd?: number;
  /** Per-run token cap, default for every dispatch. */
  perDispatchTokens?: number;
}

export type PerDispatchCaps = Pick<BudgetLimits, "perDispatchCostUsd" | "perDispatchTokens">;

export interface Spend {
  costUsd: number;
  tokens: number;
}

export type BudgetCheck = { allowed: boolean; reason?: string; spent?: Spend };

export type BudgetConfig =
  | { ok: true; config?: BudgetLimits }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Cap values: finite numbers >= 0 (a cap of 0 means "nothing may spend"). */
const isCap = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

const BUDGET_KEYS = ["dailyCostUsd", "dailyTokens", "perDispatchCostUsd", "perDispatchTokens"] as const;

/**
 * Validate the optional `budget` config block at load. Absent => no budget; present but
 * malformed => a precise error instead of silently ignoring a typo'd block. At least one
 * cap must be named, so an empty `budget: {}` is a mistake the operator hears about.
 */
export function parseBudgetConfig(raw: unknown): BudgetConfig {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) return { ok: false, error: "budget must be an object" };
  for (const k of Object.keys(raw)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(k)) {
      return { ok: false, error: `budget.${k}: unknown key (expected ${BUDGET_KEYS.join(", ")})` };
    }
  }
  const out: BudgetLimits = {};
  let any = false;
  for (const k of BUDGET_KEYS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (!isCap(v)) return { ok: false, error: `budget.${k} must be a finite number >= 0` };
    out[k] = v;
    any = true;
  }
  if (!any) return { ok: false, error: "budget: no limits given; name at least one of dailyCostUsd, dailyTokens, perDispatchCostUsd, perDispatchTokens" };
  return { ok: true, config: out };
}

/**
 * Parse the optional per-dispatch overrides from the dispatch params (fleet_dispatch /
 * fleet_iterate). Absent fields leave the config default; a present field OVERRIDES the
 * config per-dispatch cap of the same kind — stricter or looser (issue #39 acceptance:
 * "per-dispatch override both ways"). A wrong type is a clear error, never ignored.
 */
export type OverrideParse =
  | { ok: true; override?: PerDispatchCaps }
  | { ok: false; error: string };

export function parseOverrides(raw: { perDispatchCostUsd?: unknown; perDispatchTokens?: unknown } | undefined): OverrideParse {
  if (!raw || (raw.perDispatchCostUsd === undefined && raw.perDispatchTokens === undefined)) return { ok: true };
  const out: PerDispatchCaps = {};
  if (raw.perDispatchCostUsd !== undefined) {
    if (!isCap(raw.perDispatchCostUsd)) return { ok: false, error: "perDispatchCostUsd must be a finite number >= 0" };
    out.perDispatchCostUsd = raw.perDispatchCostUsd;
  }
  if (raw.perDispatchTokens !== undefined) {
    if (!isCap(raw.perDispatchTokens)) return { ok: false, error: "perDispatchTokens must be a finite number >= 0" };
    out.perDispatchTokens = raw.perDispatchTokens;
  }
  return { ok: true, override: out };
}

/** YYYY-MM-DD in UTC: the day a ledger run is accounted to (attributed by run START). */
export function dayKey(atIso: string): string {
  return new Date(atIso).toISOString().slice(0, 10);
}

/** Ledger entries whose run started on UTC day `day` — the day's spend is derived from them. */
export function runsForDay(runs: LedgerEntry[], day: string): LedgerEntry[] {
  return runs.filter((r) => {
    if (typeof r.startedAt !== "string" || r.startedAt === "") return false;
    try { return dayKey(r.startedAt) === day; } catch { return false; }
  });
}

/** Total usage recorded on the given ledger entries. */
export function totalUsage(runs: LedgerEntry[]): Spend {
  let costUsd = 0;
  let tokens = 0;
  for (const r of runs) {
    const u = usageOf(r);
    costUsd += u.costUsd ?? 0;
    tokens += u.tokens ?? 0;
  }
  return { costUsd, tokens };
}

/** Spend across the whole ledger for the UTC day of `atIso` (default: now). */
export function daySpent(runs: LedgerEntry[], atIso: string = new Date().toISOString()): Spend {
  return totalUsage(runsForDay(runs, dayKey(atIso)));
}

/** The per-dispatch cap for one dispatch: the override when given, else the config default. */
export function effectiveCaps(limits: BudgetLimits | undefined, override?: PerDispatchCaps): PerDispatchCaps {
  return {
    ...(override?.perDispatchCostUsd !== undefined ? { perDispatchCostUsd: override.perDispatchCostUsd } : limits?.perDispatchCostUsd !== undefined ? { perDispatchCostUsd: limits.perDispatchCostUsd } : {}),
    ...(override?.perDispatchTokens !== undefined ? { perDispatchTokens: override.perDispatchTokens } : limits?.perDispatchTokens !== undefined ? { perDispatchTokens: limits.perDispatchTokens } : {}),
  };
}

/**
 * Can this dispatch start under the configured caps?
 *
 * Daily check: the day's spend (from ledger entries started that UTC day) PLUS this run's
 * declared per-dispatch cap must fit inside the daily limit — a run that starts must be
 * estimable, and its declared cap is the only bound known before it runs. A dispatch with
 * NO declared per-dispatch cap is checked against what is already spent: once the day's
 * budget is reached or exceeded, nothing new launches (its spend is unknown, could be 0 or
 * the whole remaining budget).
 *
 * Per-dispatch check: the override's declared cap is the cap; it passes when it fits the
 * remaining budget, fails when it would overshoot the day (or when 0: nothing may spend).
 */
export function budgetCheck(
  runs: LedgerEntry[],
  limits: BudgetLimits | undefined,
  now: string,
  override?: PerDispatchCaps,
): BudgetCheck {
  if (!limits) return { allowed: true };
  const spent = daySpent(runs, now);
  const caps = effectiveCaps(limits, override);
  if (limits.dailyCostUsd !== undefined) {
    const candidate = caps.perDispatchCostUsd ?? 0;
    if (spent.costUsd + candidate > limits.dailyCostUsd || (candidate === 0 && spent.costUsd >= limits.dailyCostUsd)) {
      return { allowed: false, reason: `dailyCostUsd would be exceeded: spent ${spent.costUsd}${candidate ? ` + ${candidate} (declared per-dispatch cap)` : ""} vs cap ${limits.dailyCostUsd}`, spent };
    }
  }
  if (limits.dailyTokens !== undefined) {
    const candidate = caps.perDispatchTokens ?? 0;
    if (spent.tokens + candidate > limits.dailyTokens || (candidate === 0 && spent.tokens >= limits.dailyTokens)) {
      return { allowed: false, reason: `dailyTokens would be exceeded: spent ${spent.tokens}${candidate ? ` + ${candidate} (declared per-dispatch cap)` : ""} vs cap ${limits.dailyTokens}`, spent };
    }
  }
  return { allowed: true, spent };
}

/**
 * A "budget-exhausted" dispatch result: the same family/shape as capacity.ts's no-capacity —
 * ok:false, retryable:true, a stable `reason`, a human error, plus the day's spend so the
 * caller can see what was spent and the caps that were applied.
 */
export function budgetExhausted(spent: Spend, why: string, caps?: PerDispatchCaps): {
  ok: false;
  retryable: true;
  reason: "budget-exhausted";
  error: string;
  spent: Spend;
  caps?: PerDispatchCaps;
} {
  return {
    ok: false as const,
    retryable: true as const,
    reason: "budget-exhausted" as const,
    error: `budget exhausted: ${why}. Retry after the 00:00 UTC reset or raise budget.* in the plugin config.`,
    spent,
    ...(caps ? { caps } : {}),
  };
}

/**
 * Convert an audit manifest's `usage` (audit.ts Commands["usage"]: engine-reported token
 * fields + costUsd) into ledger RunUsage: tokens summed, cost kept. Manifest shapes are the
 * engine's — read defensively; absent or malformed => undefined (nothing recorded).
 */
export function usageFromManifest(manifest: unknown): RunUsage | undefined {
  if (!isRecord(manifest)) return undefined;
  const u = manifest.usage;
  if (!isRecord(u)) return undefined;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const tokens =
    n(u.tokens) ||
    n(u.inputTokens) + n(u.outputTokens) + n(u.reasoningTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
  const costUsd = n(u.costUsd);
  if (tokens <= 0 && costUsd <= 0) return undefined;
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}