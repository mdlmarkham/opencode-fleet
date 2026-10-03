/**
 * Manager-side S1 wiring into live dispatch — issue #87, slice 3.
 *
 * Two OPT-IN integrations between the #87 decision hooks (s1-hooks.ts) and
 * the `fleet_dispatch` tool (index.ts). Both default OFF and both fail-safe:
 * every fallback keeps the caller's dispatch exactly as it would have run
 * without this module. With neither flag set, no S1 call is made and no
 * field is added anywhere — the dispatch result is byte-identical to today.
 *
 *   - `s1RouteHarness`: with `route: { candidates: string[] }`, the
 *     routeEngine hook ranks the candidates for the task text; a pick that
 *     is a valid worker harness (opencode|pi) REPLACES the dispatch `harness`.
 *     S1 unavailable / null pick / pick that is not a valid harness => the
 *     caller's `harness` stands (today's behaviour).
 *   - `s1TriageIfRequested`: with `autoTriage: true`, a run that hand-raises
 *     a question ALSO gets a triageHandRaise RECOMMENDATION surfaced on the
 *     per-node result (`s1: { triage: { action, reason } }`). Advisory only:
 *     the run itself is never answered or changed, and every unavailable/
 *     malformed decision falls back to `action: "escalate"`.
 *
 * The S1 client is injectable exactly like s1-hooks (DecideFn); the default
 * is decision.ts `decide` (the real gateway-side client, FLEET_S1_URL). The
 * helpers are called only when the caller opted in, so the default dispatch
 * path never constructs or contacts S1.
 */

import { decide } from "./decision.js";
import {
  routeEngine,
  triageHandRaise,
  type DecideFn,
  type RouteEngineResult,
  type TriageResult,
} from "./s1-hooks.js";

export type { DecideFn } from "./s1-hooks.js";

// ---------------------------------------------------------------------------
// Opt-in `route`: S1 picks the dispatch harness from a candidate list
// ---------------------------------------------------------------------------

/** Shape of the opt-in `route` dispatch parameter. */
export type S1RouteOpt = { candidates: string[] };

export type S1RouteParamResult =
  | { ok: true; route?: S1RouteOpt }
  | { ok: false; error: string };

/**
 * Parse/validate the opt-in `route` dispatch parameter. Absent (or null) =>
 * routing is OFF. Present => must be `{ candidates: string[] }` with a
 * non-empty array of non-blank names — fail-closed like the other dispatch
 * params (a malformed route is refused, never silently corrected). The
 * candidate list rides to S1 verbatim; order is the routeEngine criteria
 * order AND the tie-break order.
 */
export function parseRouteOptIn(value: unknown): S1RouteParamResult {
  if (value === undefined || value === null) return { ok: true, route: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "route must be an object {candidates: string[]}" };
  }
  const raw = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "route.candidates must be a non-empty array of engine names" };
  }
  if (!raw.every((c) => typeof c === "string" && c.trim().length > 0)) {
    return { ok: false, error: "route.candidates must be an array of non-empty strings" };
  }
  return { ok: true, route: { candidates: (raw as string[]).map((c) => c.trim()) } };
}

/** The dispatch harnesses a routed pick may replace the caller's value with. */
const HARNESSES: ReadonlySet<string> = new Set(["opencode", "pi"]);

export type S1RouteHarnessInput = {
  /** Caller-supplied dispatch harness (may be absent). The fallback value. */
  harness?: "opencode" | "pi";
  /** The opt-in `route` param (undefined = routing off). */
  route?: S1RouteOpt;
  /** The task text handed to the engine (rendered spec or flat prompt). */
  specText: string;
};

/** Why S1 picked (or why the dispatch kept the caller's harness). */
export type S1RouteDecision = {
  /** The engine S1 ranked first; null on unavailability or no decision. */
  engine: string | null;
  reason?: string;
  /** True only when the pick was a valid harness AND replaced the caller's value. */
  applied: boolean;
};

export type S1RouteHarnessResult = {
  /** The effective dispatch harness (the caller's value unless a valid pick replaced it). */
  harness?: "opencode" | "pi";
  /** True only when routing actually changed the harness. */
  changed: boolean;
  /** Present ONLY when `route` was requested (opt-in observability). */
  decision?: S1RouteDecision;
};

