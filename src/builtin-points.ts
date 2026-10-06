/**
 * The first declared decision points (issue #131), SHADOW ONLY: each is a boolean on the registry
 * from #130, with a deterministic baseline S1 has to beat before it may leave shadow, a safe default,
 * a minimal redacted state, and an outcome link where the loop produces one.
 *
 *   handraise.triage   Can the worker's question be answered from the charter/decisions/spec?
 *                      baseline: keyword match against the record (today's behaviour is "always escalate").
 *                      safe default: escalate.
 *   failure.real-bug   Is this failing round a real defect in the work, not environment or flake?
 *                      baseline: deterministic environment signals. safe default: treat as a real bug.
 *   review.depth       Does this change need two blind reviews?
 *                      baseline: size and sensitive-surface tiers. safe default: more review.
 *
 * The issue sketches choice points (`none|one|two-blind...`, `environment|flaky|real-bug|flawed-spec`);
 * the registry is boolean-only so far, so each is asked as one boolean and the finer split is a follow-up.
 */

import { parsePoints, runPoint, linkOutcome, type DecisionPoint, type PointDecision } from "./decision-points.js";
import { buildShadowDecider, shadowFileSink, trackShadow, type DeciderLike } from "./s1-shadow.js";
import { quoteUntrusted } from "./untrusted.js";

const BAND = { lowBelow: 0.2, highAbove: 0.8 };
const cfg = (id: string, wording: string, safeDefault: string, uncertainAction: string) => ({ id, question: { wording, version: 1 }, ...BAND, uncertainAction, safeDefault, mode: "shadow" });

const parsed = parsePoints([
  cfg("handraise.triage", "Can the worker's question be answered from the project charter, decisions and task spec alone, without asking a human?", "escalate-to-caller", "escalate-to-caller"),
  cfg("failure.real-bug", "Is the failing check caused by a defect in the work done this round, as opposed to the environment, a flaky test or a flawed spec?", "treat-as-real-bug", "treat-as-real-bug"),
  cfg("review.depth", "Does this change need two independent blind reviews rather than one?", "more-review", "more-review"),
  // Issue #250: per-tick convergence verdict against the charter's success criteria.
  // The question asks about CONVERGENCE (a good thing), so high probabilityTrue = converged.
  // The static fallback is the mechanical verdict, so the loop is never blind when S1 is down.
  cfg("progress.rubric", "Is this mission on track to satisfy its charter's success criteria, judging from the specs completed, their verification results, and the remaining work?", "on-track", "drifting"),
  // Issue #304: is a task spec defined well enough for a worker to implement without making a
  // design decision the author has not made? High probabilityTrue = READY (safe to dispatch).
  // The safe default and uncertain action both push back with guidance, never silently dispatch:
  // a low/uncertain score means "ask the author for the detail", which is the point of the gate.
  cfg("readiness.dispatch", "Is this task spec defined well enough for a worker to implement without making a design decision the author has not made? It is ready when the goal states a concrete change, the deliverable is named, every design decision is made, acceptance is checkable, the verify gate tests that acceptance, and the scope is one task.", "needs-clarification", "needs-clarification"),
]);
if (!parsed.ok) throw new Error(`built-in decision points are invalid: ${parsed.error}`);
export const BUILTIN_POINTS: readonly DecisionPoint[] = parsed.points;
export const pointById = (id: string): DecisionPoint | undefined => BUILTIN_POINTS.find((p) => p.id === id);

// ---- deterministic baselines (pure) --------------------------------------------------------------

