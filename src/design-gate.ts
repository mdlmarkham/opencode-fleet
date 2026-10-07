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
  /** The run's goal (issue #260), used only to notice the same task being claimed twice. */
  goal?: string;
}

/** Whitespace/case-insensitive form of a goal, so the same task worded identically compares equal (issue #260). */
export const normalizeGoal = (g: unknown): string => String(g ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);

export interface GateBounds {
  maxScopePatterns: number;
  maxAcceptanceItems: number;
}

export const DEFAULT_GATE_BOUNDS: GateBounds = { maxScopePatterns: 20, maxAcceptanceItems: 15 };

export interface GateContext {
  inFlight?: InFlightRun[];
  /** Running work on this checkout path on ANY node (issue #260): the claim check is not limited to the target node. */
  liveAnywhere?: InFlightRun[];
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

/**
 * Issue #288: does this spec ask the worker to DISCOVER something rather than DO
 * something? Pure and conservative — it looks only at the GOAL's wording, never at
 * acceptance/verify/scope (a discovery brief can carry all three and still be
 * unanswerable).
 *
 * Review-fixed (independent review, 2026-10-06): the first cut produced FALSE POSITIVES
 * on ordinary tasks — `Add a plan field to the mission record` matched the noun use of
 * "plan … the", and `Rename why-not-retry to explain-retry` matched "why-not". A false
 * positive under `project.gate: "enforce"` BLOCKS a normal dispatch, so precision
 * matters more than recall here. Rules now:
 *   - a goal that names a CONCRETE CHANGE VERB (add/fix/rename/implement/remove/update/
 *     refactor/move/delete/… ) is a fix, never a discovery — bail out entirely.
 *   - strong verbs must be IMPERATIVE at the start of the goal or a sentence
 *     (`^` or after `[.!?] `), not buried as nouns.
 *   - `why` must be a STANDALONE word with a following clause, never part of a
 *     hyphenated token like `why-not`.
 *   - the noun use of "design/plan/architect" is dropped; only the interrogative/
 *     imperative construction `design (an|the) … for` counts, and only with no change verb.
 */
export function discoverySignal(spec: { goal: string }): { phrases: string[]; soft: string[] } {
  const goal = String(spec.goal ?? "").toLowerCase().trim();
  const hit = (res: RegExp[]): string[] => {
    const found: string[] = [];
    for (const re of res) {
      const m = goal.match(re);
      if (m && typeof m[0] === "string") found.push(m[0].trim());
    }
    return [...new Set(found)];
  };
  // A goal whose PRIMARY verb is a concrete change ("Add…", "Fix…", "Rename…") is a fix,
  // not a discovery — the single biggest precision guard (review finding 1). It must be
  // the LEADING verb: "Determine why … and fix it" is a discovery whose subordinate clause
  // happens to say `fix`, and exempting it would drop the very case this check exists for
  // (the reviewer's own counterexample). So we require the change verb at the START
  // (optionally after an article/pronoun), not anywhere in the string.
  const CHANGE_VERB_LEADING = /^\s*(?:please\s+)?(?:add|fix|rename|implement|remove|update|refactor|move|delete|bump|migrate|wire|hook up|introduce|extract|inline|split|merge|replace|use|make|create|write|port|upgrade|pin|trim|document)\b/;
  if (CHANGE_VERB_LEADING.test(goal)) return { phrases: [], soft: hit(SOFT_ONLY) };
  // Strong: an IMPERATIVE ask (start of goal / start of a sentence) to find a cause.
  // A bare word is not enough: `Diagnose output should be redacted` and `Investigate and fix
  // the timeout` LEAD with diagnose/investigate but use them as NOUNS (a titled phrase), not
  // imperatives — the reviewer's counterexamples. An imperative takes an object directly
  // ("determine why…", "diagnose the failure"), so the verb must be followed by an object
  // clause/subject, not by `and`/a noun-compound. We require the verb followed by a
  // determiner/wh-word/pronoun (the, a, an, why, how, whether, what, this, it) or by the
  // end of the phrase — the shape of a real instruction.
  const IMPERATIVE_TAIL = /^\s+(?:the|a|an|why|how|whether|what|which|if|this|that|it|these|those)\b/;
  const strong = (m: RegExpMatchArray | null): string | undefined => {
    if (!m) return undefined;
    const whole = m[0];
    const verb = m[1] ?? "";
    // the text right after the matched verb, up to the end of the goal
    const after = goal.slice(goal.indexOf(verb) + verb.length);
    // `investigate/… and <change verb>` is a fix phrased with investigation padding
    if (/^\s+and\s+(?:(?:then|also|finally|subsequently)\s+)?(?:fix|add|update|rename|remove|implement|refactor|move|delete|change|patch)\b/.test(after)) return undefined;
    // a following noun-compound (`diagnose output`, `investigate helper`) is a noun use, not an imperative
    if (/^\s+[a-z][a-z-]*\s+(?:should|must|is|are|will|was|were)\b/.test(after)) return undefined;
    return IMPERATIVE_TAIL.test(after) || after.trim() === "" ? whole.trim() : undefined;
  };
  const hits: string[] = [];
  const imper = goal.match(/(?:^|[.!?]\s+)(determine|figure out|find out|work out|diagnose|investigate|troubleshoot|debug)\b/);
  const imperHit = strong(imper);
  if (imperHit) hits.push(imperHit);
  const extra: RegExp[] = [
    /\bfind the root cause\b/,
    /\broot[- ]cause\b/,
    // a standalone `why` followed by a clause, not part of `why-not` / `why-x`
    /(?<![\w-])why(?![\w-])\s+\w[^.?]{0,80}\b(happen|happens|happened|occur|occurs|fail|fails|failed|break|breaks|broke|orphan|orphans|not)\b/,
    // interrogative/imperative design ask: `design (an|the) … for …` (not the noun use)
    /(?:^|[.!?]\s+)(design|architect|plan)\s+(a|an|the)\s+\w[^.?]{0,60}\bfor\b/,
    /\b(research|survey|evaluate|assess|compare)\b[^.?]{0,60}\b(options|approaches?|alternatives|feasibility)\b/,
    // `propose/recommend/suggest … <design|approach|plan|…>`
    /(?:^|[.!?]\s+)(propose|recommend|suggest)\b[^.?]{0,60}\b(design|approach|plan|architecture|strategy)\b/,
  ];
  return { phrases: [...new Set([...hits, ...hit(extra)])], soft: hit(SOFT_ONLY) };
}

// Soft phrases are their own constant so the concrete-change bail-out can still report them.
const SOFT_ONLY: RegExp[] = [
  /\bunderstand\b/,
  /\bexplore\b/,
  /\bclarify\b/,
  /\bconsider\b/,
  /\bdecide\b/,
  /\bstrategy\b/,
  /\bapproach\b/,
  /\bbest way\b/,
  /\btrade[- ]?offs?\b/,
  /\bdesign\b/,
];

function checks(spec: TaskSpec, ctx: GateContext): Objection[] {
  const out: Objection[] = [];
  const b = bounds(ctx);

  if (!spec.acceptance || spec.acceptance.length === 0) {
    out.push(objection({ id: "spec.no-acceptance", severity: "nudge", message: "The spec has no acceptance criteria, so neither the worker nor a reviewer can tell when it is done.", evidence: "spec.acceptance is absent or empty", suggestion: "Add 2-5 checkable acceptance criteria." }));
  }
  if (!spec.verify || (!spec.verify.command && !(spec.verify.commands && spec.verify.commands.length) && !(spec.verify.files && spec.verify.files.length))) {
    out.push(objection({ id: "spec.no-verify", severity: "nudge", message: "The spec has no verify gate, so success rests on the worker's own claim.", evidence: "spec.verify is absent or empty", suggestion: "Add verify.command (a repo script that exits 0) or verify.files (paths that must exist)." }));
  }
  if (!spec.scope || spec.scope.files.length === 0) {
    out.push(objection({ id: "spec.no-scope", severity: "nudge", message: "The spec declares no file scope, so out-of-scope edits cannot be detected and overlap with other runs cannot be checked.", evidence: "spec.scope is absent or empty", suggestion: "Add scope.files listing the paths or globs the task should touch." }));
  }

  // Issue #288: a spec that asks the worker to DISCOVER something (rather than DO
  // something) is a design question, not a task. This is the check that makes the
  // `needs-design` verdict reachable at all — observed live 2026-10-06, when a
  // "determine why X happens" brief burned 28 minutes and 287k tokens before hitting
  // the wall-clock limit with an empty clone. Shape checks pass such a spec (it has
  // acceptance, a verify gate, a scope); only its INTENT gives it away.
  const discovery = discoverySignal(spec);
  if (discovery.phrases.length > 0) {
    out.push(objection({
      id: "spec.needs-design",
      severity: "block-candidate",
      message: "The goal asks the worker to DISCOVER a cause or design, not to make a defined change. That is a design conversation, not a dispatchable task: a worker will spend its whole budget exploring and return nothing usable.",
      evidence: `open-ended phrasing in the goal: ${discovery.phrases.map((p) => `"${p}"`).join(", ")}`,
      suggestion: "(a) do the diagnosis/design in a session first, then dispatch the resulting DEFINED fix; or (b) restate the goal as a concrete change with a checkable deliverable.",
    }));
  } else if (discovery.soft.length >= 2) {
    out.push(objection({
      id: "spec.design-adjacent",
      severity: "nudge",
      message: "The goal leans toward investigation or design; make the deliverable concrete or the worker may explore without producing a checkable change.",
      evidence: `investigation-flavoured wording in the goal: ${discovery.soft.map((p) => `"${p}"`).join(", ")}`,
      suggestion: "State the change to make, or split the investigation out into a design step.",
    }));
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

  // Issue #260 (claim before dispatch): the same task already running anywhere on this checkout is duplicate
  // work (it happened: one issue dispatched by the fleet and by a parallel session). Acknowledgeable for a
  // deliberate rerun. Identical wording only: this is a claim check, not a similarity search.
  const wanted = normalizeGoal(spec.goal);
  const dupes = wanted ? (ctx.liveAnywhere ?? []).filter((r) => r.goal !== undefined && normalizeGoal(r.goal) === wanted) : [];
  if (dupes.length > 0) {
    out.push(objection({ id: "overlap.duplicate-goal", severity: "block-candidate", message: "A run with this exact goal is already in flight on this checkout; dispatching it again is duplicate work.", evidence: `in-flight run(s) with the same goal: ${[...new Set(dupes.map((r) => `${r.runId} (${r.node})`))].join(", ")}`, suggestion: "Adopt the running run (fleet_run_status / fleet_await), wait for it, or acknowledge overlap.duplicate-goal with a reason if this is a deliberate rerun." }));
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
  if (open.some((o) => o.id === "overlap.in-flight" || o.id === "overlap.duplicate-goal")) return "reject-with-reason";
  // Issue #288: a design question outranks "too large" — splitting an unanswerable
  // spec does not make it answerable. The verdict the vocabulary always had, now emitted.
  if (open.some((o) => o.id === "spec.needs-design")) return "needs-design";
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
