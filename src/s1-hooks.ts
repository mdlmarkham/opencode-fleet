/**
 * Manager-side S1 hook decisions — issue #87, slice 2.
 *
 * Three small, injectable, unit-testable decision helpers the manager runs
 * at hook time:
 *
 *   - adjudicateCompletion: did the change satisfy its acceptance criteria?
 *   - triageHandRaise: answer a raised question from run context, or escalate?
 *   - routeEngine: which candidate engine should take this spec?
 *
 * DECISION LOGIC ONLY:
 *   - no network here: the S1 client is injected as `decideFn` (same
 *     signature as decision.ts `decide`) so tests stub it with no server;
 *   - no wiring: nothing is hooked into tool dispatch or schemas yet —
 *     slice 3 decides that.
 *
 * Calibration rule (from live S1 testing): every hook asks a SPECIFIC typed
 * question with the concrete artifact in `state`, and `instructions` is a
 * genuine question over those specifics — never a vague "is this safe?".
 *
 * Safe fallbacks on unavailable/malformed decisions (never assume success):
 *   - adjudicateCompletion -> satisfied: null
 *   - triageHandRaise      -> action: "escalate"
 *   - routeEngine          -> engine: null
 * Each fallback carries a `reason` naming why (the S1 error, or the
 * malformed shape), so callers can log the miss instead of swallowing it.
 */

import type { DecideInput, DecideOptions, DecideResult } from "./decision.js";

/**
 * The S1 client the hooks ask. Structurally identical to decision.ts's
 * `decide`, so the real client passes straight through and tests inject a
 * stub.
 */
export type DecideFn = (input: DecideInput, opts?: DecideOptions) => Promise<DecideResult>;

/** S1 probabilityTrue at or above which a change counts as satisfying its criteria. */
export const SATISFIED_THRESHOLD = 0.7;

/** Triage options, verbatim descriptions from issue #87. Keys ARE the option ids. */
export const HAND_RAISE_CRITERIA = {
  answer: "the run context already answers this",
  escalate: "a human/manager decision is required",
} as const;

const Q_COMPLETION = "completion";
const Q_HAND_RAISE = "handRaise";
const Q_ENGINE = "engine";

// ---------------------------------------------------------------------------
// 1. adjudicateCompletion — ONE boolean question over the acceptance set
// ---------------------------------------------------------------------------

export type AdjudicateInput = {
  /** Stated acceptance criteria the change must satisfy. */
  acceptance: string[];
  /** Short summary of the change (diff). */
  diffSummary: string;
  /** Verification details backing the claim (test output, checks, ...). */
  verifyDetails: string;
};

export type AdjudicateResult = {
  satisfied: boolean | null;
  confidence?: number;
  reason?: string;
};

export type AdjudicateOptions = {
  /** Override the default satisfied threshold (SATISFIED_THRESHOLD). */
  satisfiedThreshold?: number;
};

/**
 * Ask S1 exactly one boolean question: whether the change satisfies the
 * stated acceptance criteria, judged against the diff summary + verify
 * details sent as state. Returns `satisfied` from S1's probabilityTrue
 * (thresholded by SATISFIED_THRESHOLD, with the raw probability as
 * `confidence`), or `satisfied: null` when the decision is unavailable —
 * never assumes true.
 */
