/**
 * Deterministic design gate (issue #117, P-3 v1): decides, with no model call, whether a task spec
 * is ready to dispatch. Pure: spec + context in, a typed verdict out.
 *
 * Every objection carries evidence (a run id, a count, a missing field). An objection without
 * evidence is a bug, so `objection()` refuses to build one. The checks here need only the spec and
 * the ledger. The record-dependent checks (risky surfaces, decisions, baseline, pitfalls) arrive
 * with the `.fleet/` record (#114) and the adoption baseline (#115).
 */

import { parseScope, scopeOverlap } from "./scope.js";
import type { TaskSpec } from "./spec.js";

export type Verdict = "accept" | "accept-with-nudges" | "needs-design" | "decompose" | "reject-with-reason";
/** nudge: informational. block-candidate: blocks in `enforce` unless acknowledged. block: operator-only, never acknowledgeable. */
export type Severity = "nudge" | "block-candidate" | "block";

export interface Objection {
  id: string;
  severity: Severity;
  message: string;
  /** Mandatory: what in the spec or ledger this objection is about. */
  evidence: string;
  suggestion: string;
  /** Set when the caller acknowledged this objection (reason recorded). */
  acknowledged?: string;
}

export interface InFlightRun {
  runId: string;
  node: string;
  cwd: string;
  scope?: { files: string[] };
  /** True when the run works in its own clone, so it cannot clobber a shared checkout. */
  isolated?: boolean;
}

export interface GateBounds {
  maxScopePatterns: number;
  maxAcceptanceItems: number;
}

export const DEFAULT_GATE_BOUNDS: GateBounds = { maxScopePatterns: 20, maxAcceptanceItems: 15 };

export interface GateContext {
  inFlight?: InFlightRun[];
  /** Whether the new run gets its own clone (isolation "clone"). */
  isolated?: boolean;
  bounds?: Partial<GateBounds>;
}

export interface Acknowledgement {
  objectionId: string;
  reason: string;
}

export interface GateResult {
  verdict: Verdict;
  objections: Objection[];
  /** True when an unacknowledged block-candidate/block objection remains (what `enforce` refuses on). */
  blocked: boolean;
  acknowledged: Array<{ objectionId: string; reason: string }>;
}

export function objection(o: Omit<Objection, "evidence"> & { evidence: string }): Objection {
  if (typeof o.evidence !== "string" || o.evidence.trim() === "") throw new Error(`objection ${o.id} has no evidence`);
  return o;
}

export type AckResult = { ok: true; acks: Acknowledgement[] } | { ok: false; error: string };

/** Validate the caller's `acknowledge` param. Absent means none. */
export function parseAcknowledge(v: unknown): AckResult {
  if (v === undefined || v === null) return { ok: true, acks: [] };
  if (!Array.isArray(v) || v.length > 50) return { ok: false, error: "acknowledge must be an array of at most 50 {objectionId, reason}" };
  const acks: Acknowledgement[] = [];
  for (const a of v) {
    if (typeof a !== "object" || a === null || Array.isArray(a)) return { ok: false, error: "acknowledge entries must be objects {objectionId, reason}" };
    const { objectionId, reason } = a as { objectionId?: unknown; reason?: unknown };
    if (typeof objectionId !== "string" || objectionId.trim() === "") return { ok: false, error: "acknowledge.objectionId must be a non-empty string" };
    if (typeof reason !== "string" || reason.trim() === "" || reason.length > 500) return { ok: false, error: "acknowledge.reason must be a string of 1-500 characters" };
    acks.push({ objectionId, reason: reason.trim() });
  }
  return { ok: true, acks };
}

const bounds = (c: GateContext): GateBounds => ({ ...DEFAULT_GATE_BOUNDS, ...c.bounds });

