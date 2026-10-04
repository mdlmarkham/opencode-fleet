/**
 * GitHub projection of the internal work graph (issue #132, slice T-1a): what to show on an issue,
 * decided as a pure function of the tasks, plus a small durable queue that delivers it.
 *
 * Direction is one way. The work graph (tasks.ts) is the source of truth for state, dependencies,
 * claims and retries; GitHub shows a view of it and nothing is read back here (that is T-3).
 * Delivery is idempotent (one status comment per issue, found by a hidden marker and edited in
 * place; only `fleet:*` labels are touched) and never on the execution critical path: planning is
 * pure, `drain` never throws, and a GitHub outage just leaves ops queued for the next drain.
 *
 * The GitHub client is an injected interface. This module holds no credentials and makes no
 * network calls; the adapter that implements the interface with the manager's token is a
 * separate piece.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { redactSecrets } from "./untrusted.js";
import type { Task } from "./tasks.js";

export const PROJECTION_LABEL_PREFIX = "fleet:";
export const PROJECTION_LABELS = ["fleet:in-progress", "fleet:blocked", "fleet:done", "fleet:failed"] as const;
export type ProjectionLabel = (typeof PROJECTION_LABELS)[number];

const MAX_TITLE = 120;
const MAX_ERROR = 160;
const MAX_ITEMS_PER_ISSUE = 100;

export const markerFor = (issue: number): string => `<!-- fleet-projection:issue:${issue} -->`;

/** Untrusted task text going into a GitHub comment: no secrets, no markers or HTML comments, no live @mentions, bounded, one line. */
export function sanitizeForGithub(text: string, max: number): string {
  const redacted = redactSecrets(String(text));
  const flat = redacted
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/@/g, "@​")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function line(t: Task, all: Map<string, Task>): string {
  const title = sanitizeForGithub(t.title, MAX_TITLE) || "(untitled)";
  switch (t.state) {
    case "done":
      return `- [x] \`${t.id}\` ${title}`;
    case "failed":
      return `- [ ] \`${t.id}\` ${title} — failed${t.error ? `: ${sanitizeForGithub(t.error, MAX_ERROR)}` : ""}`;
    case "claimed":
      return `- [ ] \`${t.id}\` ${title} — in progress`;
    default: {
      const waiting = t.deps.filter((d) => all.get(d)?.state !== "done");
      return `- [ ] \`${t.id}\` ${title}${waiting.length ? ` — waiting on ${waiting.map((d) => `\`${d}\``).join(", ")}` : ""}`;
    }
  }
}

/** The label that summarises a set of tasks, or none when there is nothing to say. */
export function summaryLabel(tasks: Task[]): ProjectionLabel | undefined {
  if (tasks.length === 0) return undefined;
  if (tasks.some((t) => t.state === "failed")) return "fleet:failed";
  if (tasks.every((t) => t.state === "done")) return "fleet:done";
  if (tasks.some((t) => t.state === "claimed")) return "fleet:in-progress";
  const all = new Map(tasks.map((t) => [t.id, t]));
  const anyReady = tasks.some((t) => t.state === "pending" && t.deps.every((d) => all.get(d)?.state === "done"));
  return anyReady ? "fleet:in-progress" : "fleet:blocked";
}

export interface IssueView {
  issue: number;
  body: string;
  bodyHash: string;
  label?: ProjectionLabel;
}

