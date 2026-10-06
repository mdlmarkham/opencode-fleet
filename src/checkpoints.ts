/**
 * Checkpoint framework and independence policy (issue #126): the rules that decide whether a stage of a
 * mission may advance, as pure, deterministic data and functions. Independence is ENFORCED here, not
 * assumed: a review that violates the policy is rejected and does not count.
 *
 *  - Checkpoints (C1 plan, C2 spec, C3 integration, C4 pre-delivery, mid-run audit) are declared with who
 *    must review and whether they block.
 *  - `verifyIndependence`: same family as the author, a shared session or clone, an author summary seen on
 *    a blind pass, or a review of a different commit are all violations.
 *  - `parseFindings`: a finding counts only if it reproduces (a failing test in the reviewer's own clone)
 *    or cites a file and line; malformed findings are rejected whole, never repaired.
 *  - `resolveCheckpoint`: the verdict logic, fail-closed. A stage cannot advance without a satisfied
 *    checkpoint; a reviewer that timed out, was unavailable or sent malformed output leaves it
 *    UNSATISFIED and escalates; it never counts as a pass.
 *
 * No model calls. The review sessions themselves are started elsewhere (fleet_review prepare/collect).
 */

import { createHash } from "node:crypto";

export const CHECKPOINTS = ["C1", "C2", "C3", "C4", "audit"] as const;
export type CheckpointId = (typeof CHECKPOINTS)[number];
export type Depth = "none" | "one" | "two-blind" | "two-blind+human";

export interface CheckpointDef {
  id: CheckpointId;
  reviews: string;
  /** blocking: a confirmed finding stops the stage. advisory: findings are recorded, never block. */
  mode: "blocking" | "advisory";
}

export const CHECKPOINT_DEFS: Readonly<Record<CheckpointId, CheckpointDef>> = {
  C1: { id: "C1", reviews: "the plan and design before any spec runs", mode: "blocking" },
  C2: { id: "C2", reviews: "each spec's result against its acceptance and verify gate", mode: "blocking" },
  C3: { id: "C3", reviews: "the integrated branch: interactions between specs", mode: "blocking" },
  C4: { id: "C4", reviews: "the whole change before delivery", mode: "blocking" },
  audit: { id: "audit", reviews: "a mid-run sample of what workers actually did", mode: "advisory" },
};

export interface RiskFacts { filesChanged: number; linesChanged: number; touchesRuleSurface: boolean; touchesSensitive: boolean; trivial?: boolean }

/** Risk tier decides review depth. Deterministic baseline; S1 routing (#121) may later be additive evidence only. */
export function depthFor(f: RiskFacts): Depth {
  if (f.touchesSensitive) return "two-blind+human";
  if (f.touchesRuleSurface || f.filesChanged > 10 || f.linesChanged > 400) return "two-blind";
  if (f.trivial && f.filesChanged <= 2 && f.linesChanged <= 20) return "none";
  return "one";
}

export interface Policy {
  differentFamilyFromAuthor: boolean;
  /** Reviewers required at this depth are derived from `depth`; this is a floor an operator may raise. */
  minReviewers: number;
  rotation: boolean;
}
export const DEFAULT_POLICY: Policy = { differentFamilyFromAuthor: true, minReviewers: 1, rotation: false };

export interface Party {
  kind: "agent" | "human";
  /** Model family (e.g. "claude", "gpt", "kimi"); required for an agent. */
  family?: string;
  engine?: string;
  model?: string;
  node?: string;
  sessionId?: string;
  /** The clone directory the party worked or reviewed in. */
  cloneDir?: string;
}
export interface ReviewSession extends Party {
  reviewerId: string;
  /** The commit this reviewer checked out and re-ran. */
  commit: string;
  /** True if the reviewer was shown the author's transcript, summary or self-assessment. */
  sawAuthorContext: boolean;
  /** First (blind) pass vs an optional second pass that may check the author's rationale. */
  pass: "blind" | "rationale";
}

export interface Violation { reviewerId: string; rule: string; detail: string }

