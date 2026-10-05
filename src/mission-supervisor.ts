/**
 * Mission supervisor core (issue #125, M-2): the decision logic of the supervisor loop as PURE
 * functions over a plain, serialisable state. No I/O, no clock, no model calls. The loop around it
 * (dispatch, poll, persist) is deliberately thin and short-lived; all durable state is this object.
 *
 *   plan(state, ctx)        -> actions the loop should perform (dispatch / reconcile / replan / escalate)
 *   reduce(state, event)    -> next state, with a journal entry that says WHY
 *   applyReplan(state, diff)-> a recorded plan diff, never discarding verified work
 *
 * Properties this is built to hold (tests simulate them):
 *  - restartable at any point: `JSON.parse(JSON.stringify(state))` between any two steps changes nothing;
 *  - idempotent dispatch: the intent to launch (with a deterministic key) is recorded BEFORE the launch,
 *    so a restarted supervisor reconciles an unacknowledged launch instead of launching it twice;
 *  - bounded self-correction: environment/flaky failures retry, a real failure gets one repair attempt
 *    with the evidence, a flawed spec asks for a replan, and every limit ends in an escalation;
 *  - every decision is a journal entry with evidence.
 *
 * Not here (other M-issues): where the state is persisted (the mission record, #123), the autonomy
 * contract and hard stops (#124), checkpoints (#126), the decomposer that proposes a replan (#110 R-2).
 */

import { scopeOverlap, type TaskScope } from "./scope.js";

export const SUPERVISOR_SCHEMA_VERSION = 1;
export const MAX_SPECS = 200;
export const MAX_JOURNAL = 5000;

export type SpecStatus = "pending" | "dispatching" | "running" | "verified" | "needs-replan" | "escalated" | "superseded";
export type FailureClass = "environment" | "flaky" | "real" | "flawed-spec" | "unknown";

export interface MissionSpec {
  id: string;
  goal: string;
  deps: string[];
  scope?: TaskScope;
}

export interface Limits {
  /** Retries for environment/flaky failures, per spec. */
  maxRetries: number;
  /** Repair attempts (a new run carrying the failure evidence) for a real failure, per spec. */
  maxRepairs: number;
  /** Replans per mission. */
  maxReplans: number;
  /** Specs running at once, mission-wide. */
  maxParallel: number;
}
export const DEFAULT_LIMITS: Limits = { maxRetries: 2, maxRepairs: 1, maxReplans: 2, maxParallel: 4 };

export interface SpecState {
  spec: MissionSpec;
  status: SpecStatus;
  /** Launch attempts so far (the dispatch key embeds the next one). */
  attempts: number;
  retries: number;
  repairs: number;
  node?: string;
  runId?: string;
  /** Key of the launch intent in flight or last launched; the idempotency token. */
  dispatchKey?: string;
  startedAtMs?: number;
  /** Evidence from the last failure, handed to the next (repair) attempt. */
  feedback?: string;
  lastFailure?: { class: FailureClass; evidence: string; fingerprint: string };
  escalation?: { reason: string; evidence: string };
}

export interface JournalEntry {
  seq: number;
  type: string;
  specId?: string;
  /** Why this decision was made: required on every entry. */
  why: string;
  evidence?: string;
}

export interface MissionState {
  schemaVersion: number;
  missionId: string;
  limits: Limits;
  specs: Record<string, SpecState>;
  replans: number;
  journal: JournalEntry[];
}

// ---------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------

/** Dependency problems in a spec set: unknown ids, self-deps, cycles. Empty when sound. */
export function graphErrors(specs: MissionSpec[]): string[] {
  const errs: string[] = [];
  const ids = new Set(specs.map((s) => s.id));
  if (ids.size !== specs.length) errs.push("duplicate spec ids");
  for (const s of specs) {
    for (const d of s.deps) {
      if (d === s.id) errs.push(`${s.id} depends on itself`);
      else if (!ids.has(d)) errs.push(`${s.id} depends on unknown spec ${d}`);
    }
  }
  if (errs.length) return errs;
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(specs.map((s) => [s.id, s]));
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { errs.push(`dependency cycle: ${[...path, id].join(" -> ")}`); return; }
    state.set(id, 1);
    for (const d of byId.get(id)!.deps) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const s of specs) visit(s.id, []);
  return [...new Set(errs)];
}

