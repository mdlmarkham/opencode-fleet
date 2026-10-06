/**
 * Autonomy contract for unattended missions (issue #124): what may run unattended, the hard stops that
 * halt a mission with evidence, how mid-run questions are batched or defaulted instead of interrupting,
 * and the kill switch. Policy as data, deterministic, no model calls.
 *
 *  - The OPERATOR defines the contract; a repo may only TIGHTEN it (lower level, fewer allowed actions,
 *    more forbidden ones, lower limits, more hard stops).
 *  - L3 (fully unattended) is refused unless the sandbox, budgets and reviewer calibration are reported
 *    present: the contract cannot talk its way past a missing safeguard.
 *  - A hard-stop hit halts the mission and produces an escalation citing its evidence.
 *  - A question that cannot block progress becomes a journaled assumption and independent specs
 *    continue; one that can parks only its dependents. Nothing here interrupts a human.
 */

import { appendJournal, setPhase, updateMission, loadMission, type MissionRecord, type Saved } from "./mission-store.js";

export const LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type Level = (typeof LEVELS)[number];
export const HARD_STOPS = ["budget-exhausted", "repeat-gate-failure", "scope-violation", "security-rule", "checkpoint-blocked", "plan-ambiguity", "plan-stale", "reviewer-disagreement", "wall-time"] as const;
export type HardStop = (typeof HARD_STOPS)[number];
export const ACTIONS = ["clone-work", "fleet-branches", "open-pr", "protected-branch-publish", "credential-use", "network-egress"] as const;
export type Action = (typeof ACTIONS)[number];

export interface Limits { wallMs: number; costUsd: number; tokens: number; maxRetries: number; maxReplans: number; maxConcurrent: number; sameSpecGateFailures: number }
export interface Contract { level: Level; allowed: Action[]; forbidden: Action[]; limits: Limits; hardStops: HardStop[] }

/** The most conservative contract: nothing unattended. */
export const L0_CONTRACT: Contract = { level: "L0", allowed: [], forbidden: [...ACTIONS], limits: { wallMs: 0, costUsd: 0, tokens: 0, maxRetries: 0, maxReplans: 0, maxConcurrent: 1, sameSpecGateFailures: 1 }, hardStops: [...HARD_STOPS] };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export type Parsed = { ok: true; contract: Contract } | { ok: false; error: string };

export function parseContract(raw: unknown): Parsed {
  if (!isRec(raw)) return { ok: false, error: "contract must be an object" };
  const allowedKeys = new Set(["level", "allowed", "forbidden", "limits", "hardStops"]);
  for (const k of Object.keys(raw)) if (!allowedKeys.has(k)) return { ok: false, error: `unknown key "${k}"` };
  if (!LEVELS.includes(raw.level as Level)) return { ok: false, error: `level must be one of ${LEVELS.join("|")}` };
  const list = <T extends string>(v: unknown, set: readonly T[], what: string): T[] | string => {
    if (!Array.isArray(v) || v.some((x) => !set.includes(x as T))) return `${what} must be an array of: ${set.join(", ")}`;
    return [...new Set(v as T[])];
  };
  const allowed = list(raw.allowed ?? [], ACTIONS, "allowed");
  const forbidden = list(raw.forbidden ?? [], ACTIONS, "forbidden");
  const hardStops = list(raw.hardStops ?? HARD_STOPS, HARD_STOPS, "hardStops");
  for (const [n, v] of [["allowed", allowed], ["forbidden", forbidden], ["hardStops", hardStops]] as const) if (typeof v === "string") return { ok: false, error: v };
  const a = allowed as Action[], f = forbidden as Action[];
  if (a.some((x) => f.includes(x))) return { ok: false, error: "an action cannot be both allowed and forbidden" };
  if (!isRec(raw.limits)) return { ok: false, error: "limits is required" };
  const L = raw.limits;
  const lim: Partial<Limits> = {};
  for (const k of ["wallMs", "costUsd", "tokens", "maxRetries", "maxReplans", "maxConcurrent", "sameSpecGateFailures"] as const) {
    const v = L[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, error: `limits.${k} must be a non-negative number` };
    lim[k] = v;
  }
  if (lim.maxConcurrent! < 1 || lim.sameSpecGateFailures! < 1) return { ok: false, error: "maxConcurrent and sameSpecGateFailures must be at least 1" };
  return { ok: true, contract: { level: raw.level as Level, allowed: a, forbidden: f, limits: lim as Limits, hardStops: hardStops as HardStop[] } };
}

