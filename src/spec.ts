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
  /**
   * Issue #105: the commit/branch a run's clone STARTS from (exactly one of the
   * two). Requires isolation "clone" (refused at dispatch otherwise) and a node
   * of protocol 6+; the base resolves inside the clone, never from HEAD.
   */
  base?: { branch?: string; commit?: string };
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

/** A branch ref name: no `..`, no whitespace, no leading `-`, no control chars. Plain ref names only (no `refs/...`, no `^`, `~`, `:`, `?`, `[`, `\`). */
const BASE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
/** A commit is 40–64 hex chars. */
const BASE_COMMIT_RE = /^[0-9a-f]{40,64}$/;

/**
 * Validate the optional `base` (issue #105): exactly one of `branch` (plain ref
 * name) or `commit` (40–64 hex). Absent/null = no base, unchanged behavior;
 * anything present must shape-check or the spec is refused, never trimmed.
 * Exported because the node handler re-validates the untrusted task payload the
 * same way it re-validates `scope` — one parser, one refusal path.
 */
export function parseBase(value: unknown): { ok: true; base?: { branch?: string; commit?: string } } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "base must be an object {branch|commit}" };
  }
  const b = value as Record<string, unknown>;
  const keys = Object.keys(b);
  const unknownKeys = keys.filter((k) => k !== "branch" && k !== "commit");
  if (unknownKeys.length) return { ok: false, error: `base has unknown key(s): ${unknownKeys.join(", ")}` };
  const branch = b.branch;
  const commit = b.commit;
  if (branch !== undefined && commit !== undefined) {
    return { ok: false, error: "base must name exactly one of branch or commit, not both" };
  }
  if (branch === undefined && commit === undefined) {
    return { ok: false, error: "base must name exactly one of branch or commit" };
  }
  if (branch !== undefined) {
    if (typeof branch !== "string" || branch.length === 0 || !BASE_BRANCH_RE.test(branch)
      || branch.includes("..") || /\s/.test(branch) || branch.startsWith("-")) {
      return { ok: false, error: `base.branch must be a plain ref name: ${JSON.stringify(String(branch).slice(0, 60))}` };
    }
    return { ok: true, base: { branch } };
  }
  if (typeof commit !== "string" || !BASE_COMMIT_RE.test(commit)) {
    return { ok: false, error: "base.commit must be a hex commit sha (40-64 chars)" };
  }
  return { ok: true, base: { commit } };
}

export function parseTaskSpec(value: unknown): TaskSpecResult {
  if (value === undefined || value === null) return { ok: true, spec: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "spec must be an object {goal, acceptance?, verify?}" };
  }
  const s = value as { goal?: unknown; acceptance?: unknown; verify?: unknown; scope?: unknown; base?: unknown };
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
  const base = parseBase(s.base);
  if (!base.ok) return { ok: false, error: `spec.${base.error}` };
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