/**
 * Internal work graph for missions (issue #132, slice T-0).
 *
 * A small, boring state machine: typed items, dependency edges, an atomic claim with stale-claim
 * recovery, ready/blocked queries and an append-only journal. State is the fold of the journal
 * (`tasks.jsonl`, schemaVersion on the first line), so every change is one appended line; a torn
 * final line from a crash is dropped on the next write, never trusted. One writer at a time per
 * directory (a lock file with stale-holder recovery). GitHub is a projection of this store (T-1),
 * never the other way round, and nothing here talks to the network.
 *
 * The directory is the caller's: a mission directory under `.fleet/missions/` once #123 lands.
 */

import { appendFile, mkdir, open, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";

export const TASKS_SCHEMA_VERSION = 1;
export const TASK_TYPES = ["spec", "checkpoint", "question"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskState = "pending" | "claimed" | "done" | "failed";

export const MAX_TASKS = 2000;
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LEASE_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface TaskRefs {
  issue?: number;
  pr?: number;
}

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  state: TaskState;
  /** Ids that must be `done` before this task is ready. */
  deps: string[];
  refs?: TaskRefs;
  /** Free-form, JSON-serialisable payload (spec text, verdict, question). Treat as untrusted text. */
  data?: unknown;
  claim?: { by: string; at: string; leaseMs: number };
  /** Times this task has been claimed; a retry after `fail` or an expired claim counts again. */
  attempts: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInput {
  id?: string;
  type: TaskType;
  title: string;
  deps?: string[];
  refs?: TaskRefs;
  data?: unknown;
}

export interface JournalEvent {
  seq: number;
  ts: string;
  op: "create" | "update" | "link" | "claim" | "claim-expired" | "release" | "complete" | "fail" | "retry";
  id: string;
  [k: string]: unknown;
}

export class TaskError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface TrackerDeps {
  now?: () => number;
  /** Lock-holder liveness; injectable for tests. */
  pidAlive?: (pid: number) => boolean;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Pure fold: journal -> tasks
// ---------------------------------------------------------------------------

export interface Folded {
  tasks: Map<string, Task>;
  lastSeq: number;
  /** Byte length of the journal's valid prefix (a torn tail is excluded). */
  validBytes: number;
  torn: boolean;
}

function apply(tasks: Map<string, Task>, e: JournalEvent): void {
  const t = tasks.get(e.id);
  switch (e.op) {
    case "create": {
      tasks.set(e.id, {
        id: e.id,
        type: e.type as TaskType,
        title: String(e.title),
        state: "pending",
        deps: Array.isArray(e.deps) ? (e.deps as string[]) : [],
        ...(isObj(e.refs) ? { refs: e.refs as TaskRefs } : {}),
        ...(e.data !== undefined ? { data: e.data } : {}),
        attempts: 0,
        createdAt: e.ts,
        updatedAt: e.ts,
      });
      return;
    }
    case "update":
      if (!t) return;
      if (typeof e.title === "string") t.title = e.title;
      if (isObj(e.refs)) t.refs = { ...t.refs, ...(e.refs as TaskRefs) };
      if (e.data !== undefined) t.data = e.data;
      break;
    case "link":
      if (!t) return;
      if (typeof e.dep === "string" && !t.deps.includes(e.dep)) t.deps.push(e.dep);
      break;
    case "claim":
      if (!t) return;
      t.state = "claimed";
      t.claim = { by: String(e.by), at: e.ts, leaseMs: Number(e.leaseMs) };
      t.attempts += 1;
      break;
    case "claim-expired":
    case "release":
    case "retry":
      if (!t) return;
      t.state = "pending";
      delete t.claim;
      if (e.op === "retry") delete t.error;
      break;
    case "complete":
      if (!t) return;
      t.state = "done";
      delete t.claim;
      if (e.result !== undefined) t.result = e.result;
      break;
    case "fail":
      if (!t) return;
      t.state = "failed";
      delete t.claim;
      t.error = String(e.error ?? "failed");
      break;
    default:
      return;
  }
  if (t) t.updatedAt = e.ts;
}

/** Fold a journal's text. A malformed FINAL line is a torn write and is dropped; anywhere else it is corruption. */
export function foldJournal(text: string): Folded {
  const tasks = new Map<string, Task>();
  let lastSeq = 0;
  let validBytes = 0;
  let torn = false;
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const lineBytes = Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
    if (line.trim() === "") {
      if (!isLast) validBytes = offset + lineBytes;
      offset += lineBytes;
      continue;
    }
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (isLast) {
        torn = true;
        break;
      }
      throw new TaskError("corrupt", `tasks journal is corrupt at line ${i + 1}`);
    }
    if (isLast && !text.endsWith("\n")) {
      // Parsed but never newline-terminated: it may still be a partial write; drop it to be safe.
      torn = true;
      break;
    }
    if (!isObj(v)) throw new TaskError("corrupt", `tasks journal line ${i + 1} is not an object`);
    if (i === 0 && "schemaVersion" in v) {
      if (v.schemaVersion !== TASKS_SCHEMA_VERSION) throw new TaskError("schema", `unsupported tasks schemaVersion ${String(v.schemaVersion)}`);
    } else {
      const e = v as unknown as JournalEvent;
      if (typeof e.seq !== "number" || typeof e.op !== "string" || typeof e.id !== "string") throw new TaskError("corrupt", `tasks journal line ${i + 1} is malformed`);
      lastSeq = Math.max(lastSeq, e.seq);
      apply(tasks, e);
    }
    validBytes = offset + lineBytes;
    offset += lineBytes;
  }
  return { tasks, lastSeq, validBytes, torn };
}

/** True when `from` can reach `target` through dependency edges (cycle check). */
function reaches(tasks: Map<string, Task>, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (tasks.get(from)?.deps ?? []).some((d) => reaches(tasks, d, target, seen));
}

const stale = (t: Task, now: number): boolean => t.state === "claimed" && !!t.claim && Date.parse(t.claim.at) + t.claim.leaseMs <= now;

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

export interface TaskTracker {
  create(input: CreateInput): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  list(filter?: { state?: TaskState; type?: TaskType }): Promise<Task[]>;
  update(id: string, patch: { title?: string; refs?: TaskRefs; data?: unknown }): Promise<Task>;
  link(id: string, dep: string): Promise<Task>;
  /** Claim a specific ready task, or (no id) the oldest ready one. Null when nothing is claimable. */
  claim(by: string, opts?: { id?: string; leaseMs?: number }): Promise<Task | null>;
  release(id: string, by: string): Promise<Task>;
  complete(id: string, by: string, result?: unknown): Promise<Task>;
  fail(id: string, by: string, error: string): Promise<Task>;
  retry(id: string): Promise<Task>;
  ready(): Promise<Task[]>;
  blocked(): Promise<Array<{ task: Task; waitingOn: string[] }>>;
  journal(sinceSeq?: number): Promise<JournalEvent[]>;
}

export function openTaskTracker(dir: string, deps: TrackerDeps = {}): TaskTracker {
  const now = deps.now ?? Date.now;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 5000;
  const lockStaleMs = deps.lockStaleMs ?? 30_000;
  const file = join(dir, "tasks.jsonl");
  const lockFile = join(dir, "tasks.lock");

  async function acquire(): Promise<() => Promise<void>> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        const h = await open(lockFile, "wx", 0o600);
        await h.writeFile(JSON.stringify({ pid: process.pid, ts: now() }));
        await h.close();
        return async () => { await rm(lockFile, { force: true }); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      try {
        const holder = JSON.parse(await readFile(lockFile, "utf8")) as { pid?: number; ts?: number };
        const dead = typeof holder.pid === "number" && !pidAlive(holder.pid);
        const old = typeof holder.ts === "number" && now() - holder.ts > lockStaleMs;
        if (dead || old) await rm(lockFile, { force: true });
      } catch {
        /* the lock was just released, or is half-written: retry */
      }
      if (Date.now() > deadline) throw new TaskError("lock", "timed out waiting for the tasks lock");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function read(): Promise<{ text: string; folded: Folded }> {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { text, folded: foldJournal(text) };
  }

  /** Run `fn` under the lock against the folded state; it returns the events to append. */
  async function write<T>(fn: (tasks: Map<string, Task>, at: number) => { events: Array<Omit<JournalEvent, "seq" | "ts">>; out: T }): Promise<T> {
    const release = await acquire();
    try {
      const { text, folded } = await read();
      if (folded.torn) await truncate(file, folded.validBytes);
      const at = now();
      const { events, out } = fn(folded.tasks, at);
      if (events.length > 0) {
        if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new TaskError("full", "tasks journal is at its size cap");
        let seq = folded.lastSeq;
        let chunk = text.trim() === "" || folded.validBytes === 0 ? `${JSON.stringify({ schemaVersion: TASKS_SCHEMA_VERSION })}\n` : "";
        for (const e of events) chunk += `${JSON.stringify({ seq: ++seq, ts: new Date(at).toISOString(), ...e })}\n`;
        await appendFile(file, chunk, { mode: 0o600 });
      }
      return out;
    } finally {
      await release();
    }
  }

  const need = (tasks: Map<string, Task>, id: string): Task => {
    const t = tasks.get(id);
    if (!t) throw new TaskError("not-found", `no such task: ${id}`);
    return t;
  };
  const depsDone = (tasks: Map<string, Task>, t: Task): boolean => t.deps.every((d) => tasks.get(d)?.state === "done");
  const owned = (t: Task, by: string): void => {
    if (t.state !== "claimed" || t.claim?.by !== by) throw new TaskError("not-owner", `task ${t.id} is not claimed by ${by}`);
  };
  /** Re-fold after an append to hand back the task as stored (exactly what a reader will see). */
  const after = async (id: string): Promise<Task> => need((await read()).folded.tasks, id);

  return {
    async create(input) {
      if (!(TASK_TYPES as readonly string[]).includes(input.type)) throw new TaskError("invalid", `type must be one of ${TASK_TYPES.join("|")}`);
      if (typeof input.title !== "string" || input.title.trim() === "" || input.title.length > 500) throw new TaskError("invalid", "title must be 1-500 characters");
      if (input.id !== undefined && !ID.test(input.id)) throw new TaskError("invalid", "id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
      const id = await write((tasks) => {
        if (tasks.size >= MAX_TASKS) throw new TaskError("full", `at most ${MAX_TASKS} tasks per mission`);
        const newId = input.id ?? `T-${tasks.size + 1}`;
        if (tasks.has(newId)) throw new TaskError("exists", `task ${newId} already exists`);
        const deps = [...new Set(input.deps ?? [])];
        for (const d of deps) if (!tasks.has(d)) throw new TaskError("not-found", `unknown dependency: ${d}`);
        return { events: [{ op: "create", id: newId, type: input.type, title: input.title, deps, ...(input.refs ? { refs: input.refs } : {}), ...(input.data !== undefined ? { data: input.data } : {}) }], out: newId };
      });
      return after(id);
    },
    async get(id) {
      return (await read()).folded.tasks.get(id);
    },
    async list(filter = {}) {
      return [...(await read()).folded.tasks.values()].filter((t) => (!filter.state || t.state === filter.state) && (!filter.type || t.type === filter.type));
    },
    async update(id, patch) {
      await write((tasks) => {
        need(tasks, id);
        if (patch.title !== undefined && (typeof patch.title !== "string" || patch.title.trim() === "" || patch.title.length > 500)) throw new TaskError("invalid", "title must be 1-500 characters");
        return { events: [{ op: "update", id, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.refs ? { refs: patch.refs } : {}), ...(patch.data !== undefined ? { data: patch.data } : {}) }], out: undefined };
      });
      return after(id);
    },
    async link(id, dep) {
      await write((tasks) => {
        need(tasks, id);
        need(tasks, dep);
        if (reaches(tasks, dep, id)) throw new TaskError("cycle", `linking ${id} -> ${dep} would create a dependency cycle`);
        return { events: [{ op: "link", id, dep }], out: undefined };
      });
      return after(id);
    },
    async claim(by, opts = {}) {
      if (typeof by !== "string" || by.trim() === "") throw new TaskError("invalid", "claim needs a claimant");
      const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
      if (!Number.isFinite(leaseMs) || leaseMs < 1000) throw new TaskError("invalid", "leaseMs must be at least 1000");
      const id = await write((tasks, at) => {
        const events: Array<Omit<JournalEvent, "seq" | "ts">> = [];
        const candidates = opts.id ? [need(tasks, opts.id)] : [...tasks.values()];
        for (const t of candidates) {
          const expired = stale(t, at);
          if (t.state !== "pending" && !expired) continue;
          if (!depsDone(tasks, t)) continue;
          if (expired) events.push({ op: "claim-expired", id: t.id, was: t.claim?.by });
          events.push({ op: "claim", id: t.id, by, leaseMs });
          return { events, out: t.id as string | null };
        }
        return { events, out: null };
      });
      return id ? after(id) : null;
    },
    async release(id, by) {
      await write((tasks) => {
        owned(need(tasks, id), by);
        return { events: [{ op: "release", id, by }], out: undefined };
      });
      return after(id);
    },
    async complete(id, by, result) {
      await write((tasks) => {
        owned(need(tasks, id), by);
        return { events: [{ op: "complete", id, by, ...(result !== undefined ? { result } : {}) }], out: undefined };
      });
      return after(id);
    },
    async fail(id, by, error) {
      await write((tasks) => {
        owned(need(tasks, id), by);
        return { events: [{ op: "fail", id, by, error: String(error).slice(0, 2000) }], out: undefined };
      });
      return after(id);
    },
    async retry(id) {
      await write((tasks) => {
        const t = need(tasks, id);
        if (t.state !== "failed") throw new TaskError("state", `task ${id} is ${t.state}, only a failed task can be retried`);
        return { events: [{ op: "retry", id }], out: undefined };
      });
      return after(id);
    },
    async ready() {
      const { tasks } = (await read()).folded;
      const at = now();
      return [...tasks.values()].filter((t) => (t.state === "pending" || stale(t, at)) && depsDone(tasks, t));
    },
    async blocked() {
      const { tasks } = (await read()).folded;
      return [...tasks.values()]
        .filter((t) => t.state === "pending")
        .map((t) => ({ task: t, waitingOn: t.deps.filter((d) => tasks.get(d)?.state !== "done") }))
        .filter((b) => b.waitingOn.length > 0);
    },
    async journal(sinceSeq = 0) {
      const { text } = await read();
      foldJournal(text); // validates
      return text.split("\n").filter((l) => l.startsWith("{") && !l.startsWith('{"schemaVersion"')).flatMap((l) => {
        try {
          const e = JSON.parse(l) as JournalEvent;
          return e.seq > sinceSeq ? [e] : [];
        } catch {
          return [];
        }
      });
    },
  };
}
