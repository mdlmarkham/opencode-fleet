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

import { appendJournal, loadMission, setPhase, updateMission, type MissionRecord } from "./mission-store.js";
import { missionStatus, plan, reduce, type Action, type MissionEvent, type OutcomeSignals } from "./mission-supervisor.js";

export interface Reconciled { state: "unknown" | "running" | "finished"; runId?: string; signals?: OutcomeSignals }
export type LaunchResult = { ok: true; runId: string } | { ok: false; error: string; /** The launch may have happened (timeout): keep the intent and reconcile later. */ ambiguous?: boolean };

export interface TickDeps {
  nowMs: () => number;
  freeSlots: () => Promise<Record<string, number>>;
  launch: (a: Extract<Action, { type: "dispatch" }>, record: MissionRecord) => Promise<LaunchResult>;
  /** Ask a node what became of a launch key / run. */
  reconcile: (a: Extract<Action, { type: "reconcile" }>, record: MissionRecord) => Promise<Reconciled>;
  /** Terminal outcomes of runs currently running (spec id -> signals); absent = still running. */
  poll: (running: Array<{ specId: string; runId: string }>) => Promise<Record<string, { runId?: string; signals: OutcomeSignals }>>;
  /** Hard stops to evaluate before new work (e.g. mission-autonomy's evaluateHardStops). Empty = continue. */
  guard?: (record: MissionRecord) => Promise<Array<{ kind: string; evidence: string }>>;
  staleAfterMs?: number;
}

export interface TickResult {
  ok: boolean;
  phase?: string;
  skipped?: string;
  halted?: Array<{ kind: string; evidence: string }>;
  launched: string[];
  outcomes: string[];
  reconciled: string[];
  replanRequested: string[];
  status?: "complete" | "running" | "escalated";
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
  const out: TickResult = { ok: true, launched: [], outcomes: [], reconciled: [], replanRequested: [] };
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
  const running = Object.values(m.record.supervisor.specs).filter((s) => s.status === "running" && s.runId).map((s) => ({ specId: s.spec.id, runId: s.runId! }));
  if (running.length) {
    const done = await deps.poll(running);
    for (const [specId, o] of Object.entries(done)) {
      const runId = o.runId ?? running.find((r) => r.specId === specId)?.runId;
      const a = await applyEvent(root, id, { type: "outcome", specId, ...(runId ? { runId } : {}), signals: o.signals });
      if (!a.ok) return { ...out, ok: false, error: a.error };
      out.outcomes.push(specId);
    }
  }

  // 2. Plan from the fresh state.
  m = await loadMission(root, id);
  if (!m.ok) return { ...out, ok: false, error: m.error };
  const ctx = { freeSlots: await deps.freeSlots(), nowMs: deps.nowMs(), ...(deps.staleAfterMs ? { staleAfterMs: deps.staleAfterMs } : {}) };
  const actions = plan(m.record.supervisor, ctx);

  for (const a of actions) {
    if (a.type === "reconcile") {
      const r = await deps.reconcile(a, m.record);
      out.reconciled.push(a.specId);
      if (r.state === "unknown") await applyEvent(root, id, { type: "intent-void", specId: a.specId, key: a.key, reason: "the node has no run for this launch key: it never launched" });
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
      else await appendJournal(root, id, { type: "launch-unconfirmed", why: `launch of ${a.specId} may or may not have happened; will reconcile`, evidence: res.error.slice(0, 200) });
    } else {
      const seen = (await readJournalTypes(root, id)).has(`replan:${a.specId}:${a.evidence.slice(0, 40)}`);
      if (!seen) await appendJournal(root, id, { type: "replan-requested", why: "a spec needs a plan change: a human or the decomposer role must supply it", evidence: `${a.specId}: ${a.evidence.slice(0, 200)}` });
      out.replanRequested.push(a.specId);
    }
  }

  // 3. Mission-level status moves the phase.
  m = await loadMission(root, id);
  if (!m.ok) return { ...out, ok: false, error: m.error };
  const st = missionStatus(m.record.supervisor, { ...ctx, freeSlots: await deps.freeSlots() });
  out.status = st.status;
  if (st.status === "complete") {
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
