/**
 * Node-backed deps for the mission tick (issue #125). Everything the world provides arrives through the
 * injected `World`, so this is testable without nodes and the tool only has to supply real functions
 * (the dispatch tool, run status, the ledger).
 *
 *  - launch goes through the normal `fleet_dispatch` path (design gate, capacity slots, scope, clone
 *    isolation, ledger), carrying the launch key as `missionKey` so a crashed launch can be found again.
 *  - reconcile looks the key up in the LEDGER: no entry = it never launched; an entry = adopt its run.
 *  - poll asks run status (which reconciles the ledger) and reads the terminal state from the entry.
 *  - repair attempts carry the previous failure evidence, quoted as untrusted data.
 */

import type { LedgerEntry } from "./ledger.js";
import type { MissionRecord } from "./mission-store.js";
import type { OutcomeSignals } from "./mission-supervisor.js";
import type { TickDeps } from "./mission-runner.js";
import { quoteUntrusted } from "./untrusted.js";

export interface World {
  nodes(): Promise<string[]>;
  /** Max concurrent runs for a node (undefined = unlimited). */
  limitFor(node: string): number | undefined;
  ledger(): Promise<LedgerEntry[]>;
  /** fleet_dispatch, decoded: the per-node result map. */
  dispatch(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** fleet_run_status for one run (reconciles the ledger as a side effect). */
  status(node: string, runId: string): Promise<void>;
  nowMs(): number;
}

// Issue #244 review fix: `timed-out` is terminal for the mission loop (a wall-clocked run must
// resolve, not be polled forever).
const TERMINAL = new Set(["completed", "failed", "failed-verification", "discarded", "timed-out"]);
/** Conservative bound before an acknowledged-but-unrecorded launch is declared presumed-lost. */
export const LOST_AFTER_MS = 900_000;

export function signalsOf(e: LedgerEntry): OutcomeSignals {
  const failedGate = e.state === "failed-verification" || e.verified === false;
  return {
    ok: e.state === "completed" || e.state === "failed-verification",
    verified: typeof e.verified === "boolean" ? e.verified : null,
    ...(e.handRaised ? { handRaised: true, ...(e.question ? { question: e.question } : {}) } : {}),
    ...(failedGate ? { evidence: String(e.summary ?? "the verification gate failed").slice(0, 400) } : e.state === "failed" ? { error: String(e.summary ?? "the run failed").slice(0, 400) } : e.state === "timed-out" ? { evidence: String(e.summary ?? "the run hit its wall-clock limit").slice(0, 400) } : {}),
  };
}

export function nodeDeps(root: string, record: MissionRecord, world: World, extra: Partial<TickDeps> = {}): TickDeps {
  const target = record.target;
  const eligible = async (): Promise<string[]> => {
    const all = await world.nodes();
    return target?.nodes?.length ? all.filter((n) => target.nodes!.includes(n)) : all;
  };
  const byKey = async (key: string): Promise<LedgerEntry | undefined> => (await world.ledger()).find((e) => e.missionKey === key);
  return {
    nowMs: () => world.nowMs(),
    freeSlots: async () => {
      const led = await world.ledger();
      const out: Record<string, number> = {};
      for (const n of await eligible()) {
        const limit = world.limitFor(n);
        const running = led.filter((e) => e.node === n && e.state === "running").length;
        out[n] = limit === undefined ? 64 : Math.max(0, limit - running);
      }
      return out;
    },
    launch: async (a) => {
      if (!target) return { ok: false, error: "the mission has no target cwd" };
      const spec = record.supervisor.specs[a.specId]!.spec;
      const task = (typeof spec.task === "object" && spec.task !== null ? spec.task : { goal: spec.goal }) as Record<string, unknown>;
      const withFeedback = a.feedback
        ? { ...task, goal: `${String(task.goal ?? spec.goal)}\n\nThe previous attempt failed. Fix this, do not repeat the same approach:\n${quoteUntrusted("failure-evidence", a.feedback, 1500)}` }
        : task;
      let res: Record<string, unknown>;
      try { res = await world.dispatch({ cwd: target.cwd, node: a.node, spec: withFeedback, missionKey: a.key, isolation: "clone" }); }
      catch (e) { return { ok: false, error: (e as Error).message, ambiguous: true }; }
      const r = res[a.node] as { runId?: unknown; ok?: unknown; error?: unknown; ackPending?: unknown } | undefined;
      if (r && typeof r.runId === "string" && r.ackPending !== true) return { ok: true, runId: r.runId };
      if (r && r.ackPending === true) return { ok: false, error: "launch ack not received", ambiguous: true };
      const err = String(r?.error ?? (res as { error?: unknown }).error ?? "dispatch refused").slice(0, 300);
      // A refusal (design gate, no-capacity, no-disk, bad cwd) means nothing launched.
      return { ok: false, error: err };
    },
    reconcile: async (a) => {
      const e = await byKey(a.key);
      if (!e) return { state: "unknown" };
      if (TERMINAL.has(e.state)) return { state: "finished", runId: e.runId, signals: signalsOf(e) };
      return { state: "running", runId: e.runId };
    },
    poll: async (running) => {
      const out: Awaited<ReturnType<TickDeps["poll"]>> = {};
      for (const r of running) {
        const e0 = (await world.ledger()).find((e) => e.runId === r.runId);
        if (!e0) {
          // Issue #244 review fix: an acknowledged run whose ledger write was lost is NOT stranded.
          // The run may be live on the node: probe via status (which reconciles the ledger as a side
          // effect); only beyond the conservative bound declare the launch presumed lost.
          if (!r.node) continue;
          try { await world.status(r.node, r.runId); } catch { /* probe failed; the bound still applies */ }
          const e1 = (await world.ledger()).find((x) => x.runId === r.runId);
          if (e1 && TERMINAL.has(e1.state)) { out[r.specId] = { runId: r.runId, signals: signalsOf(e1) }; continue; }
          if (e1) continue; // reconciled, still running
          if (world.nowMs() - (r.startedAtMs ?? 0) <= LOST_AFTER_MS) continue;
          out[r.specId] = { runId: r.runId, lost: `the launch is presumed lost: no ledger entry appeared for run ${r.runId} after ${LOST_AFTER_MS}ms (a status probe was made); a bounded re-attempt may follow` };
          continue;
        }
        if (!TERMINAL.has(e0.state)) { try { await world.status(e0.node, r.runId); } catch { continue; } }
        const e = (await world.ledger()).find((x) => x.runId === r.runId);
        if (e && TERMINAL.has(e.state)) out[r.specId] = { runId: r.runId, signals: signalsOf(e) };
      }
      return out;
    },
    ...extra,
  };
}
