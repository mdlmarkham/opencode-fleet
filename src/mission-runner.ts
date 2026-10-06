/**
 * One tick of the mission loop, durable (issue #125 on #123). The pure supervisor (mission-supervisor.ts)
 * decides; this applies its decisions to the persisted record and talks to the world through injected
 * deps, so the whole loop is testable and a crash at any point is recoverable.
 *
 * The invariants that matter:
 *  - A launch INTENT is persisted before anything is launched. A crash between intent and launch leaves
 *    a `dispatching` spec, which the next tick RECONCILES with the node (find the run, or void the
 *    intent), never relaunches blindly.
 *  - Every state change is one atomic, rev-checked update of the record; every supervisor journal entry
 *    is mirrored to the mission journal (with the run id), so the journal reads as an account of what
 *    happened and why.
 *  - A hard stop (injected guard) halts before any new work; a mission only moves phase through the
 *    transition table.
 *  - Re-running a tick with nothing changed does nothing.
 */

import { appendJournal, loadMission, readJournal, setPhase, updateMission, type MissionRecord, type Publication } from "./mission-store.js";
import { missionStatus, plan, reduce, type Action, type MissionEvent, type OutcomeSignals } from "./mission-supervisor.js";
import { rubricBaseline } from "./builtin-points.js";

export interface Reconciled { state: "unknown" | "running" | "finished"; runId?: string; signals?: OutcomeSignals }
export type LaunchResult = { ok: true; runId: string } | { ok: false; error: string; /** The launch may have happened (timeout): keep the intent and reconcile later. */ ambiguous?: boolean };

export interface TickDeps {
  nowMs: () => number;
  freeSlots: () => Promise<Record<string, number>>;
  launch: (a: Extract<Action, { type: "dispatch" }>, record: MissionRecord) => Promise<LaunchResult>;
  /** Ask a node what became of a launch key / run. */
  reconcile: (a: Extract<Action, { type: "reconcile" }>, record: MissionRecord) => Promise<Reconciled>;
  /** Terminal outcomes of runs currently running (spec id -> signals); absent = still running. A `lost` entry declares an acknowledged launch whose ledger evidence never appeared (probe was made; a bounded re-attempt may follow). */
  poll: (running: Array<{ specId: string; runId: string; node?: string; startedAtMs?: number }>) => Promise<Record<string, { runId?: string; signals?: OutcomeSignals; lost?: string }>>;
  /** Hard stops to evaluate before new work (e.g. mission-autonomy's evaluateHardStops). Empty = continue. */
  guard?: (record: MissionRecord) => Promise<Array<{ kind: string; evidence: string }>>;
  staleAfterMs?: number;
  /**
   * Publish one verified spec (issue #251: the repo stays current per verified run): sync it to the mission
   * branch and open/update the mission PR through the normal reviewed-head gates. Absent = no publication.
   * A refusal (review FAIL, sync refuse) is `{ok:false}`; `retryable:false` escalates at once.
   * The intent is persisted BEFORE the call (`publishing`), so after a crash the next tick calls again with
   * `resume: true`: the adapter must then look for an existing publication of this spec and return it instead
   * of publishing a second time (find the PR/branch by the spec id), exactly like launch reconcile.
   */
  publish?: (specId: string, record: MissionRecord, ctx: { resume: boolean }) => Promise<PublishResult>;
}

export type PublishResult = { ok: true; ref: string } | { ok: false; error: string; retryable?: boolean };

/** Publication attempts per spec before a human is asked (a refusal is repaired once, like any failed gate). */
export const MAX_PUBLISH_FAILURES = 2;
/** Specs published per tick, so one tick stays short. */
export const MAX_PUBLISH_PER_TICK = 3;

export interface TickResult {
  ok: boolean;
  phase?: string;
  skipped?: string;
  halted?: Array<{ kind: string; evidence: string }>;
  launched: string[];
  outcomes: string[];
  reconciled: string[];
  replanRequested: string[];
  /** Specs published this tick, and those whose publication was refused (issue #251). */
  published: string[];
  publishRefused: string[];
  /** Specs escalated because an unconfirmed launch reconciled to nothing (issue #244 review fix). */
  escalated?: string[];
  status?: "complete" | "running" | "escalated";
  /** Issue #250: the per-tick convergence verdict vs the charter's success criteria. */
  verdict?: "on-track" | "drifting" | "blocked" | "converged";
  error?: string;
}