export async function adjudicateCompletion(
  input: AdjudicateInput,
  decideFn: DecideFn,
  opts: AdjudicateOptions = {},
): Promise<AdjudicateResult> {
  const acceptance = cleanStrings(input?.acceptance);
  const diffSummary = cleanText(input?.diffSummary);
  const verifyDetails = cleanText(input?.verifyDetails);

  if (acceptance.length === 0) {
    return { satisfied: null, reason: "no acceptance criteria supplied" };
  }
  if (diffSummary === "" && verifyDetails === "") {
    return {
      satisfied: null,
      reason: "no evidence supplied (diff summary and verify details both empty)",
    };
  }

  const threshold =
    typeof opts.satisfiedThreshold === "number" && Number.isFinite(opts.satisfiedThreshold)
      ? opts.satisfiedThreshold
      : SATISFIED_THRESHOLD;

  const evidence = [
    diffSummary === "" ? undefined : `diff summary: ${diffSummary}`,
    verifyDetails === "" ? undefined : `verify details: ${verifyDetails}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");

  const decision = await decideFn({
    // Concrete artifact travels in state (calibration rule).
    state: { acceptance, diffSummary, verifyDetails },
    questions: {
      [Q_COMPLETION]: {
        type: "boolean",
        instructions:
          "Does this change satisfy the stated acceptance criteria? " +
          `Criteria: ${acceptance.join("; ")}. ` +
          `Evidence: ${evidence}.`,
      },
    },
  });

  if (!decision.ok) {
    return { satisfied: null, reason: `S1 unavailable: ${decision.error}` };
  }
  const answer = decision.answers[Q_COMPLETION];
  if (!isRecord(answer) || answer.type !== "boolean" || !isFiniteNumber(answer.probabilityTrue)) {
    return { satisfied: null, reason: "S1 boolean answer missing or malformed; cannot adjudicate" };
  }
  return {
    satisfied: answer.probabilityTrue >= threshold,
    confidence: answer.probabilityTrue,
    reason: `S1 probabilityTrue=${answer.probabilityTrue} (satisfied at >= ${threshold})`,
  };
}

// ---------------------------------------------------------------------------
// 2. triageHandRaise — ONE choice question: answer from context, or escalate
// ---------------------------------------------------------------------------

export type TriageInput = {
  /** The raised question. */
  question: string;
  /** The run context that might already answer it. */
  context: string;
};

export type TriageResult = {
  action: "answer" | "escalate";
  reason?: string;
};

/**
 * Ask S1 exactly one choice question (criteria per issue #87): whether the
 * run context already answers the raised question, or a human/manager
 * decision is required. Defaults to `escalate` whenever the decision is
 * unavailable or S1 picks an unrecognized option — never silently swallowed.
 */
export async function triageHandRaise(input: TriageInput, decideFn: DecideFn): Promise<TriageResult> {
  const question = cleanText(input?.question);
  const context = cleanText(input?.context);

  if (question === "" || context === "") {
    return {
      action: "escalate",
      reason: "raised question or run context is empty; escalating by default",
    };
  }

  const decision = await decideFn({
    state: { question, context },
    questions: {
      [Q_HAND_RAISE]: {
        type: "choice",
        instructions:
          "A worker handed a question up to the manager: should it be handled " +
          "from the run context, or handed to a human/manager decision? " +
          `Raised question: ${question}. Run context: ${context}.`,
        criteria: { ...HAND_RAISE_CRITERIA },
      },
    },
  });

  if (!decision.ok) {
    return { action: "escalate", reason: `S1 unavailable: ${decision.error}` };
  }
  const answer = decision.answers[Q_HAND_RAISE];
  if (!isRecord(answer) || answer.type !== "choice") {
    return { action: "escalate", reason: "S1 choice answer missing or malformed; escalating" };
  }
  // The selection rides the `choice` field of the pass-through choice answer.
  const raw = typeof answer.choice === "string" ? answer.choice.trim() : "";
  if (raw !== "answer" && raw !== "escalate") {
    return {
      action: "escalate",
      reason: `S1 returned no recognized option (got ${JSON.stringify(raw)}); escalating`,
    };
  }
  const detail = typeof answer.reason === "string" ? answer.reason.trim() : "";
  return {
    action: raw,
    reason: detail === "" ? `S1 chose "${raw}"` : `S1 chose "${raw}": ${detail}`,
  };
}

// ---------------------------------------------------------------------------
// 3. routeEngine — ONE score question over the candidate engines
// ---------------------------------------------------------------------------

export type RouteEngineInput = {
  /** The task spec the engine must run. */
  spec: string;
  /** Candidate engine names (e.g. codex/claude/gemini), criteria order. */
  candidates: string[];
};

export type RouteEngineResult = {
  engine: string | null;
  reason?: string;
};

/**
 * Ask S1 exactly one score question whose criteria are the candidate
 * engines, then return the top-scoring candidate (ties break deterministically
 * to the first candidate in criteria order). Returns `engine: null` when the
 * decision is unavailable or the scores don't line up with the candidates.
 */
export async function routeEngine(input: RouteEngineInput, decideFn: DecideFn): Promise<RouteEngineResult> {
  const spec = cleanText(input?.spec);
  const candidates = dedupeKeepFirst(cleanStrings(input?.candidates));

  if (spec === "") return { engine: null, reason: "task spec is empty" };
  if (candidates.length === 0) return { engine: null, reason: "no candidate engines supplied" };

  const decision = await decideFn({
    state: { spec, candidates },
    questions: {
      [Q_ENGINE]: {
        type: "score",
        instructions:
          "Score each candidate engine for fit against this task spec; the " +
          "top-scoring candidate will be dispatched. " +
          `Spec: ${spec}. Candidates, in criteria order: ${candidates.join(", ")}.`,
        criteria: candidates.slice(),
      },
    },
  });

  if (!decision.ok) {
    return { engine: null, reason: `S1 unavailable: ${decision.error}` };
  }
  const answer = decision.answers[Q_ENGINE];
  if (!isRecord(answer) || answer.type !== "score") {
    return { engine: null, reason: "S1 score answer missing or malformed; no engine chosen" };
  }
  const probabilities = answer.probabilities;
  if (
    !Array.isArray(probabilities) ||
    probabilities.length !== candidates.length ||
    !probabilities.every(isFiniteNumber)
  ) {
    return {
      engine: null,
      reason: "S1 score answer does not line up with the candidate list; no engine chosen",
    };
  }
  let best = 0;
  for (let i = 1; i < probabilities.length; i++) {
    if (probabilities[i] > probabilities[best]) best = i;
  }
  return {
    engine: candidates[best],
    reason: `S1 ranked "${candidates[best]}" highest (probability ${probabilities[best]})`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep non-empty strings, trimmed, order preserved. */
function cleanStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => s.trim());
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function dedupeKeepFirst(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}