/** A repo's contract may only tighten the operator's: the result is never looser on any axis. */
export function tighten(operator: Contract, repo: Contract): Parsed {
  if (LEVELS.indexOf(repo.level) > LEVELS.indexOf(operator.level)) return { ok: false, error: `a repo may not raise the autonomy level above the operator's (${operator.level})` };
  const widened = repo.allowed.filter((x) => !operator.allowed.includes(x));
  if (widened.length) return { ok: false, error: `a repo may not allow what the operator did not: ${widened.join(", ")}` };
  const dropped = operator.forbidden.filter((x) => !repo.forbidden.includes(x));
  if (dropped.length) return { ok: false, error: `a repo may not lift a forbidden action: ${dropped.join(", ")}` };
  const droppedStops = operator.hardStops.filter((x) => !repo.hardStops.includes(x));
  if (droppedStops.length) return { ok: false, error: `a repo may not remove a hard stop: ${droppedStops.join(", ")}` };
  for (const k of Object.keys(operator.limits) as Array<keyof Limits>) {
    // Every limit is a ceiling or a trip-wire count: a higher repo value is always looser.
    if (repo.limits[k] > operator.limits[k]) return { ok: false, error: `a repo may not raise limits.${k} above the operator's ${operator.limits[k]}` };
  }
  return { ok: true, contract: repo };
}

export interface Prereqs { sandbox: boolean; budgets: boolean; reviewerCalibration: boolean }

/** L3 needs every safeguard reported present; lower levels need none. */
export function checkLevel(level: Level, p: Prereqs): { ok: true } | { ok: false; error: string; missing: string[] } {
  if (level !== "L3") return { ok: true };
  const missing = [!p.sandbox && "sandbox (#105)", !p.budgets && "budgets (#39)", !p.reviewerCalibration && "reviewer calibration (M-4, #127)"].filter((x): x is string => !!x);
  return missing.length ? { ok: false, error: `L3 (unattended) is refused: missing ${missing.join(", ")}`, missing } : { ok: true };
}

export interface Facts {
  elapsedMs: number;
  spentUsd: number;
  tokens: number;
  gateFailuresBySpec: Record<string, number>;
  replans: number;
  scopeViolations?: Array<{ specId: string; files: string[] }>;
  securityRuleHit?: { rule: string; evidence: string };
  checkpointBlocked?: { checkpoint: string; evidence: string };
  ambiguity?: { specId: string; question: string };
  planStale?: { evidence: string };
  reviewerDisagreement?: { evidence: string };
}
export interface Stop { kind: HardStop; evidence: string }

