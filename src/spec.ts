/**
 * Issue #65 slice 1: the structured task spec — a dispatch unit with an
 * explicit GOAL, ACCEPTANCE criteria and a VERIFY gate.
 *
 * `fleet_dispatch` accepts it as an optional `spec` param:
 *
 *     { goal: string; acceptance?: string[]; verify?: { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number } }
 *
 * When a spec is given the engine prompt is RENDERED from `goal` +
 * `acceptance` (the flat `prompt` param is then ignored), and `verify` is
 * mapped onto the exact same post-run verification gate the flat `expect`
 * param already uses (issue #62/#40): same parser, same node evaluator, same
 * ledger shape. When only `prompt` is given, nothing changes at all —
 * `renderSpec({ goal: prompt })` returns the prompt byte-identically.
 *
 * This module is deliberately dependency-free and pure (no I/O, no clock, no
 * randomness): `renderSpec` is a deterministic function of its input so the
 * rendered prompt is reproducible and unit-testable in isolation.
 */

import { parseScope } from "./scope.js";

/**
 * The structured task spec. `verify` is structurally the same gate shape as
 * the flat `expect` param (defined inline so this module stays dependency-
 * free; verified/threaded by the existing parseExpectSpec/evaluateExpect
 * machinery in verify.ts — never re-implemented here).
 */
export interface TaskSpec {
  /** The task goal — the first line of the rendered engine prompt. */
  goal: string;
  /** Acceptance criteria, rendered as a bullet list under "Acceptance criteria:". */
  acceptance?: string[];
  /**
   * Post-run verification gate (same shape + semantics as the flat `expect`
   * param, issue #62). Issue #104: `commands[]` runs EVERY command (each must
   * exit 0) with a shared `timeoutMs` bound; `command` stays as a working
   * single-command alias for one-element `commands`.
   */
  verify?: {
    /** Paths relative to the run cwd that must exist after the run. */
    files?: string[];
    /** Single-command alias for `commands: [command]` (kept for one release). */
    command?: string;
    /** Post-run verification commands run in the run cwd; EVERY one must exit 0 for the gate to pass (issue #104). */
    commands?: string[];
    /** Shared wall-clock bound applied to every command; overrides DEFAULT_EXPECT_COMMAND_TIMEOUT_MS when given (issue #104). */
    timeoutMs?: number;
  };
  /** Advisory file scope (issue #65 slice 2): repo-relative paths/globs the task should stay within. */
  scope?: { files: string[] };
  /**
   * Issue #262: references to push into the run's checkout and point the worker
   * at — convention docs, ADR summaries, interface stubs, skill names. Each entry
   * is a repo-relative path (installed into the clone) or a short identifier the
   * worker is told to consult. Rendered as a "References" block in the prompt so
   * the worker knows what was equipped for this task, not the whole repo.
   */
  references?: Array<{ path?: string; note?: string }>;
}

/**
 * Parse/validate an untrusted `spec` value from the tool call. Mirror of
 * `parseExpectSpec` (verify.ts) in spirit: absent/null means "no spec" (a
 * prompt-only call — always acceptable, fully backward compatible); anything
 * present must shape-check or the call is refused, never silently trimmed.
 *
 * `verify` is NOT validated here: it is the gate, and the gate is validated by
 * the one and only gate parser (`parseExpectSpec` in verify.ts) at the same
 * point the flat `expect` is validated — duplicated gate rules would drift.
 */
export type TaskSpecResult = { ok: true; spec?: TaskSpec } | { ok: false; error: string };

/** Caps so criteria stay a bounded, readable block of the prompt. */
export const MAX_ACCEPTANCE_ITEMS = 50;
export const MAX_ACCEPTANCE_LENGTH = 1000;

export function parseTaskSpec(value: unknown): TaskSpecResult {
  if (value === undefined || value === null) return { ok: true, spec: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "spec must be an object {goal, acceptance?, verify?}" };
  }
  const s = value as { goal?: unknown; acceptance?: unknown; verify?: unknown; scope?: unknown };
  if (typeof s.goal !== "string" || s.goal.trim().length === 0) {
    return { ok: false, error: "spec.goal must be a non-empty string" };
  }
  if (s.acceptance !== undefined) {
    if (
      !Array.isArray(s.acceptance) ||
      s.acceptance.some((a) => typeof a !== "string" || a.trim().length === 0)
    ) {
      return { ok: false, error: "spec.acceptance must be an array of non-empty strings" };
    }
  }
  if (Array.isArray(s.acceptance) && s.acceptance.length > MAX_ACCEPTANCE_ITEMS) {
    return { ok: false, error: `spec.acceptance has more than ${MAX_ACCEPTANCE_ITEMS} items` };
  }
  if (Array.isArray(s.acceptance) && s.acceptance.some((a) => (a as string).length > MAX_ACCEPTANCE_LENGTH)) {
    return { ok: false, error: `spec.acceptance items must be at most ${MAX_ACCEPTANCE_LENGTH} characters` };
  }
  const sc = parseScope(s.scope);
  if (!sc.ok) return { ok: false, error: `spec.${sc.error}` };
  // verify (if present) is validated by parseExpectSpec where the gate is
  // threaded — one parser, one refusal path (issue #65 slice 1).
  return { ok: true, spec: value as TaskSpec };
}

/**
 * Render the engine prompt from a task spec.
 *
 * Deterministic, byte-stable format:
 *
 *     <goal>
 *
 *     Acceptance criteria:
 *     - <item 1>
 *     - <item 2>
 *
 * The goal rides FIRST and VERBATIM — which makes the prompt-only path
 * provably identical: `renderSpec({ goal: prompt }) === prompt` (no
 * acceptance => no header, no blank line, not even a trailing newline).
 * Blank/whitespace-only acceptance items are dropped (they would render as
 * meaningless bullets); remaining items are kept verbatim. `verify` shapes
 * the run's gate, not the prompt — it never appears in the rendering.
 */
export function renderSpec(spec: { goal: string; acceptance?: string[]; verify?: unknown; scope?: { files: string[] }; references?: Array<{ path?: string; note?: string }> }): string {
  const goal = spec.goal;
  const items = (spec.acceptance ?? []).filter((a) => typeof a === "string" && a.trim().length > 0);
  const scope = spec.scope?.files ?? [];
  const refs = (spec.references ?? []).filter((r) => (r.path ?? r.note ?? "").trim().length > 0);
  const out = [goal];
  if (items.length) out.push("", "Acceptance criteria:", ...items.map((a) => `- ${a}`));
  if (scope.length) out.push("", "Scope (keep your changes within these paths):", ...scope.map((f) => `- ${f}`));
  if (refs.length) out.push("", "References (equipped for this task; consult before grepping):", ...refs.map((r) => `- ${[r.path, r.note].filter(Boolean).join(" — ")}`));
  return out.join("\n");
}