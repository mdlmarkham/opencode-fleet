/**
 * Issue #304: the dispatch-readiness rubric.
 *
 * The problem this addresses (observed live, 2026-10-06): a spec that asks the worker to
 * DISCOVER something burned 28 minutes and 287k tokens before hitting the wall clock with an
 * empty clone. The deterministic design gate (#117/#288) catches *known* bad shapes (missing
 * acceptance/verify/scope, too large, open-ended investigation). It cannot catch the ones
 * nobody wrote a regex for — which is exactly the class an S1 model is for.
 *
 * ## Rubric, not regex
 *
 * A rubric is explicit, versioned criteria that a judge is MEASURED against. This module
 * declares the criteria and a DETERMINISTIC baseline; the S1 `readiness.dispatch` decision
 * point (builtin-points.ts) is the judge, and `pointReport` compares the two. Per the charter
 * ("no model call on the cheap path") the baseline runs for free; the model is additive
 * evidence, never the sole gate, and (per ADR 0002) never permission.
 *
 * ## Layering
 *
 * Built-in criteria here are the defaults. A project may ADD criteria and tighten thresholds
 * (`.fleet/rubrics.yml`, a later slice); it may never weaken an operator-mandated criterion —
 * the same tighten-not-weaken rule as `.fleet/rules.yml` (mergeRules). This slice ships the
 * built-in set only.
 *
 * ## Guidance, not just a verdict
 *
 * The point of this gate is to PUSH BACK AND GUIDE. So every failed criterion yields a
 * `Guidance { what, why, fix }` entry the caller can act on immediately — not a bare "no".
 */

import type { TaskSpec } from "./spec.js";

/** One rubric criterion: what it checks, and the remedy when it fails. */
export interface RubricCriterion {
  id: string;
  /** What the criterion asks. */
  what: string;
  /** Why it matters (the failure it prevents). */
  why: string;
  /** The concrete change that satisfies it. */
  fix: string;
}

/**
 * The built-in dispatch-readiness criteria. Versioned implicitly by the point's question
 * wording version (readiness.dispatch v1). Order is presentation order.
 */
export const READINESS_CRITERIA: readonly RubricCriterion[] = [
  {
    id: "concrete-change",
    what: "The goal states a concrete change to make, not a question to answer.",
    why: "A worker asked to DISCOVER something explores until its budget runs out and returns nothing usable (the 287k-token empty-clone run).",
    fix: "State the change: 'add X to Y', 'change A to B'. If diagnosis is needed, do it first and dispatch the resulting fix.",
  },
  {
    id: "deliverable-named",
    what: "The deliverable is named — the file, function, or artifact the change produces.",
    why: "An unnamed deliverable leaves the worker to guess where the work belongs, and the guess is not reviewable.",
    fix: "Name it: a path (`src/x.ts`), a symbol (`export function f`), or an artifact.",
  },
  {
    id: "decisions-made",
    what: "No design decision is left to the worker.",
    why: "A worker choosing between designs makes an unreviewed architectural call under a token budget.",
    fix: "Choose the approach in the spec, or split the decision out and settle it before dispatch.",
  },
  {
    id: "acceptance-checkable",
    what: "Acceptance criteria describe a checkable outcome, not a quality adjective.",
    why: "Acceptance the worker cannot verify is acceptance neither the worker nor a reviewer can apply.",
    fix: "Make each criterion checkable: 'f() returns 42', not 'the design is clean'.",
  },
  {
    id: "verify-tests-acceptance",
    what: "The verify gate actually tests the stated acceptance.",
    why: "A gate that passes a change which does not meet the acceptance launders failure as success.",
    fix: "Point verify.command at a check that fails when the acceptance is unmet.",
  },
  {
    id: "right-sized",
    what: "The scope is one task, not several subsystems at once.",
    why: "An over-broad spec produces a diff too large to review and too coupled to revert.",
    fix: "Split into specs with disjoint scopes and dependencies between them.",
  },
];

/** A concrete reason a criterion failed, with the remedy. */
export interface Guidance {
  /** The criterion id that produced this guidance. */
  criterion: string;
  /** What is missing (human sentence). */
  what: string;
  /** The concrete change to make. */
  fix: string;
}

export interface ReadinessSignals {
  /** The goal's leading verb is an open-ended investigation ("determine why", "figure out", …). */
  openEnded: boolean;
  /** No acceptance criteria, or acceptance that is not checkable. */
  acceptanceUncheckable: boolean;
  /** No verify gate. */
  noVerify: boolean;
  /** No scope, or a scope larger than one task. */
  tooBroad: boolean;
  /** No file/artifact named in the goal or scope. */
  noDeliverable: boolean;
}

/**
 * The DETERMINISTIC baseline: what the free checks say, with no model call. An S1 point must
 * beat this before it may leave shadow (the #131/#234 ladder). Conservative: it fails a
 * criterion only on a signal it can see, never on a hunch.
 */
export function readinessBaseline(s: ReadinessSignals): { ready: boolean; guidance: Guidance[] } {
  const g: Guidance[] = [];
  const add = (criterion: string) => {
    const c = READINESS_CRITERIA.find((x) => x.id === criterion);
    if (c) g.push({ criterion, what: c.what, fix: c.fix });
  };
  if (s.openEnded) add("concrete-change");
  if (s.noDeliverable) add("deliverable-named");
  if (s.acceptanceUncheckable) add("acceptance-checkable");
  if (s.noVerify) add("verify-tests-acceptance");
  if (s.tooBroad) add("right-sized");
  return { ready: g.length === 0, guidance: g };
}

const OPEN_ENDED = /^\s*(?:determine|figure out|find out|work out|diagnose|investigate|troubleshoot|debug)\b/i;

/** Derive the signals from a spec, reusing the design gate's own bounds where they exist. */
export function readinessSignals(spec: TaskSpec): ReadinessSignals {
  const goal = String(spec.goal ?? "");
  const acceptance = (spec.acceptance ?? []).filter((a) => typeof a === "string" && a.trim() !== "");
  const verify = spec.verify;
  const hasVerify = Boolean(verify && ((verify.commands && verify.commands.length) || verify.command || (verify.files && verify.files.length)));
  const scope = spec.scope?.files ?? [];
  // A criterion is "checkable" when it names something assertable — a symbol, a value, an exit,
  // a path — rather than only quality adjectives. Heuristic and deliberately simple.
  const CHECKABLE = /\b(return|returns|equal|equals|==|===|exit|passes|fails|exists|contains|emits|prints|exports|has no|>|<|\d)\b/i;
  const qualityOnly = acceptance.length === 0 || acceptance.every((a) => !CHECKABLE.test(a));
  // A deliverable is "named" when the goal or scope names a path/symbol-like token.
  const namedInGoal = /\b[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.\w{1,4}\b|\b\w+\(\)|\bexport\s+(?:function|const|class)\b|`[a-z][\w.-]*`/.test(goal);
  const noDeliverable = !namedInGoal && scope.length === 0;
  return {
    openEnded: OPEN_ENDED.test(goal),
    acceptanceUncheckable: qualityOnly,
    noVerify: !hasVerify,
    tooBroad: scope.length > 20 || acceptance.length > 15,
    noDeliverable,
  };
}

/** One-shot: the deterministic readiness of a spec, with guidance. No I/O, no model. */
export function readinessOf(spec: TaskSpec): { ready: boolean; guidance: Guidance[] } {
  return readinessBaseline(readinessSignals(spec));
}
