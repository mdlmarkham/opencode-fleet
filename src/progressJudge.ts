/**
 * Issue #165: S1 PROGRESS JUDGE for fleet_iterate — shadow-first, fail-safe.
 *
 * fleet_iterate detects "no progress" today by STRING EQUALITY between
 * consecutive iteration fingerprints. This module adds an optional S1 judge
 * (driven by the EXISTING decider, decide() in decision.ts, default backend
 * local-kev) that answers a narrow stated-criteria boolean between iterations:
 *
 *   Given (a) the spec's acceptance criteria, (b) the previous attempt's
 *   failure output, and (c) this attempt's result + verify output, is this
 *   attempt strictly closer to the acceptance criteria than the last?
 *   -> probabilityTrue
 *
 * Contract (all enforced here and by the caller):
 *   - Escalate when S1 judges progress unlikely (probabilityTrue strictly
 *     below the threshold, default 0.5) across TWO consecutive transitions —
 *     IN ADDITION to the existing string-equality check.
 *   - SHADOW-FIRST / fail-safe: any S1 failure, timeout, or absent decision
 *     leaves the existing string-diff behaviour in force. S1 is additive
 *     evidence, never permission: an absent decision falls back to the
 *     deterministic string-diff result and never throws.
 *   - When judgeProgress is absent/false the decider is never invoked; the
 *     caller keeps byte-identical behaviour (no decide(), no extra fields on
 *     the launch/return paths).
 *   - The deterministic baseline (identical consecutive strings) always wins
 *     over an optimistic S1 estimate.
 *
 * Pure except the optional decide transport, which the caller injects; tests
 * pass a fake and never touch the network.
 */

export const DEFAULT_PROGRESS_THRESHOLD = 0.5;

/** The narrow stated-criteria boolean question S1 is asked once per transition. */
export type ProgressQuestion = { type: "boolean"; instructions: string };

export type ProgressJudgeInput = {
  /** (a) the spec's acceptance criteria. */
  acceptanceCriteria: string;
  /** (b) the previous attempt's failure output. */
  prevFailureOutput: string;
  /** (c) this attempt's result. */
  thisResult: string;
  /** (c) this attempt's verification output. */
  verifyOutput: string;
};

/**
 * Decider transport. Receives the built progress question (so callers can
 * adapt the EXISTING decide() from src/decision.ts, default backend
 * local-kev, to answer it). Present ONLY when judgeProgress is on; a thrown
 * or malformed outcome counts as an absent decision (shadow fallback).
 */
export type DecideTransport = (
  question: ProgressQuestion,
) =>
  | { probabilityTrue: number }
  | { error: string }
  | undefined
  | null;

/**
 * One per-transition progress sample, in order. Either carries a resolved S1
 * estimate ({ probabilityTrue }), an S1 failure ({ error } / { judgeError }),
 * or is a bare descriptor ({ prevOutput, nextOutput }) that the decide
 * transport fills; with the judge unwired a descriptor stays unresolved and
 * counts as an absent decision (shadow fallback).
 */
export type ProgressSample =
  | {
      probabilityTrue?: number;
      error?: string;
      judgeError?: string;
      prevOutput?: string;
      nextOutput?: string;
    }
  | undefined;

export type ProgressVerdict = {
  /** Stop iterating and report — escalate to heavier model / human. */
  escalate: boolean;
  /** Human-readable reason, citing the S1 estimate AND deterministic signals. */
  reason: string;
  recommendation?: string;
  /** Usable per-transition S1 estimates, in order. */
  s1Estimates?: number[];
  /** True when an S1 failure/timeout/absent decision made the string-diff result govern. */
  fallback?: boolean;
  /** True iff the S1 judge actually contributed evidence. */
  judgeUsed: boolean;
};

/**
 * Build the S1 boolean question for one iteration transition. Narrow and
 * stated-criteria: all three inputs are quoted into the instructions so the
 * decision is auditable from the verdict alone.
 */
export function buildProgressQuestion(input: ProgressJudgeInput): ProgressQuestion {
  return {
    type: "boolean",
    instructions: [
      "Progress judge (issue #165). You are given:",
      "(a) the task spec's acceptance criteria:",
      input.acceptanceCriteria,
      "(b) the previous attempt's failure output:",
      input.prevFailureOutput,
      "(c) this attempt's result plus its verification output:",
      input.thisResult,
      input.verifyOutput,
      "Question: is this attempt strictly closer to the acceptance criteria than the last attempt?",
      "Answer as a boolean; probabilityTrue should reflect your confidence.",
    ].join("\n"),
  };
}

function isEstimate(s: ProgressSample): s is { probabilityTrue: number } {
  return s !== undefined && typeof s.probabilityTrue === "number";
}

function failureNote(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) if (typeof c === "string" && c !== "") return c;
  return undefined;
}

/**
 * Pure escalate-vs-continue decision over the per-transition progress samples.
 *
 * Rules, in order:
 *   1. Identical consecutive strings (the deterministic baseline) escalate —
 *      even if S1 says progress.
 *   2. Two consecutive usable S1 estimates strictly below the threshold
 *      escalate (strictly-below: an estimate exactly AT the threshold does not
 *      count).
 *   3. Otherwise continue. Failed/absent S1 decisions never escalate on their
 *      own; they set `fallback` and govern via the string-diff result.
 */