export function newMission(missionId: string, specs: MissionSpec[], limits: Partial<Limits> = {}): { ok: true; state: MissionState } | { ok: false; errors: string[] } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(missionId)) return { ok: false, errors: ["missionId must be 1-64 of A-Za-z0-9._-"] };
  if (specs.length === 0) return { ok: false, errors: ["a mission needs at least one spec"] };
  if (specs.length > MAX_SPECS) return { ok: false, errors: [`at most ${MAX_SPECS} specs`] };
  const errors = graphErrors(specs);
  if (errors.length) return { ok: false, errors };
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [k, v] of Object.entries(merged)) if (!Number.isInteger(v) || v < 0 || (k === "maxParallel" && v < 1)) return { ok: false, errors: [`limit ${k} must be a non-negative integer (maxParallel >= 1)`] };
  const st: MissionState = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    missionId,
    limits: merged,
    specs: Object.fromEntries(specs.map((s) => [s.id, { spec: s, status: "pending" as SpecStatus, attempts: 0, retries: 0, repairs: 0 }])),
    replans: 0,
    journal: [],
  };
  return { ok: true, state: log(st, { type: "mission-start", why: `${specs.length} spec(s) accepted`, evidence: specs.map((s) => s.id).join(",") }) };
}

function log(state: MissionState, e: Omit<JournalEntry, "seq">): MissionState {
  const seq = (state.journal[state.journal.length - 1]?.seq ?? 0) + 1;
  const journal = [...state.journal, { seq, ...e }];
  return { ...state, journal: journal.length > MAX_JOURNAL ? journal.slice(journal.length - MAX_JOURNAL) : journal };
}

const patch = (state: MissionState, id: string, over: Partial<SpecState>): MissionState => ({ ...state, specs: { ...state.specs, [id]: { ...state.specs[id]!, ...over } } });

// ---------------------------------------------------------------------------
// Failure classification (deterministic signals first)
// ---------------------------------------------------------------------------

export interface OutcomeSignals {
  /** The run's own process status was ok. */
  ok: boolean;
  /** The verification gate: true / false / null (no gate ran). */
  verified: boolean | null;
  error?: string;
  endedBy?: "wall-clock" | "idle-watchdog" | "watch-relay";
  handRaised?: boolean;
  question?: string;
  /** What the failed gate said (verifyDetails, scope violations), short. */
  evidence?: string;
}

const ENV_RE = /FLEET_ERROR|no-capacity|launch failed|launch ack|node channel|unreachable|ECONNRESET|ETIMEDOUT|ssh:|detection-failed|policy-refused|head-mismatch/i;

export function classifyFailure(s: OutcomeSignals): { class: FailureClass; evidence: string } {
  const evidence = (s.evidence ?? s.error ?? (s.handRaised ? `hand-raised: ${s.question ?? ""}` : "no detail")).slice(0, 400);
  if (s.handRaised) return { class: "flawed-spec", evidence };
  if (s.endedBy === "watch-relay" || (s.error && ENV_RE.test(s.error))) return { class: "environment", evidence };
  if (s.endedBy === "idle-watchdog" || s.endedBy === "wall-clock") return { class: "flaky", evidence };
  if (s.verified === false || s.ok === false) return { class: "real", evidence };
  return { class: "unknown", evidence };
}

const fingerprintOf = (evidence: string): string => evidence.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 120);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type MissionEvent =
  /** The loop is about to launch: recorded and persisted BEFORE the launch. */
  | { type: "dispatch-intent"; specId: string; node: string; key: string; nowMs: number }
  /** The launch was acknowledged (or an unacknowledged intent was reconciled to a real run). */
  | { type: "dispatched"; specId: string; runId: string; key: string }
  /** The intent was reconciled: the node has no run for this key, so it never launched. */
  | { type: "intent-void"; specId: string; key: string; reason: string }
  | { type: "outcome"; specId: string; runId?: string; signals: OutcomeSignals };