export function verifyIndependence(author: Party, review: ReviewSession, commit: string, policy: Policy = DEFAULT_POLICY, others: ReviewSession[] = []): Violation[] {
  const v: Violation[] = [];
  const add = (rule: string, detail: string): void => void v.push({ reviewerId: review.reviewerId, rule, detail });
  if (review.commit !== commit) add("wrong-commit", `reviewed ${review.commit.slice(0, 12)}, checkpoint is at ${commit.slice(0, 12)}`);
  if (review.kind === "agent") {
    if (!review.family) add("unknown-family", "an agent reviewer must declare its model family");
    else if (policy.differentFamilyFromAuthor && author.kind === "agent" && author.family && review.family.toLowerCase() === author.family.toLowerCase()) add("same-family", `reviewer and author are both ${review.family}`);
    if (!review.cloneDir) add("no-clean-clone", "an agent reviewer must work in its own clean clone at the commit");
  }
  if (review.sessionId && review.sessionId === author.sessionId) add("shared-session", "the reviewer ran in the author's session");
  if (review.cloneDir && review.cloneDir === author.cloneDir) add("shared-clone", "the reviewer used the author's clone");
  if (review.pass === "blind" && review.sawAuthorContext) add("context-leak", "a blind first pass saw the author's transcript or self-assessment");
  for (const o of others) {
    if (o.reviewerId === review.reviewerId) continue;
    if (o.sessionId && o.sessionId === review.sessionId) add("shared-session", `shares a session with ${o.reviewerId}`);
    if (o.cloneDir && o.cloneDir === review.cloneDir) add("shared-clone", `shares a clone with ${o.reviewerId}`);
  }
  return v;
}

// ---- findings: evidence or nothing --------------------------------------------------------------------

export interface Finding {
  severity: "blocking" | "major" | "minor";
  summary: string;
  /** A reproducing failing test written in the reviewer's own clone. */
  reproduction?: { testPath: string; failsAtCommit: string; output: string };
  /** Or a cited location. */
  cite?: { file: string; line: number };
}
export type ParsedFindings = { ok: true; findings: Finding[] } | { ok: false; error: string };

const SHA = /^[0-9a-f]{40}$/;

/** Strict: a malformed finding rejects the whole set. A finding with neither reproduction nor cite is rejected. */
export function parseFindings(raw: unknown): ParsedFindings {
  if (!Array.isArray(raw) || raw.length > 50) return { ok: false, error: "findings must be an array of at most 50" };
  const out: Finding[] = [];
  for (const [i, f] of raw.entries()) {
    const o = f as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null) return { ok: false, error: `findings[${i}] is not an object` };
    for (const k of Object.keys(o)) if (!["severity", "summary", "reproduction", "cite"].includes(k)) return { ok: false, error: `findings[${i}]: unknown key "${k}"` };
    if (!["blocking", "major", "minor"].includes(String(o.severity))) return { ok: false, error: `findings[${i}].severity must be blocking|major|minor` };
    if (typeof o.summary !== "string" || o.summary.trim() === "" || o.summary.length > 500) return { ok: false, error: `findings[${i}].summary must be 1-500 characters` };
    const rep = o.reproduction as Record<string, unknown> | undefined;
    const cite = o.cite as Record<string, unknown> | undefined;
    if (rep === undefined && cite === undefined) return { ok: false, error: `findings[${i}] has no evidence: give a reproduction or a cite (file and line)` };
    if (rep !== undefined && (typeof rep.testPath !== "string" || typeof rep.output !== "string" || rep.output.trim() === "" || !SHA.test(String(rep.failsAtCommit)))) return { ok: false, error: `findings[${i}].reproduction needs testPath, output and a 40-hex failsAtCommit` };
    if (cite !== undefined && (typeof cite.file !== "string" || !Number.isInteger(cite.line) || (cite.line as number) < 1)) return { ok: false, error: `findings[${i}].cite needs file and a line >= 1` };
    out.push({ severity: o.severity as Finding["severity"], summary: o.summary.trim(), ...(rep ? { reproduction: { testPath: rep.testPath as string, failsAtCommit: rep.failsAtCommit as string, output: (rep.output as string).slice(-1500) } } : {}), ...(cite ? { cite: { file: cite.file as string, line: cite.line as number } } : {}) });
  }
  return { ok: true, findings: out };
}

/** A finding "confirms" (blocks) only with a reproduction at the checkpoint's commit; a bare cite is advisory. */
export const confirms = (f: Finding, commit: string): boolean => f.severity !== "minor" && f.reproduction?.failsAtCommit === commit;

// ---- verdict resolution ---------------------------------------------------------------------------------

export type ReviewOutcome =
  | { status: "reviewed"; session: ReviewSession; findings: Finding[] }
  | { status: "failed"; reviewerId: string; reason: "timeout" | "unavailable" | "malformed" };

export interface Contest { reviewerId: string; findingSummary: string; /** The author's counter-evidence: required, or the contest is ignored. */ evidence: string; decidedBy?: { kind: "agent" | "human"; verdict: "upheld" | "dismissed" } }

export type State = "satisfied" | "blocked" | "unsatisfied" | "needs-third-reviewer" | "escalate";
export interface Resolution { state: State; reasons: string[]; advisory: Finding[]; rejected: Violation[]; canAdvance: boolean }

const requiredReviewers = (d: Depth, floor: number): number => Math.max(floor, d === "none" ? 0 : d === "one" ? 1 : 2);