/**
 * Resolve the dispatch harness for an S1 `route` (issue #87, slice 3).
 *
 * Default path (no `route`): returns the caller's harness and NEVER touches
 * the injected S1 client — the dispatch is byte-identical to routing being
 * absent. Opted in: asks routeEngine to rank `route.candidates` for
 * `specText`; the pick REPLACES the dispatch harness only when it is a valid
 * worker harness (opencode|pi). Every other outcome — S1 unavailable (the
 * client fails or throws), an empty task text, no candidates, or a pick that
 * is not a valid harness — keeps the caller's `harness` unchanged (today's
 * behaviour) and reports why in `decision`.
 */
export async function s1RouteHarness(
  input: S1RouteHarnessInput,
  decideFn: DecideFn = decide,
): Promise<S1RouteHarnessResult> {
  const harness = input?.harness === "opencode" || input?.harness === "pi" ? input.harness : undefined;
  // Default path: no opt-in => NOTHING runs here, not even a client call.
  if (input?.route === undefined) return { harness, changed: false };

  const decision: RouteEngineResult = await routeEngine(
    { spec: typeof input.specText === "string" ? input.specText : "", candidates: input.route.candidates },
    decideFn,
  );
  const pick = decision.engine;
  if (typeof pick === "string" && HARNESSES.has(pick)) {
    return {
      harness: pick as "opencode" | "pi",
      changed: true,
      decision: { engine: pick, reason: decision.reason, applied: true },
    };
  }
  return {
    harness,
    changed: false,
    decision: { engine: pick, reason: decision.reason, applied: false },
  };
}

// ---------------------------------------------------------------------------
// Opt-in `autoTriage`: a RECOMMENDATION on a hand-raise — never an auto-answer
// ---------------------------------------------------------------------------

export type S1TriageRecommendation = TriageResult;

export type S1TriageIfRequestedInput = {
  /** The dispatch's `autoTriage` opt-in (default OFF). */
  autoTriage?: boolean;
  /** The hand-raised question (absent/empty = nothing to triage). */
  question?: string;
  /** The run context that might already answer the question. */
  context?: string;
};

/**
 * Opt-in S1 triage of a run's hand-raise (issue #87, slice 3).
 *
 * Returns NOTHING (undefined) when `autoTriage` is off or the run did not
 * hand-raise a non-empty question — no S1 call, no result field, default
 * dispatch unchanged. When opted in, returns the triageHandRaise
 * RECOMMENDATION for the manager to read (`answer` from run context vs
 * `escalate`); it is advisory: the run itself is never answered or changed,
 * and every unavailable/malformed decision falls back to `escalate`.
 */
export async function s1TriageIfRequested(
  input: S1TriageIfRequestedInput,
  decideFn: DecideFn = decide,
): Promise<S1TriageRecommendation | undefined> {
  if (input?.autoTriage !== true) return undefined;
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question === "") return undefined;
  const context = typeof input.context === "string" ? input.context : "";
  return triageHandRaise({ question, context }, decideFn);
}

/** Max characters a single composed context part contributes (bounds the S1 request). */
const CONTEXT_PART_CAP = 2000;

/**
 * Compose the run context handed to triageHandRaise from a run result's own
 * output — what the worker said (summary), what the verify gate recorded
 * (verifyDetails), and the post-run working-tree state. String parts ride
 * trimmed, objects are JSON-encoded; every part is capped and empty parts
 * are dropped.
 */
export function triageContextFromRun(parts: {
  summary?: unknown;
  verifyDetails?: unknown;
  treeState?: unknown;
}): string {
  const cap = (text: string): string =>
    text.length > CONTEXT_PART_CAP ? `${text.slice(0, CONTEXT_PART_CAP)}…` : text;
  const toPart = (label: string, v: unknown): string | undefined => {
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" ? undefined : `${label}: ${cap(t)}`;
    }
    if (v === undefined || v === null) return undefined;
    let encoded: string;
    try {
      encoded = JSON.stringify(v) ?? "";
    } catch {
      return undefined;
    }
    if (encoded === "") return undefined;
    return `${label}: ${cap(encoded)}`;
  };
  return (
    [
      toPart("worker summary", parts.summary),
      toPart("verify details", parts.verifyDetails),
      toPart("working tree", parts.treeState),
    ]
      .filter((s): s is string => s !== undefined)
      .join("\n")
  );
}