/** Every hard stop that fires, each with the evidence that fired it. Empty = the mission may continue. */
export function evaluateHardStops(c: Contract, f: Facts): Stop[] {
  const out: Stop[] = [];
  const on = (k: HardStop): boolean => c.hardStops.includes(k);
  if (on("budget-exhausted")) {
    if (c.limits.costUsd > 0 && f.spentUsd >= c.limits.costUsd) out.push({ kind: "budget-exhausted", evidence: `cost $${f.spentUsd.toFixed(2)} >= limit $${c.limits.costUsd}` });
    else if (c.limits.tokens > 0 && f.tokens >= c.limits.tokens) out.push({ kind: "budget-exhausted", evidence: `${f.tokens} tokens >= limit ${c.limits.tokens}` });
  }
  if (on("wall-time") && c.limits.wallMs > 0 && f.elapsedMs >= c.limits.wallMs) out.push({ kind: "wall-time", evidence: `${Math.round(f.elapsedMs / 1000)}s >= limit ${Math.round(c.limits.wallMs / 1000)}s` });
  if (on("repeat-gate-failure")) for (const [id, n] of Object.entries(f.gateFailuresBySpec)) if (n >= c.limits.sameSpecGateFailures) out.push({ kind: "repeat-gate-failure", evidence: `spec ${id} failed its gate ${n} time(s) (limit ${c.limits.sameSpecGateFailures})` });
  if (on("scope-violation") && f.scopeViolations?.length) out.push({ kind: "scope-violation", evidence: f.scopeViolations.map((v) => `${v.specId}: ${v.files.slice(0, 3).join(", ")}`).join("; ") });
  if (on("security-rule") && f.securityRuleHit) out.push({ kind: "security-rule", evidence: `${f.securityRuleHit.rule}: ${f.securityRuleHit.evidence}` });
  if (on("checkpoint-blocked") && f.checkpointBlocked) out.push({ kind: "checkpoint-blocked", evidence: `${f.checkpointBlocked.checkpoint}: ${f.checkpointBlocked.evidence}` });
  if (on("plan-ambiguity") && f.ambiguity) out.push({ kind: "plan-ambiguity", evidence: `spec ${f.ambiguity.specId}: ${f.ambiguity.question}` });
  if (on("plan-stale") && f.planStale) out.push({ kind: "plan-stale", evidence: f.planStale.evidence });
  if (on("reviewer-disagreement") && f.reviewerDisagreement) out.push({ kind: "reviewer-disagreement", evidence: f.reviewerDisagreement.evidence });
  if (f.replans > c.limits.maxReplans) out.push({ kind: "plan-ambiguity", evidence: `${f.replans} replans exceed the limit ${c.limits.maxReplans}` });
  return out;
}

/** Is `action` allowed under the contract? Forbidden wins; anything not explicitly allowed is refused. */
export function actionAllowed(c: Contract, action: Action): { ok: true } | { ok: false; error: string } {
  if (c.forbidden.includes(action)) return { ok: false, error: `${action} is forbidden by the autonomy contract` };
  if (!c.allowed.includes(action)) return { ok: false, error: `${action} is not allowed at level ${c.level}` };
  return { ok: true };
}

export interface Question { text: string; /** Spec ids that cannot proceed without the answer. */ blocks?: string[]; /** A safe default the planner can proceed with. */ safeDefault?: string }
export type QuestionRoute = { route: "assume"; assumption: string; why: string } | { route: "park"; parked: string[]; why: string };

/** Deterministic triage: a default or a question nobody waits on becomes a flagged assumption; otherwise park only the dependents. */
export function routeQuestion(q: Question): QuestionRoute {
  if (q.safeDefault && q.safeDefault.trim()) return { route: "assume", assumption: `proceeding with "${q.safeDefault.trim()}" for: ${q.text}`, why: "a safe default exists; flagged for the digest, not an interrupt" };
  if (!q.blocks?.length) return { route: "assume", assumption: `proceeding without an answer to: ${q.text}`, why: "no spec is blocked by it, so it can wait for the digest" };
  return { route: "park", parked: [...new Set(q.blocks)], why: "no safe default and specs depend on the answer; only those are parked, independent specs continue" };
}

export interface Digest { missionId: string; phase: string; rev: number; progress: { total: number; verified: number; running: number; escalated: number; pending: number }; spentUsd: number | null; assumptionsOpen: string[]; openQuestions: string[]; risks: string[]; recent: string[] }