export function resolveCheckpoint(args: { checkpoint: CheckpointId; commit: string; depth: Depth; author: Party; policy?: Policy; outcomes: ReviewOutcome[]; contests?: Contest[]; humanVerdict?: "pass" | "fail" }): Resolution {
  const policy = args.policy ?? DEFAULT_POLICY;
  const def = CHECKPOINT_DEFS[args.checkpoint];
  const reasons: string[] = [];
  const rejected: Violation[] = [];
  const advisory: Finding[] = [];
  if (args.depth === "none") return { state: "satisfied", reasons: ["trivial change: no review required by its tier"], advisory, rejected, canAdvance: true };

  const reviewed = args.outcomes.filter((o): o is Extract<ReviewOutcome, { status: "reviewed" }> => o.status === "reviewed");
  const failed = args.outcomes.filter((o): o is Extract<ReviewOutcome, { status: "failed" }> => o.status === "failed");
  const counted = reviewed.filter((o) => {
    const vs = verifyIndependence(args.author, o.session, args.commit, policy, reviewed.map((x) => x.session));
    rejected.push(...vs);
    return vs.length === 0;
  });
  for (const f of failed) reasons.push(`reviewer ${f.reviewerId} ${f.reason}: the checkpoint stays unsatisfied (fail closed)`);

  // Confirmed findings (reproducing, at this commit), minus those the author contested WITH evidence and a deciding party dismissed.
  const contests = (args.contests ?? []).filter((c) => c.evidence.trim() !== "");
  const confirmed: Array<{ reviewerId: string; f: Finding }> = [];
  for (const o of counted) for (const f of o.findings) {
    if (confirms(f, args.commit)) confirmed.push({ reviewerId: o.session.reviewerId, f });
    else advisory.push(f);
  }
  const open = confirmed.filter(({ reviewerId, f }) => {
    const c = contests.find((x) => x.reviewerId === reviewerId && x.findingSummary === f.summary);
    return !c || c.decidedBy?.verdict !== "dismissed";
  });
  const undecided = confirmed.filter(({ reviewerId, f }) => contests.some((x) => x.reviewerId === reviewerId && x.findingSummary === f.summary && !x.decidedBy));

  if (undecided.length) return { state: "needs-third-reviewer", reasons: [...reasons, `${undecided.length} finding(s) contested by the author with evidence: a third session or a human decides`], advisory, rejected, canAdvance: false };
  if (def.mode === "advisory") return { state: "satisfied", reasons: [...reasons, "advisory checkpoint: findings are recorded, never block"], advisory: [...advisory, ...confirmed.map((c) => c.f)], rejected, canAdvance: true };
  if (args.humanVerdict === "fail") return { state: "blocked", reasons: [...reasons, "a human reviewer failed this checkpoint"], advisory, rejected, canAdvance: false };

  // Reviewer disagreement: some counted reviewers confirm a defect and others (blind, independent) found none.
  const withConfirm = new Set(open.map((c) => c.reviewerId));
  if (withConfirm.size > 0 && withConfirm.size < counted.length) return { state: "escalate", reasons: [...reasons, `reviewers disagree (${[...withConfirm].join(", ")} found a reproducing defect; ${counted.length - withConfirm.size} did not): escalate`], advisory, rejected, canAdvance: false };
  if (open.length) return { state: "blocked", reasons: [...reasons, ...open.map((c) => `confirmed by ${c.reviewerId}: ${c.f.summary}`)], advisory, rejected, canAdvance: false };

  const need = requiredReviewers(args.depth, policy.minReviewers);
  if (failed.length || counted.length < need) {
    if (rejected.length) reasons.push(`${rejected.length} review(s) rejected for independence violations and do not count`);
    reasons.push(`${counted.length} of ${need} required independent review(s) in hand`);
    return { state: failed.length ? "escalate" : "unsatisfied", reasons, advisory, rejected, canAdvance: false };
  }
  if (args.depth === "two-blind+human" && args.humanVerdict !== "pass") return { state: "unsatisfied", reasons: [...reasons, "this tier needs a human verdict"], advisory, rejected, canAdvance: false };
  return { state: "satisfied", reasons: [...reasons, `${counted.length} independent review(s), none confirmed a defect`], advisory, rejected, canAdvance: true };
}

/** A stage cannot advance without a satisfied checkpoint, whatever else is true. */
export const stageMayAdvance = (r: Resolution | undefined): boolean => r?.canAdvance === true && r.state === "satisfied";

/** Cache key for reviewing the same commit with the same role version at the same depth. */
export const reviewCacheKey = (commit: string, roleVersion: string, depth: Depth): string => createHash("sha256").update(`${commit}\0${roleVersion}\0${depth}`).digest("hex").slice(0, 24);