/** Apply one supervisor event atomically and mirror the journal entries it produced. */
export async function applyEvent(root: string, id: string, ev: MissionEvent): Promise<{ ok: true; record: MissionRecord } | { ok: false; error: string }> {
  let fresh: Array<{ type: string; why: string; evidence?: string; specId?: string }> = [];
  const s = await updateMission(root, id, (r) => {
    const before = r.supervisor.journal.length;
    const next = reduce(r.supervisor, ev);
    fresh = next.journal.slice(before);
    return { ...r, supervisor: next };
  });
  if (!s.ok) return s;
  const runId = "runId" in ev ? ev.runId : undefined;
  for (const e of fresh) await appendJournal(root, id, { type: e.type, why: e.why, ...(e.evidence || e.specId ? { evidence: [e.specId, e.evidence].filter(Boolean).join(": ") } : {}), ...(runId ? { runId } : {}) });
  return s;
}

export async function tick(root: string, id: string, deps: TickDeps): Promise<TickResult> {
  const out: TickResult = { ok: true, launched: [], outcomes: [], reconciled: [], replanRequested: [], escalated: [], published: [], publishRefused: [] };
  let m = await loadMission(root, id);
  if (!m.ok) return { ...out, ok: false, error: m.error };
  out.phase = m.record.phase;
  if (m.record.phase !== "executing") return { ...out, skipped: `phase is ${m.record.phase}; only an executing mission runs` };

  const stops = deps.guard ? await deps.guard(m.record) : [];
  if (stops.length) {
    for (const s of stops) await appendJournal(root, id, { type: "hard-stop", why: s.kind, evidence: s.evidence });
    const b = await setPhase(root, id, "blocked", `halted: ${stops.map((s) => s.kind).join(", ")}`);
    return { ...out, halted: stops, phase: b.ok ? b.record.phase : out.phase };
  }

  // 1. Terminal outcomes of what is running.
  const running = Object.values(m.record.supervisor.specs).filter((s) => s.status === "running" && s.runId).map((s) => ({ specId: s.spec.id, runId: s.runId!, node: s.node, startedAtMs: s.startedAtMs }));
  if (running.length) {
    const done = await deps.poll(running);
    for (const [specId, o] of Object.entries(done)) {
      const runId = o.runId ?? running.find((r) => r.specId === specId)?.runId;
      const signals = o.signals ?? { ok: false, verified: null, evidence: o.lost ?? "the run was declared lost" };
      const a = await applyEvent(root, id, { type: "outcome", specId, ...(runId ? { runId } : {}), signals });
      if (!a.ok) return { ...out, ok: false, error: a.error };
      out.outcomes.push(specId);
    }
  }

  // 1b. Publish verified specs (issue #251), once each, in dependency order: a spec only after everything it
  //     depends on is published. Deduped by the durable `publications` record, so a re-run never re-publishes.
  if (deps.publish) await publishReady(root, id, deps.publish, out);

  // 2. Plan from the fresh state.
  m = await loadMission(root, id);
  if (!m.ok) return { ...out, ok: false, error: m.error };
  const ctx = { freeSlots: await deps.freeSlots(), nowMs: deps.nowMs(), ...(deps.staleAfterMs ? { staleAfterMs: deps.staleAfterMs } : {}) };
  const actions = plan(m.record.supervisor, ctx);

  for (const a of actions) {
    if (a.type === "reconcile") {
      const r = await deps.reconcile(a, m.record);
      out.reconciled.push(a.specId);
      if (r.state === "unknown") {
        // Issue #244 review fix: an AMBIGUOUS launch (the node may be running it — no ledger row) is
        // NEVER voided into a relaunch. The launch-unconfirmed journal record discriminates: without
        // it, the crash happened before the launch call and voiding is safe; with it: escalate once.
        const jr = await readJournal(root, id);
        const ambiguous = jr.some((e) => e.type === "launch-unconfirmed" && (e as { specId?: string }).specId === a.specId && (e as { key?: string }).key === a.key);
        if (ambiguous) {
          const u = await applyEvent(root, id, { type: "launch-unresolved", specId: a.specId, key: a.key, evidence: `no ledger entry for key ${a.key}, but the launch was never confirmed: a run may be live` });
          if (!u.ok) return { ...out, ok: false, error: u.error };
          out.escalated!.push(a.specId);
        } else {
          await applyEvent(root, id, { type: "intent-void", specId: a.specId, key: a.key, reason: "the node has no run for this launch key: it never launched" });
        }
      }
      else if (r.state === "running" && r.runId) await applyEvent(root, id, { type: "dispatched", specId: a.specId, runId: r.runId, key: a.key });
      else if (r.state === "finished" && r.signals) {
        if (r.runId) await applyEvent(root, id, { type: "dispatched", specId: a.specId, runId: r.runId, key: a.key });
        await applyEvent(root, id, { type: "outcome", specId: a.specId, ...(r.runId ? { runId: r.runId } : {}), signals: r.signals });
        out.outcomes.push(a.specId);
      }
    } else if (a.type === "dispatch") {
      // Intent first, durably; only then launch.
      const intent = await applyEvent(root, id, { type: "dispatch-intent", specId: a.specId, node: a.node, key: a.key, nowMs: deps.nowMs() });
      if (!intent.ok) return { ...out, ok: false, error: intent.error };
      let res: LaunchResult;
      try { res = await deps.launch(a, intent.record); } catch (e) { res = { ok: false, error: (e as Error).message, ambiguous: true }; }
      if (res.ok) { await applyEvent(root, id, { type: "dispatched", specId: a.specId, runId: res.runId, key: a.key }); out.launched.push(a.specId); }
      else if (!res.ambiguous) await applyEvent(root, id, { type: "intent-void", specId: a.specId, key: a.key, reason: `launch refused: ${res.error.slice(0, 200)}` });
      else await appendJournal(root, id, { type: "launch-unconfirmed", specId: a.specId, key: a.key, why: `launch of ${a.specId} may or may not have happened; will reconcile`, evidence: res.error.slice(0, 200) });
    } else {
      const seen = (await readJournalTypes(root, id)).has(`replan:${a.specId}:${a.evidence.slice(0, 40)}`);
      if (!seen) await appendJournal(root, id, { type: "replan-requested", why: "a spec needs a plan change: a human or the decomposer role must supply it", evidence: `${a.specId}: ${a.evidence.slice(0, 200)}` });
      out.replanRequested.push(a.specId);
    }
  }

  // 3. Mission-level status moves the phase.
  m = await loadMission(root, id);
  if (!m.ok) return { ...out, ok: false, error: m.error };
  // Issue #250: per-tick convergence verdict against the charter's success criteria.
  // The deterministic rubric baseline is the fallback; the S1 `progress.rubric` point is
  // shadow-only for now, so the loop's behaviour is unchanged until it is promoted.
  const specStates = Object.values(m.record.supervisor.specs);
  const rubricSignals = {
    specsTotal: specStates.length,
    specsDone: specStates.filter((s) => s.status === "verified").length,
    escalated: specStates.filter((s) => s.status === "escalated").length,
    criteriaTotal: 0,
    criteriaPassed: 0,
  };
  const verdict = rubricBaseline(rubricSignals);
  out.verdict = verdict;
  await appendJournal(root, id, { type: "progress-rubric", why: verdict, evidence: `specs ${rubricSignals.specsDone}/${rubricSignals.specsTotal}, escalated ${rubricSignals.escalated}` });
  const st = missionStatus(m.record.supervisor, { ...ctx, freeSlots: await deps.freeSlots() });
  out.status = st.status;
  const unpublished = deps.publish ? Object.values(m.record.supervisor.specs).filter((s) => s.status === "verified" && m.record.publications?.[s.spec.id]?.state !== "published") : [];
  if (st.status === "complete" && unpublished.length > 0) {
    // Issue #251: with publication on, the mission is not delivered until every verified spec is published.
    const stuck = unpublished.filter((s) => m.record.publications?.[s.spec.id]?.state === "escalated");
    if (stuck.length > 0) {
      const p = await setPhase(root, id, "blocked", `publication escalated for ${stuck.map((s) => s.spec.id).join(", ")}`);
      out.phase = p.ok ? p.record.phase : out.phase;
    } else out.status = "running";
  } else if (st.status === "complete") {
    const p = await setPhase(root, id, "delivering", "every spec is verified");
    out.phase = p.ok ? p.record.phase : out.phase;
  } else if (st.status === "escalated") {
    for (const e of st.escalations) await appendJournal(root, id, { type: "escalation", why: e.reason || "blocked", evidence: `${e.specId}: ${e.evidence}`.slice(0, 300) });
    const p = await setPhase(root, id, "blocked", "escalated: no spec can run");
    out.phase = p.ok ? p.record.phase : out.phase;
  }
  return out;
}