export function reduce(state: MissionState, ev: MissionEvent): MissionState {
  const cur = state.specs[ev.specId];
  if (!cur) return log(state, { type: "ignored", specId: ev.specId, why: `event ${ev.type} for an unknown spec` });

  if (ev.type === "dispatch-intent") {
    if (cur.status !== "pending") return log(state, { type: "ignored", specId: ev.specId, why: `dispatch-intent while ${cur.status}` });
    const next = patch(state, ev.specId, { status: "dispatching", node: ev.node, dispatchKey: ev.key, attempts: cur.attempts + 1, startedAtMs: ev.nowMs });
    return log(next, { type: "dispatch-intent", specId: ev.specId, why: `launch ${ev.key} on ${ev.node}`, evidence: cur.feedback ? `carrying failure evidence: ${cur.feedback.slice(0, 200)}` : undefined });
  }

  if (ev.type === "dispatched") {
    if (cur.dispatchKey !== ev.key || (cur.status !== "dispatching" && cur.status !== "running")) return log(state, { type: "ignored", specId: ev.specId, why: `dispatched ack for ${ev.key} does not match the intent in flight` });
    return log(patch(state, ev.specId, { status: "running", runId: ev.runId }), { type: "dispatched", specId: ev.specId, why: `run ${ev.runId} acknowledged`, evidence: ev.key });
  }

  if (ev.type === "intent-void") {
    if (cur.dispatchKey !== ev.key || cur.status !== "dispatching") return state;
    // The launch never happened: undo the attempt so it is not counted, and make it runnable again.
    return log(patch(state, ev.specId, { status: "pending", attempts: Math.max(0, cur.attempts - 1), node: undefined, dispatchKey: undefined }), { type: "intent-void", specId: ev.specId, why: ev.reason, evidence: ev.key });
  }

  // outcome
  if (cur.status !== "running" && cur.status !== "dispatching") return log(state, { type: "ignored", specId: ev.specId, why: `outcome while ${cur.status}` });
  const s = ev.signals;
  if (s.ok && s.verified === true) {
    return log(patch(state, ev.specId, { status: "verified", feedback: undefined }), { type: "verified", specId: ev.specId, why: "run ok and the verification gate passed", evidence: ev.runId });
  }
  if (s.ok && s.verified === null) {
    // No gate ran: exit 0 is not verification. Treat as a failure to be repaired with a gate, not as success.
    return fail(state, ev.specId, { ...classifyFailure({ ...s, ok: false, evidence: "the run exited 0 but no verification gate ran, so success is unproven" }), class: "flawed-spec" }, ev.runId);
  }
  return fail(state, ev.specId, classifyFailure(s), ev.runId);
}

function fail(state: MissionState, id: string, c: { class: FailureClass; evidence: string }, runId?: string): MissionState {
  const cur = state.specs[id]!;
  const fp = fingerprintOf(c.evidence);
  const repeated = cur.lastFailure?.fingerprint === fp && cur.repairs > 0;
  const base = patch(state, id, { lastFailure: { class: c.class, evidence: c.evidence, fingerprint: fp }, runId: runId ?? cur.runId });
  const lim = state.limits;
  const note = (type: string, why: string) => ({ type, specId: id, why, evidence: c.evidence });
  const escalate = (reason: string): MissionState => log(patch(base, id, { status: "escalated", escalation: { reason, evidence: c.evidence } }), note("escalate", reason));

  if (c.class === "environment" || c.class === "flaky") {
    if (cur.retries < lim.maxRetries) return log(patch(base, id, { status: "pending", retries: cur.retries + 1, feedback: undefined, node: undefined, dispatchKey: undefined }), note("retry", `${c.class} failure: retry ${cur.retries + 1}/${lim.maxRetries}`));
    return escalate(`${c.class} failure persisted through ${lim.maxRetries} retr${lim.maxRetries === 1 ? "y" : "ies"}`);
  }
  if (c.class === "flawed-spec" || repeated) {
    if (state.replans < lim.maxReplans) return log(patch(base, id, { status: "needs-replan", node: undefined, dispatchKey: undefined }), note("request-replan", repeated ? "the same failure repeated after a repair: the spec, not the attempt, looks wrong" : "the spec is ambiguous or unverifiable as written"));
    return escalate(`flawed spec and the replan limit (${lim.maxReplans}) is used up`);
  }
  // real | unknown
  if (cur.repairs < lim.maxRepairs) return log(patch(base, id, { status: "pending", repairs: cur.repairs + 1, feedback: c.evidence, node: undefined, dispatchKey: undefined }), note("repair", `real failure: repair attempt ${cur.repairs + 1}/${lim.maxRepairs} with the failure evidence`));
  return escalate(`real failure persisted through ${lim.maxRepairs} repair attempt(s)`);
}

// ---------------------------------------------------------------------------
// Planning: what the loop should do next
// ---------------------------------------------------------------------------

export interface PlanContext {
  /** Free slots per node (a node absent or at 0 cannot take a run). Unlimited nodes pass a large number. */
  freeSlots: Record<string, number>;
  nowMs: number;
  /** A launch intent / running spec older than this is reconciled with the node. Default 6h. */
  staleAfterMs?: number;
}

