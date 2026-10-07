/**
 * The dispatch-readiness judge (issues #304, #308): an S1 model evaluates a spec or prompt against the rubric
 * (`READINESS_CRITERIA`), one boolean question per criterion in a single call, and the verdict plus guidance come from
 * ITS answers. The deterministic baseline (readiness.ts) is the FALLBACK when S1 is not configured, errors, times out or
 * answers nothing usable: the loop is never blind and never blocked by S1 being down (the S1 conservative posture).
 *
 * Calibration discipline: the judge is ADVISORY (it reports guidance, never refuses a dispatch) until its verdicts have a
 * calibration record; every judged dispatch logs the per-criterion probabilities next to the baseline's verdict so
 * `pointReport` can measure whether the model earns enforcement.
 *
 * The text under judgement is untrusted: it is redacted, bounded and quoted as data before it reaches the model.
 */

import { READINESS_CRITERIA, readinessOf, readinessOfPrompt, type Guidance, type RubricCriterion } from "./readiness.js";
import type { TaskSpec } from "./spec.js";
import { quoteUntrusted } from "./untrusted.js";

/** A decider shaped like S1's (`buildShadowDecider`): boolean questions in, probabilityTrue per question out. */
export type AskS1 = (input: { state: unknown; questions: Record<string, { type: "boolean"; instructions: string }> }) => Promise<unknown>;

export interface Judged {
  ready: boolean;
  guidance: Guidance[];
  /** Who produced the verdict: the S1 model, or the deterministic baseline because S1 could not answer. */
  source: "s1" | "baseline";
  /** Criteria the model could not call either way (between the fail and pass thresholds): no guidance is given for them. */
  uncertain: string[];
  /** Why the baseline answered instead of S1 (absent when S1 judged). */
  fallbackReason?: string;
  /** Per-criterion probability that the criterion IS satisfied, as S1 reported it. */
  probabilities?: Record<string, number>;
}

export interface JudgeOptions {
  /** Max wait for S1, ms (default 10s): a slow judge never stalls a dispatch. */
  timeoutMs?: number;
  /** A criterion fails when P(satisfied) is below this (default 0.35). */
  failBelow?: number;
  /** ... and passes at or above this (default 0.65); in between it is uncertain and silent. */
  passAtLeast?: number;
}

/** Criteria a bare prompt can be judged on: it carries no acceptance, verify or scope unless its author wrote them inline. */
const PROMPT_CRITERIA = new Set(["concrete-change", "deliverable-named", "decisions-made"]);

const instructionsFor = (c: RubricCriterion): string =>
  `You are judging whether work is ready to hand to a coding agent. Judge ONLY from the text given; do not assume anything it does not say. ` +
  `Criterion: ${c.what} Answer true only if the text clearly satisfies it; answer false if it clearly does not.`;

/** The text S1 sees: bounded, redacted, quoted as untrusted data. */
export function judgeState(input: { spec?: TaskSpec; prompt?: string }): { text: string } {
  const body = input.spec
    ? JSON.stringify({ goal: input.spec.goal, acceptance: input.spec.acceptance ?? [], verify: input.spec.verify ?? null, scope: input.spec.scope ?? null })
    : String(input.prompt ?? "");
  return { text: quoteUntrusted(input.spec ? "task-spec" : "task-prompt", body, 4000) };
}

const baselineOf = (input: { spec?: TaskSpec; prompt?: string }): { ready: boolean; guidance: Guidance[] } | undefined =>
  input.spec ? readinessOf(input.spec) : readinessOfPrompt(String(input.prompt ?? ""));

/**
 * Judge readiness. Returns undefined only for a trivial prompt (a probe is not judged, by either path).
 * Never throws.
 */
export async function judgeReadiness(input: { spec?: TaskSpec; prompt?: string }, ask: AskS1 | undefined, opts: JudgeOptions = {}): Promise<Judged | undefined> {
  const base = baselineOf(input);
  if (!base) return undefined; // trivial prompt
  const fallback = (why: string): Judged => ({ ...base, source: "baseline", uncertain: [], fallbackReason: why });
  if (!ask) return fallback("S1 is not configured");

  const failBelow = opts.failBelow ?? 0.35;
  const passAtLeast = opts.passAtLeast ?? 0.65;
  const criteria = READINESS_CRITERIA.filter((c) => input.spec || PROMPT_CRITERIA.has(c.id));
  const questions = Object.fromEntries(criteria.map((c) => [c.id, { type: "boolean" as const, instructions: instructionsFor(c) }]));

  let raw: unknown;
  try {
    raw = await Promise.race([
      ask({ state: judgeState(input), questions }),
      new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error("timed out")), opts.timeoutMs ?? 10_000); (t as { unref?: () => void }).unref?.(); }),
    ]);
  } catch (e) { return fallback(`S1 ${(e as Error).message}`.slice(0, 120)); }

  const r = raw as { ok?: boolean; answers?: Record<string, { probabilityTrue?: unknown }>; error?: unknown } | undefined;
  if (!r || r.ok !== true || !r.answers) return fallback(typeof r?.error === "string" ? `S1 error: ${r.error}`.slice(0, 120) : "S1 returned no answers");

  const probabilities: Record<string, number> = {};
  const guidance: Guidance[] = [];
  const uncertain: string[] = [];
  for (const c of criteria) {
    const p = r.answers[c.id]?.probabilityTrue;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) { uncertain.push(c.id); continue; } // an unusable answer is silence, never a fail
    probabilities[c.id] = p;
    if (p < failBelow) guidance.push({ criterion: c.id, what: c.what, fix: c.fix });
    else if (p < passAtLeast) uncertain.push(c.id);
  }
  // If the model said nothing usable at all, treat it as unavailable rather than as "ready".
  if (Object.keys(probabilities).length === 0) return fallback("S1 answers were unusable");
  return { ready: guidance.length === 0, guidance, source: "s1", uncertain, probabilities };
}