const STOP = new Set("the a an and or of to in on for is are be do does should we i you it this that with what which how can will not use using into from".split(" "));
const words = (t: string): string[] => (t.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/** True when at least two distinctive words of the question appear in the project record text. */
export function handraiseBaseline(question: string, recordText: string): boolean {
  const have = new Set(words(recordText));
  return new Set(words(question).filter((w) => have.has(w))).size >= 2;
}

const ENV = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|No space left on device|Temporary failure in name resolution|rate limit|503 Service Unavailable|command not found|permission denied \(publickey\)/i;

/** True (real bug) unless the failure text carries a known environment signal or the run timed out. */
export function failureBaseline(f: { error?: string; summary?: string; exitCode?: number; endedBy?: string }): boolean {
  if (f.endedBy === "wall-clock" || f.endedBy === "idle-watchdog" || f.exitCode === 124) return false;
  return !ENV.test(`${f.error ?? ""}\n${f.summary ?? ""}`);
}

/** True (needs two) when the change is large or touches a sensitive surface. */
export function reviewDepthBaseline(c: { filesChanged: number; touchesSensitive: boolean }): boolean {
  return c.touchesSensitive || c.filesChanged > 10;
}

/**
 * Issue #250: the deterministic convergence verdict, the baseline S1 must beat.
 * `converged` requires every spec done AND every provided charter success criterion marked passed;
 * `blocked` when a spec is escalated; `on-track` when specs remain and none is blocked;
 * `drifting` when specs are done but a success criterion is unchecked (the charter is not yet met).
 */
export type RubricVerdict = "on-track" | "drifting" | "blocked" | "converged";
export function rubricBaseline(s: { specsTotal: number; specsDone: number; escalated: number; criteriaTotal: number; criteriaPassed: number }): RubricVerdict {
  if (s.escalated > 0) return "blocked";
  const allSpecsDone = s.specsTotal > 0 && s.specsDone === s.specsTotal;
  if (!allSpecsDone) return "on-track";
  // every spec verified; the mission converges only if every charter criterion is checkably passed
  if (s.criteriaTotal > 0 && s.criteriaPassed === s.criteriaTotal) return "converged";
  return "drifting";
}

// ---- minimal, quoted state ----------------------------------------------------------------------

export const handraiseState = (question: string, recordText: string): { text: string } => ({ text: [quoteUntrusted("question", question, 800), "", "PROJECT RECORD (charter, decisions, spec):", quoteUntrusted("record", recordText, 3000)].join("\n") });
export const failureState = (f: { error?: string; summary?: string; verified?: boolean | null; exitCode?: number }): { text: string } => ({ text: [`exit code: ${f.exitCode ?? "unknown"}`, `verification gate: ${f.verified === true ? "passed" : f.verified === false ? "FAILED" : "not run"}`, f.error ? quoteUntrusted("error", f.error, 1200) : "", f.summary ? quoteUntrusted("summary", f.summary, 1200) : ""].filter(Boolean).join("\n") });

// ---- shadow runner ---------------------------------------------------------------------------------

export interface ShadowPointDeps {
  decider?: DeciderLike;
  sink?: (entry: object) => void | Promise<void>;
}

/** Fire-and-forget: ask S1 the point's question and log one record with the baseline. Never throws; nothing is acted on. */
export function shadowPoint(cfgS1: unknown, pointId: string, state: unknown, baseline: boolean, rootDir?: string, deps: ShadowPointDeps = {}): Promise<PointDecision | undefined> {
  return trackShadow((async () => {
    const point = pointById(pointId);
    if (!point) return undefined;
    const decider = buildShadowDecider(cfgS1, { ...(rootDir ? { rootDir } : {}), ...(deps.decider ? { decider: deps.decider } : {}), sink: () => Promise.resolve() });
    if (!decider) return undefined;
    return runPoint(point, {
      baseline,
      sink: deps.sink ?? shadowFileSink(rootDir),
      ask: async (p) => {
        const r = (await decider({ state, questions: { [p.id]: { type: "boolean", instructions: p.question.wording } } })) as { ok?: boolean; answers?: Record<string, { probabilityTrue?: unknown }>; error?: unknown } | undefined;
        if (!r || r.ok !== true) throw new Error(typeof r?.error === "string" ? r.error : "S1 unavailable");
        const v = r.answers?.[p.id]?.probabilityTrue;
        return typeof v === "number" ? v : undefined;
      },
    });
  })()) as Promise<PointDecision | undefined>;
}

export { linkOutcome };
export const shadowSinkFor = shadowFileSink;