export function evaluateProgress(args: {
  iterations: ProgressSample[];
  identicalConsecutive?: boolean;
  threshold?: number;
  /** Present ONLY when judgeProgress is on; absent => the decider is never invoked. */
  decide?: DecideTransport;
}): ProgressVerdict {
  const threshold = args.threshold ?? DEFAULT_PROGRESS_THRESHOLD;

  // Fill unresolved descriptor slots by invoking the decider once per
  // transition. Any failure, malformed reply, or throw becomes an absent
  // decision (shadow fallback) — never a throw to the caller.
  const samples: ProgressSample[] = [];
  let invoked = 0;
  for (const provided of args.iterations) {
    if (
      provided !== undefined &&
      (typeof provided.probabilityTrue === "number" ||
        typeof provided.error === "string" ||
        typeof provided.judgeError === "string")
    ) {
      // Already-resolved sample (live judge result or test fixture).
      samples.push(provided);
      continue;
    }
    if (!args.decide) {
      // Judge unwired (judgeProgress off/absent): nothing is invoked — the
      // slot stays an absent decision and only the string-diff can escalate.
      samples.push(undefined);
      continue;
    }
    invoked++;
    try {
      const q = buildProgressQuestion({
        acceptanceCriteria: "(spec acceptance criteria)",
        prevFailureOutput: "(previous attempt output)",
        thisResult: "(this attempt result)",
        verifyOutput: "(verify output)",
      });
      const d = args.decide(q);
      if (d !== undefined && d !== null && typeof d === "object" && "probabilityTrue" in d && typeof d.probabilityTrue === "number") {
        samples.push({ probabilityTrue: d.probabilityTrue });
      } else if (d !== undefined && d !== null && typeof d === "object" && "error" in d && typeof d.error === "string") {
        samples.push({ judgeError: d.error });
      } else {
        samples.push({ judgeError: "S1: absent decision" });
      }
    } catch (e) {
      samples.push({ judgeError: `S1 judge threw: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const estimates = samples.filter(isEstimate).map((s) => s.probabilityTrue);
  const hadFailure = samples.some(
    (s) => s === undefined || failureNote(s.error, s.judgeError) !== undefined,
  );
  const judgeUsed = invoked > 0 || estimates.length > 0;

  // 1. Deterministic baseline: identical consecutive strings always escalate.
  if (args.identicalConsecutive === true) {
    return {
      escalate: true,
      reason:
        `no progress across iterations (identical output)` +
        (estimates.length ? `; S1 progress estimates: ${estimates.join(", ")}` : ""),
      recommendation:
        "Escalate: switch to a heavier model, change the approach, or hand off to a human. Do not keep retrying the same prompt.",
      s1Estimates: estimates.length ? estimates : undefined,
      fallback: hadFailure || samples.length === 0 ? true : undefined,
      judgeUsed,
    };
  }

  // 2. S1 escalation: TWO consecutive strictly-below-threshold estimates.
  let twoConsecutiveBelow = false;
  for (let i = 1; i < samples.length; i++) {
    if (isEstimate(samples[i - 1]) && isEstimate(samples[i]) &&
        samples[i - 1]!.probabilityTrue! < threshold && samples[i]!.probabilityTrue! < threshold) {
      twoConsecutiveBelow = true;
      break;
    }
  }

  if (twoConsecutiveBelow) {
    // Cite the S1 estimate AND the deterministic signals.
    const pair = samples.slice(-2);
    return {
      escalate: true,
      reason:
        `S1 progress judge: progress unlikely across 2 consecutive iterations ` +
        `(estimates ${pair.map((s) => (isEstimate(s) ? String(s.probabilityTrue) : "absent")).join(" then ")} ` +
        `strictly below threshold ${threshold}). Deterministic signals: the identical-output check did not fire — ` +
        `output differed between iterations ("no identical output").`,
      recommendation:
        "Escalate: S1 judges this attempt not strictly closer to the acceptance criteria for two consecutive iterations. " +
        "Switch to a heavier model, change the approach, or hand off to a human.",
      s1Estimates: estimates.length ? estimates : undefined,
      judgeUsed,
    };
  }

  // 3. Continue. A failed/absent S1 decision falls back to the string-diff
  //    result — which found output changes here — and never throws.
  if (hadFailure) {
    const notes = samples
      .map((s) => (s === undefined ? "absent" : failureNote(s.error, s.judgeError) ?? String(s.probabilityTrue)))
      .join("; ");
    return {
      escalate: false,
      reason: `S1 progress judge unavailable or failed (${notes}); falling back to the deterministic string-diff check, which found output changes (no identical output)`,
      fallback: true,
      s1Estimates: estimates.length ? estimates : undefined,
      judgeUsed,
    };
  }

  return {
    escalate: false,
    reason: estimates.length
      ? `S1 progress judge: continue (latest estimate ${String(estimates[estimates.length - 1])} at or above threshold ${threshold})`
      : "progress detected (output changed between iterations)",
    s1Estimates: estimates.length ? estimates : undefined,
    judgeUsed,
  };
}