/** A structured summary for the human, not chatter. */
export function buildDigest(r: MissionRecord, journalTail: Array<{ type: string; why: string }>, spentUsd: number | null = null): Digest {
  const specs = Object.values(r.supervisor.specs);
  const count = (s: string): number => specs.filter((x) => x.status === s).length;
  return {
    missionId: r.missionId, phase: r.phase, rev: r.rev,
    progress: { total: specs.length, verified: count("verified"), running: count("running") + count("dispatching"), escalated: count("escalated"), pending: count("pending") },
    spentUsd,
    assumptionsOpen: r.assumptions.filter((a) => a.status === "open").map((a) => a.text),
    openQuestions: r.openQuestions, risks: r.risks.filter((x) => x.severity !== "low").map((x) => `${x.severity}: ${x.text}`),
    recent: journalTail.slice(-5).map((e) => `${e.type}: ${e.why}`),
  };
}

/** Halt the mission for a hard stop: move it to `blocked` (if running) and journal the escalation with its evidence. Idempotent per kind. */
export async function haltMission(root: string, id: string, stops: Stop[]): Promise<Saved | { ok: true; record: MissionRecord; unchanged: true }> {
  if (stops.length === 0) return { ok: false, error: "no stop given" };
  const m = await loadMission(root, id);
  if (!m.ok) return m;
  if (m.record.phase === "blocked" || m.record.phase === "aborted" || m.record.phase === "done") return { ok: true, record: m.record, unchanged: true };
  for (const st of stops) await appendJournal(root, id, { type: "hard-stop", why: st.kind, evidence: st.evidence });
  const why = `halted: ${stops.map((x) => x.kind).join(", ")}`;
  if (m.record.phase === "designing" || m.record.phase === "awaiting-approval") return { ok: true, record: m.record, unchanged: true };
  // delivering -> executing -> blocked: the transition table has no direct delivering -> blocked move.
  if (m.record.phase === "delivering") { const back = await setPhase(root, id, "executing", why); if (!back.ok) return back; }
  return setPhase(root, id, "blocked", why);
}

export interface AbortDeps { /** Abort one run and report whether termination was confirmed. */ abortRun: (spec: { specId: string; node?: string; runId: string }) => Promise<{ confirmed: boolean; note?: string }> }

/**
 * Kill switch: move the mission to `aborted` (no new dispatch), abort every live run, journal each
 * outcome. Idempotent: aborting an aborted mission aborts nothing more and reports it. A run whose
 * termination is not confirmed is reported, never assumed dead.
 */
export async function abortMission(root: string, id: string, why: string, deps: AbortDeps): Promise<{ ok: true; alreadyAborted: boolean; aborted: Array<{ specId: string; runId: string; confirmed: boolean; note?: string }> } | { ok: false; error: string }> {
  const m = await loadMission(root, id);
  if (!m.ok) return m;
  if (m.record.phase === "done") return { ok: false, error: "the mission is already done" };
  const already = m.record.phase === "aborted";
  if (!already) {
    const s = await updateMission(root, id, (r) => ({ ...r, phase: "aborted" }));
    if (!s.ok) return s;
    await appendJournal(root, id, { type: "abort", why: why.slice(0, 300) });
  }
  const aborted: Array<{ specId: string; runId: string; confirmed: boolean; note?: string }> = [];
  for (const [specId, s] of Object.entries(m.record.supervisor.specs)) {
    if (!s.runId || !(s.status === "running" || s.status === "dispatching")) continue;
    let r: { confirmed: boolean; note?: string };
    try { r = await deps.abortRun({ specId, ...(s.node ? { node: s.node } : {}), runId: s.runId }); } catch (e) { r = { confirmed: false, note: (e as Error).message }; }
    aborted.push({ specId, runId: s.runId, confirmed: r.confirmed, ...(r.note ? { note: r.note } : {}) });
    await appendJournal(root, id, { type: r.confirmed ? "run-aborted" : "run-abort-unconfirmed", why: `kill switch: ${why.slice(0, 120)}`, evidence: specId, runId: s.runId });
  }
  return { ok: true, alreadyAborted: already, aborted };
}