export type Action =
  | { type: "dispatch"; specId: string; node: string; key: string; kind: "first" | "retry" | "repair"; feedback?: string }
  /** An unacknowledged intent or a stale running spec: ask the node what happened to this key/run; do NOT relaunch. */
  | { type: "reconcile"; specId: string; key: string; runId?: string }
  | { type: "replan"; specId: string; evidence: string };

export const dispatchKey = (missionId: string, specId: string, attempt: number): string => `${missionId}:${specId}:${attempt}`;

const done = (s: SpecState): boolean => s.status === "verified" || s.status === "superseded";

export function plan(state: MissionState, ctx: PlanContext): Action[] {
  const actions: Action[] = [];
  const staleAfter = ctx.staleAfterMs ?? 6 * 60 * 60_000;
  const specs = Object.values(state.specs);

  // 1. Never relaunch what may already be launched: reconcile first.
  for (const s of specs) {
    if (s.status === "dispatching" && s.dispatchKey) actions.push({ type: "reconcile", specId: s.spec.id, key: s.dispatchKey });
    else if (s.status === "running" && s.startedAtMs !== undefined && ctx.nowMs - s.startedAtMs > staleAfter && s.dispatchKey) actions.push({ type: "reconcile", specId: s.spec.id, key: s.dispatchKey, ...(s.runId ? { runId: s.runId } : {}) });
  }
  // 2. Specs that need a plan change.
  for (const s of specs) if (s.status === "needs-replan") actions.push({ type: "replan", specId: s.spec.id, evidence: s.lastFailure?.evidence ?? "" });

  // 3. Runnable specs: dependencies verified, scope not overlapping anything running or chosen, slots available.
  const active = specs.filter((s) => s.status === "running" || s.status === "dispatching");
  let room = Math.max(0, state.limits.maxParallel - active.length);
  const slots = { ...ctx.freeSlots };
  const chosen: SpecState[] = [];
  const holdsScope = (s: SpecState): TaskScope | undefined => s.spec.scope;
  for (const s of specs) {
    if (room <= 0) break;
    if (s.status !== "pending") continue;
    if (!s.spec.deps.every((d) => state.specs[d] && done(state.specs[d]!))) continue;
    const mine = holdsScope(s);
    // A spec with no scope cannot be proven disjoint from anything running: it runs only when nothing else does.
    const clash = [...active, ...chosen].some((o) => !mine || !holdsScope(o) || scopeOverlap(mine, holdsScope(o)!));
    if (clash) continue;
    const node = Object.keys(slots).filter((n) => (slots[n] ?? 0) > 0).sort((a, b) => (slots[b] ?? 0) - (slots[a] ?? 0))[0];
    if (!node) break;
    slots[node] = (slots[node] ?? 0) - 1;
    room--;
    chosen.push(s);
    const kind = s.feedback ? "repair" : s.retries > 0 ? "retry" : "first";
    actions.push({ type: "dispatch", specId: s.spec.id, node, key: dispatchKey(state.missionId, s.spec.id, s.attempts + 1), kind, ...(s.feedback ? { feedback: s.feedback } : {}) });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Replan: a recorded plan diff
// ---------------------------------------------------------------------------

export interface PlanDiff {
  reason: string;
  /** Specs to withdraw (marked superseded). */
  remove?: string[];
  /** Specs to add. */
  add?: MissionSpec[];
  /** Specs to revise (goal / deps / scope); they restart as pending. */
  modify?: Record<string, Partial<Pick<MissionSpec, "goal" | "deps" | "scope">>>;
}

export function applyReplan(state: MissionState, diff: PlanDiff): { ok: true; state: MissionState } | { ok: false; error: string } {
  if (!diff.reason || diff.reason.trim() === "") return { ok: false, error: "a replan needs a reason" };
  if (state.replans >= state.limits.maxReplans) return { ok: false, error: `the replan limit (${state.limits.maxReplans}) is used up: escalate instead` };
  const protectedStatus = new Set<SpecStatus>(["verified", "running", "dispatching"]);
  for (const id of [...(diff.remove ?? []), ...Object.keys(diff.modify ?? {})]) {
    const s = state.specs[id];
    if (!s) return { ok: false, error: `unknown spec ${id}` };
    if (protectedStatus.has(s.status)) return { ok: false, error: `${id} is ${s.status}: verified or in-flight work is never discarded or rewritten by a replan` };
  }
  const specs: Record<string, SpecState> = { ...state.specs };
  for (const id of diff.remove ?? []) specs[id] = { ...specs[id]!, status: "superseded" };
  for (const [id, m] of Object.entries(diff.modify ?? {})) {
    const old = specs[id]!;
    specs[id] = { ...old, spec: { ...old.spec, ...m }, status: "pending", attempts: old.attempts, retries: 0, repairs: 0, feedback: undefined, lastFailure: undefined, escalation: undefined, node: undefined, dispatchKey: undefined };
  }
  for (const a of diff.add ?? []) {
    if (specs[a.id]) return { ok: false, error: `spec ${a.id} already exists` };
    specs[a.id] = { spec: a, status: "pending", attempts: 0, retries: 0, repairs: 0 };
  }
  if (Object.keys(specs).length > MAX_SPECS) return { ok: false, error: `at most ${MAX_SPECS} specs` };
  // A removed spec that something still needs is a dangling dependency, not a silent drop.
  for (const s of Object.values(specs)) {
    if (s.status === "superseded") continue;
    const gone = s.spec.deps.filter((d) => specs[d]?.status === "superseded");
    if (gone.length) return { ok: false, error: `${s.spec.id} still depends on withdrawn spec(s) ${gone.join(", ")}: modify its deps in the same diff` };
  }
  // Unknown dependencies are errors too (never silently dropped): check the live graph as written.
  const errs = graphErrors(Object.values(specs).filter((s) => s.status !== "superseded").map((s) => s.spec));
  if (errs.length) return { ok: false, error: errs.join("; ") };
  const next: MissionState = { ...state, specs, replans: state.replans + 1 };
  // Specs that asked for the replan but were not touched by it escalate rather than hang.
  let out = log(next, { type: "replan", why: diff.reason, evidence: `removed ${(diff.remove ?? []).length}, added ${(diff.add ?? []).length}, modified ${Object.keys(diff.modify ?? {}).length}` });
  for (const s of Object.values(out.specs)) {
    if (s.status === "needs-replan") out = log(patch(out, s.spec.id, { status: "escalated", escalation: { reason: "the replan did not address this spec", evidence: s.lastFailure?.evidence ?? "" } }), { type: "escalate", specId: s.spec.id, why: "the replan did not address this spec", evidence: s.lastFailure?.evidence });
  }
  return { ok: true, state: out };
}

/** Mark a spec that asked for a replan as escalated (the decomposer declined or is unavailable). */
export function declineReplan(state: MissionState, specId: string, why: string): MissionState {
  const s = state.specs[specId];
  if (!s || s.status !== "needs-replan") return state;
  return log(patch(state, specId, { status: "escalated", escalation: { reason: why, evidence: s.lastFailure?.evidence ?? "" } }), { type: "escalate", specId, why, evidence: s.lastFailure?.evidence });
}

// ---------------------------------------------------------------------------
// Mission status
// ---------------------------------------------------------------------------

export type MissionStatus = "complete" | "running" | "escalated";

/** `escalated` when something needs a human and no runnable work remains; `complete` when everything live is verified. */
export function missionStatus(state: MissionState, ctx: PlanContext): { status: MissionStatus; escalations: Array<{ specId: string; reason: string; evidence: string }> } {
  const specs = Object.values(state.specs);
  const escalations = specs.filter((s) => s.status === "escalated").map((s) => ({ specId: s.spec.id, reason: s.escalation?.reason ?? "", evidence: s.escalation?.evidence ?? "" }));
  if (specs.every(done)) return { status: "complete", escalations };
  const busy = specs.some((s) => s.status === "running" || s.status === "dispatching" || s.status === "needs-replan");
  if (busy) return { status: "running", escalations };
  if (plan(state, ctx).some((a) => a.type === "dispatch")) return { status: "running", escalations };
  // Ready but not dispatched (no free slot right now, or a scope clash resolving as runs finish) is waiting, not stuck.
  const readyPending = specs.some((s) => s.status === "pending" && s.spec.deps.every((d) => state.specs[d] && done(state.specs[d]!)));
  if (readyPending) return { status: "running", escalations };
  // Nothing running and nothing can become ready: what is left is blocked behind an escalated spec.
  return { status: "escalated", escalations: escalations.length ? escalations : [{ specId: "", reason: "no spec can run and none is waiting: blocked", evidence: "" }] };
}
