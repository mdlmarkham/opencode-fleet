/**
 * fleet_board (agentic-UI gap): ONE call that renders the whole fleet's state.
 *
 * Why this exists: the fleet had 21 tools but no *view*. Monitoring meant asking
 * the agent, and the agent polling SSH/`fleet_run_status` per run — which bleeds
 * tokens for no new information (the #139 observation: two 10-minute `sleep`
 * loops watching a run that takes 12+ minutes to finish). A board collapses that
 * to a single bounded read.
 *
 * Pure where possible: the rendering + classification here are pure functions of
 * the ledger rows + live statuses, so they unit-test with no node.
 */

import type { LedgerEntry } from "./ledger.js";
import type { Task, TaskState } from "./tasks.js";

/**
 * A run id for the human line (issue #310). Ids longer than 20 chars are shown as prefix + "…" + 8-char suffix,
 * so a shortened id is VISIBLY shortened (a bare prefix looked complete, and pasting it into fleet_run_status
 * answered "never-started" for a live run) and two ids that share a prefix still differ. The full id is always in
 * the structured `runs` the board returns; never act on the text line's id when it contains "…".
 */
export function shortRunId(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 16)}…${id.slice(-8)}`;
}

/** How a run is classified for the human glance. */
export type BoardBucket = "in-flight" | "needs-you" | "landed" | "failed" | "stale";

export interface BoardRow {
  runId: string;
  node: string;
  issue?: number;
  engine: string;
  state: string;
  ageMs: number;
  /** verified gate outcome: true / false / null (no gate or unknown). */
  verified: boolean | null;
  bucket: BoardBucket;
  note?: string;
  /** The work-graph task this run belongs to, when the join finds one (issue #132). */
  taskId?: string;
  taskState?: TaskState;
}

/**
 * Join a run to its work-graph task. The link is the ISSUE number: the ledger
 * entry carries it (from the prompt/spec) and the task carries it in `refs.issue`.
 * Without a link we say so rather than guess; the board must not claim a run
 * belongs to a task it cannot prove.
 */
export function linkTask(issue: number | undefined, tasks: Task[]): Task | undefined {
  if (issue === undefined) return undefined;
  return tasks.find((t) => t.refs?.issue === issue);
}

/** Extract an issue number from a run's prompt/spec if one is referenced. */
export function issueFromEntry(e: LedgerEntry): number | undefined {
  const hay = `${e.prompt ?? ""}`;
  const m = hay.match(/#(\d{1,5})\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Classify one run. `now` is injected so the function is deterministic in tests.
 *  - terminal states (completed/failed-verification/aborted/discarded) => landed/failed
 *  - a run still "running" older than `staleMs` with no completion record => stale
 *  - a run that finished but whose gate FAILED, or that hand-raised => needs-you
 *  - otherwise running => in-flight
 */
export function classify(entry: LedgerEntry, now: number, staleMs = 45 * 60_000): BoardRow {
  const started = Date.parse(entry.startedAt);
  const ageMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const verified = entry.verified === undefined ? null : entry.verified;
  const base = {
    runId: entry.runId,
    node: entry.node,
    ...(issueFromEntry(entry) !== undefined ? { issue: issueFromEntry(entry) } : {}),
    engine: entry.harness ?? "opencode",
    state: entry.state,
    ageMs,
    verified,
  };
  if (entry.handRaised) return { ...base, bucket: "needs-you", note: "hand-raise: needs an answer" };
  if (entry.state === "failed-verification") return { ...base, bucket: "needs-you", note: "verification gate FAILED" };
  if (entry.state === "failed") return { ...base, bucket: "failed" };
  if (entry.state === "completed") return { ...base, bucket: "landed" };
  // still running
  if (ageMs > staleMs) return { ...base, bucket: "stale", note: `no completion after ${Math.round(ageMs / 60000)}m` };
  return { ...base, bucket: "in-flight" };
}

export interface BoardOptions {
  now?: number;
  staleMs?: number;
  /** Show only these buckets (default: everything except landed). */
  buckets?: BoardBucket[];
  /** The work graph (issue #132), when available, to join plan state onto runs. */
  tasks?: Task[];
}

/** One bounded, human-readable board. Pure: takes rows, returns a string. */
export function renderBoard(entries: LedgerEntry[], opts: BoardOptions = {}): { text: string; counts: Record<BoardBucket, number>; runs: Array<{ runId: string; bucket: BoardBucket; node: string; engine: string; state: string; ageSeconds: number; verified: boolean | null; issue?: number; note?: string }> } {
  const now = opts.now ?? Date.now();
  const tasks = opts.tasks ?? [];
  const rows = entries.map((e) => {
    const row = classify(e, now, opts.staleMs);
    const task = linkTask(row.issue, tasks);
    return task ? { ...row, taskId: task.id, taskState: task.state } : row;
  });
  const counts: Record<BoardBucket, number> = { "in-flight": 0, "needs-you": 0, landed: 0, failed: 0, stale: 0 };
  for (const r of rows) counts[r.bucket]++;

  // Default view hides `landed` (the quiet majority) so the board stays glanceable.
  const show = opts.buckets ?? (["needs-you", "stale", "failed", "in-flight"] as BoardBucket[]);
  const visible = rows
    .filter((r) => show.includes(r.bucket))
    .sort((a, b) => b.ageMs - a.ageMs);

  const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
  const ver = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✗");
  // A plan-vs-execution mismatch is worth surfacing: a task the graph believes
  // is claimed/done whose run did not verify (or vice versa) is a real signal.
  const mismatch = (r: BoardRow): string => {
    if (r.taskState === undefined) return "";
    if (r.taskState === "done" && r.verified === false) return " task=done but gate FAILED";
    if (r.taskState === "claimed" && r.bucket === "failed") return " task=claimed but run failed";
    return "";
  };
  // Terminal history (issue #295): the ledger keeps last-200 finished runs, but
  // the board only showed the current snapshot. Sum the terminal states from the
  // SAME entries renderBoard already received — no new ledger read, no node call.
  // A landed run (state=completed) counts as completed; failed and
  // failed-verification are counted by their own state, visible regardless of
  // whether the bucket rows are shown.
  const history = (state: string): number => entries.filter((e) => e.state === state).length;
  const lines: string[] = [
    `fleet board — ${counts["in-flight"]} in-flight, ${counts["needs-you"]} need-you, ` +
      `${counts.stale} stale, ${counts.failed} failed, ${counts.landed} landed` +
      ` · history: ${history("completed")} completed, ${history("failed")} failed, ` +
      `${history("failed-verification")} failed-verification` +
      (tasks.length ? ` · graph: ${tasks.filter((t) => t.state === "pending").length} pending, ` +
        `${tasks.filter((t) => t.state === "claimed").length} claimed` : ""),
    "",
  ];
  if (visible.length === 0) {
    lines.push("(nothing needs attention)");
  } else {
    for (const r of visible) {
      lines.push(
        `[${r.bucket}] #${r.issue ?? "?"}${r.taskId ? ` task=${r.taskState}` : ""} ${shortRunId(r.runId)} ` +
          `${r.engine} ${r.node} ${mins(r.ageMs)} state=${r.state} verified=${ver(r.verified)}` +
          `${mismatch(r)}${r.note ? ` — ${r.note}` : ""}`,
      );
    }
  }
  // The structured view carries the FULL ids: that is what an agent copies into the id-based follow-ups.
  const runs = visible.slice(0, 200).map((r) => ({
    runId: r.runId, bucket: r.bucket, node: r.node, engine: r.engine, state: r.state,
    ageSeconds: Math.round(r.ageMs / 1000), verified: r.verified,
    ...(r.issue !== undefined ? { issue: r.issue } : {}),
    ...(r.note ? { note: r.note } : {}),
  }));
  return { text: lines.join("\n"), counts, runs };
}
