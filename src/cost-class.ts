/**
 * Issue #259 slice 1: pure TASK COST CLASSIFIER — classification ONLY, no
 * wiring into dispatch or any tool. Maps a task spec onto a cost class from
 * measurable properties (acceptance item count, scope pattern count, sensitive
 * surface in the goal). Deliberately dependency-free and pure exactly like
 * spec.ts/design-gate.ts: no I/O, no clock, no randomness — a deterministic
 * function of its input so later slices can re-use and tune it safely.
 */

/** Cost classes, cheapest first. */
export type CostClass = "trivial" | "standard" | "heavy";

/**
 * Tuning knobs (issue #259 slice 2 may adjust these; rules only read them
 * through `costClassOf`, so retuning is a one-constant change):
 * - TRIVIAL_MAX_ACCEPTANCE: a spec is trivially small with at most this many
 *   acceptance items (1 by default; 0 or absent also counts trivial).
 * - TRIVIAL_MAX_SCOPE_PATTERNS: ...and at most this many scope.files patterns.
 * - HEAVY_MIN_ACCEPTANCE: at least this many acceptance items => heavy (6).
 * - HEAVY_MIN_SCOPE_PATTERNS: at least this many scope patterns => heavy (10).
 */
export const TRIVIAL_MAX_ACCEPTANCE = 1;
export const TRIVIAL_MAX_SCOPE_PATTERNS = 1;
export const HEAVY_MIN_ACCEPTANCE = 6;
export const HEAVY_MIN_SCOPE_PATTERNS = 10;

/** Goal words that name a sensitive surface; ANY match forces 'heavy'. */
export const SENSITIVE_SURFACES = ["guard", "deny-baseline", "ssh", "provision", "secret", "auth", "credential"] as const;

function touchesSensitiveSurface(goal: string): boolean {
  const hay = goal.toLowerCase();
  return SENSITIVE_SURFACES.some((w) => hay.includes(w));
}

/**
 * Classify a spec's cost class (pure; see module doc). Order: 'heavy' wins on
 * any heavy signal (large acceptance, wide scope, sensitive surface in the
 * goal), then 'trivial' when BOTH measures are at/below their trivial caps,
 * else 'standard'.
 */
export function costClassOf(spec: { goal: string; acceptance?: string[]; scope?: { files: string[] } }): CostClass {
  const nAcc = spec.acceptance?.length ?? 0;
  const nScope = spec.scope?.files?.length ?? 0;
  if (nAcc >= HEAVY_MIN_ACCEPTANCE || nScope >= HEAVY_MIN_SCOPE_PATTERNS || touchesSensitiveSurface(spec.goal)) {
    return "heavy";
  }
  if (nAcc <= TRIVIAL_MAX_ACCEPTANCE && nScope <= TRIVIAL_MAX_SCOPE_PATTERNS) {
    return "trivial";
  }
  return "standard";
}