/** One view per issue that at least one task links to (`refs.issue`). Tasks with no issue are not projected. */
export function renderViews(tasks: Task[]): IssueView[] {
  const byIssue = new Map<number, Task[]>();
  for (const t of tasks) {
    const n = t.refs?.issue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    byIssue.set(n, [...(byIssue.get(n) ?? []), t]);
  }
  const all = new Map(tasks.map((t) => [t.id, t]));
  const views: IssueView[] = [];
  for (const [issue, ts] of [...byIssue].sort((a, b) => a[0] - b[0])) {
    const shown = ts.slice(0, MAX_ITEMS_PER_ISSUE);
    const done = ts.filter((t) => t.state === "done").length;
    const body = [
      markerFor(issue),
      `**Fleet progress** — ${done}/${ts.length} done`,
      "",
      ...shown.map((t) => line(t, all)),
      ...(ts.length > shown.length ? [`- … and ${ts.length - shown.length} more`] : []),
      "",
      "_Maintained automatically from the fleet work graph; edits here are overwritten._",
    ].join("\n");
    const label = summaryLabel(ts);
    views.push({ issue, body, bodyHash: createHash("sha256").update(body).digest("hex").slice(0, 16), ...(label ? { label } : {}) });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Planning: what differs from what we last delivered
// ---------------------------------------------------------------------------

export interface IssueProjectionState {
  bodyHash?: string;
  commentId?: number | string;
  label?: ProjectionLabel;
}
export type ProjectionState = Record<string, IssueProjectionState>;

export type ProjectionOp =
  | { kind: "comment"; issue: number; marker: string; body: string; bodyHash: string }
  | { kind: "labels"; issue: number; add: ProjectionLabel[]; remove: ProjectionLabel[] };

export function planProjection(tasks: Task[], prior: ProjectionState): ProjectionOp[] {
  const ops: ProjectionOp[] = [];
  for (const v of renderViews(tasks)) {
    const was = prior[String(v.issue)] ?? {};
    if (was.bodyHash !== v.bodyHash) ops.push({ kind: "comment", issue: v.issue, marker: markerFor(v.issue), body: v.body, bodyHash: v.bodyHash });
    if (was.label !== v.label) {
      ops.push({ kind: "labels", issue: v.issue, add: v.label ? [v.label] : [], remove: PROJECTION_LABELS.filter((l) => l !== v.label && (was.label === l || was.label === undefined)) });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Delivery: an injected client and a durable queue
// ---------------------------------------------------------------------------

export interface GitHubProjectionClient {
  /** Create the comment containing `marker`, or edit it in place when it exists. Returns the comment id. */
  upsertComment(issue: number, marker: string, body: string): Promise<{ commentId: number | string }>;
  /** Add and remove labels. Only `fleet:*` labels are ever passed. */
  setLabels(issue: number, add: string[], remove: string[]): Promise<void>;
}

export interface QueuedOp {
  op: ProjectionOp;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export const MAX_QUEUE = 500;
export const MAX_ATTEMPTS = 8;
const backoffMs = (attempts: number): number => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export interface ProjectionStore {
  state: ProjectionState;
  queue: QueuedOp[];
}

export function openProjectionStore(dir: string) {
  const file = join(dir, "projection.json");
  const load = async (): Promise<ProjectionStore> => {
    try {
      const v = JSON.parse(await readFile(file, "utf8")) as Partial<ProjectionStore>;
      return { state: v.state && typeof v.state === "object" ? v.state : {}, queue: Array.isArray(v.queue) ? v.queue : [] };
    } catch {
      return { state: {}, queue: [] };
    }
  };
  const save = async (s: ProjectionStore): Promise<void> => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await rename(tmp, file);
  };
  return { load, save, file };
}

/**
 * Plan against what has been delivered AND what is already queued (so a repeated call does not
 * stack duplicates), replacing a queued op for the same issue and kind with the newer one.
 */
export function enqueue(store: ProjectionStore, tasks: Task[], now: number): { store: ProjectionStore; added: number } {
  // Pretend queued ops were delivered, so only genuinely new differences are planned.
  const assumed: ProjectionState = JSON.parse(JSON.stringify(store.state));
  for (const q of store.queue) {
    const s = (assumed[String(q.op.issue)] ??= {});
    if (q.op.kind === "comment") s.bodyHash = q.op.bodyHash;
    else s.label = q.op.add[0];
  }
  const fresh = planProjection(tasks, assumed);
  const keep = store.queue.filter((q) => !fresh.some((f) => f.issue === q.op.issue && f.kind === q.op.kind));
  const queue = [...keep, ...fresh.map((op) => ({ op, attempts: 0, nextAttemptAt: now }))].slice(-MAX_QUEUE);
  return { store: { state: store.state, queue }, added: fresh.length };
}

export interface DrainResult {
  delivered: number;
  failed: number;
  dropped: number;
  pending: number;
}

/** Deliver due ops. Never throws: a client error requeues the op with backoff; after MAX_ATTEMPTS it is dropped and counted. */
export async function drain(store: ProjectionStore, client: GitHubProjectionClient, now: number): Promise<{ store: ProjectionStore; result: DrainResult }> {
  const state: ProjectionState = JSON.parse(JSON.stringify(store.state));
  const next: QueuedOp[] = [];
  const result: DrainResult = { delivered: 0, failed: 0, dropped: 0, pending: 0 };
  for (const q of store.queue) {
    if (q.nextAttemptAt > now) { next.push(q); continue; }
    try {
      const s = (state[String(q.op.issue)] ??= {});
      if (q.op.kind === "comment") {
        const r = await client.upsertComment(q.op.issue, q.op.marker, q.op.body);
        s.bodyHash = q.op.bodyHash;
        s.commentId = r.commentId;
      } else {
        await client.setLabels(q.op.issue, q.op.add, q.op.remove);
        s.label = q.op.add[0];
      }
      result.delivered++;
    } catch (e) {
      const attempts = q.attempts + 1;
      result.failed++;
      if (attempts >= MAX_ATTEMPTS) { result.dropped++; continue; }
      next.push({ op: q.op, attempts, nextAttemptAt: now + backoffMs(attempts), lastError: sanitizeForGithub((e as Error)?.message ?? "error", 200) });
    }
  }
  result.pending = next.length;
  return { store: { state, queue: next }, result };
}

/** One call for a caller: plan, queue and deliver. Never throws, and never touches the work graph. */
export async function project(dir: string, tasks: Task[], client: GitHubProjectionClient, now: number = Date.now()): Promise<DrainResult & { added: number }> {
  const io = openProjectionStore(dir);
  try {
    const loaded = await io.load();
    const { store: queued, added } = enqueue(loaded, tasks, now);
    const { store: done, result } = await drain(queued, client, now);
    await io.save(done);
    return { ...result, added };
  } catch {
    return { delivered: 0, failed: 0, dropped: 0, pending: 0, added: 0 };
  }
}