async function readJournalTypes(root: string, id: string): Promise<Set<string>> {
  const { readJournal } = await import("./mission-store.js");
  return new Set((await readJournal(root, id)).filter((e) => e.type === "replan-requested").map((e) => `replan:${(e.evidence ?? "").split(": ")[0]}:${(e.evidence ?? "").split(": ").slice(1).join(": ").slice(0, 40)}`));
}

async function publishReady(root: string, id: string, publish: NonNullable<TickDeps["publish"]>, out: TickResult): Promise<void> {
  for (let n = 0; n < MAX_PUBLISH_PER_TICK; n++) {
    const m = await loadMission(root, id);
    if (!m.ok) return;
    const pubs = m.record.publications ?? {};
    const specs = m.record.supervisor.specs;
    const ready = Object.values(specs).filter((s) => s.status === "verified" && (pubs[s.spec.id]?.state ?? "failed") !== "published" && pubs[s.spec.id]?.state !== "escalated"
      && s.spec.deps.every((d) => specs[d]?.status === "superseded" || pubs[d]?.state === "published"))
      .sort((a, b) => a.spec.id.localeCompare(b.spec.id));
    const next = ready[0];
    if (!next) return;
    const specId = next.spec.id;
    const prev = pubs[specId];
    // Intent first, durably: a crash between a successful publish and the record write must not publish twice.
    const resume = prev?.state === "publishing";
    const marked = await updateMission(root, id, (r) => ({ ...r, publications: { ...(r.publications ?? {}), [specId]: { state: "publishing" as const, failures: prev?.failures ?? 0, at: new Date().toISOString(), ...(prev?.lastError ? { lastError: prev.lastError } : {}) } } }));
    if (!marked.ok) return;
    let res: PublishResult;
    try { res = await publish(specId, marked.record, { resume }); } catch (e) { res = { ok: false, error: (e as Error).message }; }
    const at = new Date().toISOString();
    const entry: Publication = res.ok
      ? { state: "published", ref: res.ref.slice(0, 300), failures: prev?.failures ?? 0, at }
      : { state: res.retryable === false || (prev?.failures ?? 0) + 1 >= MAX_PUBLISH_FAILURES ? "escalated" : "failed", failures: (prev?.failures ?? 0) + 1, lastError: res.error.slice(0, 300), at };
    const saved = await updateMission(root, id, (r) => ({ ...r, publications: { ...(r.publications ?? {}), [specId]: entry } }));
    if (!saved.ok) return;
    if (res.ok) { out.published.push(specId); await appendJournal(root, id, { type: "published", why: `${specId} is verified and published`, evidence: res.ref.slice(0, 200) }); }
    else {
      out.publishRefused.push(specId);
      await appendJournal(root, id, { type: entry.state === "escalated" ? "publish-escalated" : "publish-refused", why: entry.state === "escalated" ? `publishing ${specId} failed ${entry.failures}x (or is not retryable): a human decides` : `publishing ${specId} was refused; it will be retried once`, evidence: res.error.slice(0, 200) });
      return; // do not publish later specs past a refused one in the same tick
    }
  }
}