function checks(spec: TaskSpec, ctx: GateContext): Objection[] {
  const out: Objection[] = [];
  const b = bounds(ctx);

  if (!spec.acceptance || spec.acceptance.length === 0) {
    out.push(objection({ id: "spec.no-acceptance", severity: "nudge", message: "The spec has no acceptance criteria, so neither the worker nor a reviewer can tell when it is done.", evidence: "spec.acceptance is absent or empty", suggestion: "Add 2-5 checkable acceptance criteria." }));
  }
  if (!spec.verify || (!spec.verify.command && !(spec.verify.commands && spec.verify.commands.length) && !(spec.verify.files && spec.verify.files.length))) {
    out.push(objection({ id: "spec.no-verify", severity: "nudge", message: "The spec has no verify gate, so success rests on the worker's own claim.", evidence: "spec.verify is absent or empty", suggestion: "Add verify.command (a repo script that exits 0) or verify.files." }));
  }
  if (!spec.scope || spec.scope.files.length === 0) {
    out.push(objection({ id: "spec.no-scope", severity: "nudge", message: "The spec declares no file scope, so out-of-scope edits cannot be detected and overlap with other runs cannot be checked.", evidence: "spec.scope is absent or empty", suggestion: "Add scope.files listing the paths or globs the task should touch." }));
  }

  const nScope = spec.scope?.files.length ?? 0;
  const nAcc = spec.acceptance?.length ?? 0;
  if (nScope > b.maxScopePatterns || nAcc > b.maxAcceptanceItems) {
    const parts = [
      ...(nScope > b.maxScopePatterns ? [`scope has ${nScope} patterns (limit ${b.maxScopePatterns})`] : []),
      ...(nAcc > b.maxAcceptanceItems ? [`${nAcc} acceptance items (limit ${b.maxAcceptanceItems})`] : []),
    ];
    out.push(objection({ id: "spec.too-large", severity: "block-candidate", message: "The spec is larger than one task should be.", evidence: parts.join("; "), suggestion: "Split it into smaller specs with disjoint scopes and dependencies between them." }));
  }

  const mine = parseScope(spec.scope);
  const myScope = mine.ok ? mine.scope : undefined;
  const live = (ctx.inFlight ?? []);
  const shared = live.filter((r) => !r.isolated && !ctx.isolated);
  const overlapping = myScope ? shared.filter((r) => { const t = parseScope(r.scope); return t.ok && t.scope && scopeOverlap(myScope, t.scope); }) : [];
  if (overlapping.length > 0) {
    out.push(objection({ id: "overlap.in-flight", severity: "block-candidate", message: "Another run on this checkout is already working on overlapping files; running both at once will clobber each other.", evidence: `in-flight run(s) with overlapping scope: ${overlapping.map((r) => `${r.runId} (${r.node})`).join(", ")}`, suggestion: "Wait for them to finish, serialise the specs, or dispatch with isolation \"clone\"." }));
  }
  const unknown = shared.filter((r) => !overlapping.includes(r) && !(r.scope && r.scope.files.length)).concat(myScope ? [] : shared.filter((r) => !overlapping.includes(r)));
  const unknownIds = [...new Set(unknown.map((r) => r.runId))];
  if (overlapping.length === 0 && unknownIds.length > 0) {
    out.push(objection({ id: "overlap.unknown", severity: "nudge", message: "Another run is active on this checkout and overlap cannot be ruled out because a scope is missing.", evidence: `in-flight run(s) on the same checkout: ${unknownIds.join(", ")}`, suggestion: "Declare scope.files on both specs, or use isolation \"clone\"." }));
  }
  const isolatedOverlap = myScope
    ? live.filter((r) => { const t = parseScope(r.scope); return (r.isolated || ctx.isolated) && t.ok && t.scope && scopeOverlap(myScope, t.scope); })
    : [];
  if (isolatedOverlap.length > 0) {
    out.push(objection({ id: "overlap.merge", severity: "nudge", message: "Overlapping scope with a run in a separate clone: no clobbering, but the branches will conflict at sync time.", evidence: `in-flight run(s) with overlapping scope: ${isolatedOverlap.map((r) => r.runId).join(", ")}`, suggestion: "Serialise them or expect a merge conflict at fleet_sync." }));
  }
  return out;
}

/** Apply acknowledgements: block-candidates can be acknowledged; operator `block` objections cannot; unknown ids are an error. */
export function applyAcknowledgements(objections: Objection[], acks: Acknowledgement[]): { ok: true; objections: Objection[]; acknowledged: Array<{ objectionId: string; reason: string }> } | { ok: false; error: string } {
  const byId = new Map(objections.map((o) => [o.id, o]));
  const acknowledged: Array<{ objectionId: string; reason: string }> = [];
  const next = objections.map((o) => ({ ...o }));
  for (const a of acks) {
    const o = byId.get(a.objectionId);
    if (!o) return { ok: false, error: `acknowledge: no such objection ${a.objectionId} (current: ${objections.map((x) => x.id).join(", ") || "none"})` };
    if (o.severity === "block") return { ok: false, error: `acknowledge: ${a.objectionId} is an operator block and cannot be acknowledged` };
    const target = next.find((x) => x.id === a.objectionId)!;
    target.acknowledged = a.reason;
    acknowledged.push({ objectionId: a.objectionId, reason: a.reason });
  }
  return { ok: true, objections: next, acknowledged };
}

export function verdictOf(objections: Objection[]): Verdict {
  const open = objections.filter((o) => !o.acknowledged);
  if (open.some((o) => o.id === "overlap.in-flight")) return "reject-with-reason";
  if (open.some((o) => o.id === "spec.too-large")) return "decompose";
  if (objections.length > 0) return "accept-with-nudges";
  return "accept";
}

/** Run the gate. Returns an error only for a bad acknowledgement; otherwise a verdict. */
export function evaluateDesignGate(spec: TaskSpec, ctx: GateContext = {}, acks: Acknowledgement[] = []): { ok: true; result: GateResult } | { ok: false; error: string } {
  const found = checks(spec, ctx);
  const applied = applyAcknowledgements(found, acks);
  if (!applied.ok) return applied;
  const blocked = applied.objections.some((o) => !o.acknowledged && (o.severity === "block-candidate" || o.severity === "block"));
  return { ok: true, result: { verdict: verdictOf(applied.objections), objections: applied.objections, blocked, acknowledged: applied.acknowledged } };
}
