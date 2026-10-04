/**
 * Run ledger — durable record of in-flight fleet work.
 *
 * Every dispatch writes an entry BEFORE the invoke starts and updates it on
 * completion. If either the agent session or the worker dies mid-run, the
 * ledger preserves the fact that work was in flight, so a later session can
 * discover it via fleet_resume and pick it up (diff/sync) or discard it.
 *
 * Ledger file: one JSON per node owner (gateway-local), plus a per-node copy
 * on each worker so worker-side state is visible even if the manager died.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskSpec } from "./spec.js";
import { shq } from "./shell.js";
import { interpretLiveness } from "./recovery.js";
import { SSH_ARGS, sshPrefix } from "./ssh.js";

export type RunState =
  | "running"
  | "completed"
  | "failed"
  | "failed-verification"
  | "timed-out"
  | "discarded";

export interface LedgerEntry {
  runId: string;
  node: string;
  cwd: string;
  prompt: string;
  model?: string;
  transport?: "http" | "acp";
  /** Worker engine harness (issue #30): opencode (default) or pi. */
  harness?: string;
  /** Pi model ref (harness=pi). */
  piModel?: string;
  /** Recorded worker pid, when the node ack carried one — enables engine-independent liveness/cancel (issue #30). */
  pid?: number;
  startedAt: string;
  updatedAt: string;
  state: RunState;
  /** Process exit status of the worker, when known (issue #37). */
  exitCode?: number;
  /** The run's verification-gate outcome (issue #62): false = the `expect` gate FAILED.
   *  Absent = no gate was configured or the outcome is unknown (backward compatible). */
  verified?: boolean;
  /** The node's verify-gate details, persisted so a FAILED gate survives node state cleanup. */
  verifyDetails?: unknown;
  /** The isolated clone the run worked in (issue #41); pass it to fleet_sync. */
  runCwd?: string;
  /** The branch fleet/<runId> created in the run clone. */
  branch?: string;
  summary?: string;
  sessionId?: string;
  handRaised?: boolean;
  question?: string;
  /** Env var NAMES dispatched with (values never stored in the ledger). */
  env?: string[];
  ref?: { branch?: string; commit?: string };
  /** The structured task spec the run was dispatched with (issue #65 slice 1).
   *  Absent for prompt-only dispatches (backward compatible: the key is not
   *  materialized when no spec was given). */
  spec?: TaskSpec;
  /** Design-gate objections the caller acknowledged to dispatch anyway (issue #117), with their reasons. */
  gateAcknowledged?: Array<{ objectionId: string; reason: string }>;
}

const LEDGER_FILE = "fleet-runs.json";

export function ledgerPath(rootDir: string): string {
  return join(rootDir, LEDGER_FILE);
}

export async function loadLedger(rootDir: string): Promise<LedgerEntry[]> {
  try {
    const raw = await readFile(ledgerPath(rootDir), "utf8");
    const parsed = JSON.parse(raw) as { runs?: LedgerEntry[] };
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

export async function saveLedger(rootDir: string, runs: LedgerEntry[]): Promise<void> {
  const p = ledgerPath(rootDir);
  await mkdir(dirname(p), { recursive: true });
  // The ledger holds full prompts: keep it private, and write atomically so a
  // crash mid-write cannot leave a truncated file.
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ runs }, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, p);
}

/**
 * Terminal states: only these are subject to the retention cap. `timed-out` is
 * deliberately NOT terminal: a relay timeout does not mean the worker stopped
 * (fleet_resume treats it as incomplete), so its recovery record is kept until
 * the run is reconciled to completed/failed/discarded/failed-verification.
 */
const TERMINAL: ReadonlySet<RunState> = new Set(["completed", "failed", "failed-verification", "discarded"]);

/** How many terminal runs to keep. In-flight (`running`) entries are never evicted. */
export const LEDGER_TERMINAL_CAP = 200;

/** Apply the retention policy: keep every non-terminal run plus the most recent terminal ones. */
export function capLedger(runs: LedgerEntry[], cap = LEDGER_TERMINAL_CAP): LedgerEntry[] {
  const newestFirst = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  let terminalSeen = 0;
  return newestFirst.filter((r) => {
    if (!TERMINAL.has(r.state)) return true;
    return ++terminalSeen <= cap;
  });
}

/**
 * Which run does `fleet_abort` mean when given only a sessionId (issue #63)?
 * Entries must match the session AND the node. Prefers the newest non-terminal
 * run (running, timed-out, ... — a worker may still be alive), else the newest
 * match overall. Independent of the ledger's stored order.
 */
export function resolveAbortRunId(runs: LedgerEntry[], sessionId: string, nodeNames: string[]): string | undefined {
  const hits = runs
    .filter((r) => r.sessionId === sessionId && nodeNames.includes(r.node))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return (hits.find((r) => !TERMINAL.has(r.state)) ?? hits[0])?.runId;
}

/** The newest run recorded for this node + checkout directory (ledger order independent), if any. */
export function latestRunFor(runs: LedgerEntry[], nodeNames: string[], cwd: string): LedgerEntry | undefined {
  return runs
    .filter((r) => nodeNames.includes(r.node) && (r.cwd === cwd || r.runCwd === cwd) && r.state !== "discarded")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0];
}

export interface SyncGate {
  allow: boolean;
  /** Why the sync is refused, or a caution to surface alongside an allowed one. */
  reason?: string;
  runId?: string;
  verified: boolean | null;
}

/**
 * Whether the work on a node may be published (issue #65): a run whose
 * verification gate FAILED (`verified === false`, state failed-verification) is
 * refused unless the operator overrides; an unknown outcome (`null`: no gate was
 * configured, or no run is recorded) is allowed with a caution, or refused when
 * the operator requires verified work. Never silently treats null as true.
 */
export function syncGate(entry: LedgerEntry | undefined, opts: { allowUnverified?: boolean; requireVerified?: boolean }): SyncGate {
  if (!entry) {
    return opts.requireVerified && !opts.allowUnverified
      ? { allow: false, verified: null, reason: "sync.requireVerified is set and no fleet run is recorded for this node and checkout, so there is no verification to rely on (pass allowUnverified to override)" }
      : { allow: true, verified: null, reason: "no fleet run is recorded for this node and checkout; the work is unverified" };
  }
  const failed = entry.verified === false || entry.state === "failed-verification";
  if (failed) {
    return opts.allowUnverified
      ? { allow: true, verified: false, runId: entry.runId, reason: `overridden: run ${entry.runId} FAILED its verification gate` }
      : { allow: false, verified: false, runId: entry.runId, reason: `run ${entry.runId} failed its verification gate (see fleet_run_status verifyDetails); refusing to publish unverified work. Fix it, or pass allowUnverified: true to override` };
  }
  if (entry.verified === true) return { allow: true, verified: true, runId: entry.runId };
  return opts.requireVerified && !opts.allowUnverified
    ? { allow: false, verified: null, runId: entry.runId, reason: `sync.requireVerified is set and run ${entry.runId} has no verification result (dispatch with expect/spec.verify, or pass allowUnverified)` }
    : { allow: true, verified: null, runId: entry.runId, reason: `run ${entry.runId} has no verification result; the work is unverified` };
}

/** A recipe outcome never reports success for a run whose gate failed or whose process failed. */
export function recipeSuccess(reported: boolean, entry: LedgerEntry | undefined): { success: boolean; overridden: boolean } {
  if (!reported || !entry) return { success: reported, overridden: false };
  const bad = entry.verified === false || entry.state === "failed-verification" || entry.state === "failed";
  return bad ? { success: false, overridden: true } : { success: true, overridden: false };
}

// Writers to the same ledger file are serialized in-process: fan-out dispatch
// upserts concurrently, and an unserialized read-modify-write loses updates
// (and raced on a shared temp file name).
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(path, next);
  const clear = () => { if (locks.get(path) === next) locks.delete(path); };
  next.then(clear, clear);
  return next;
}

export function upsertRun(rootDir: string, entry: LedgerEntry): Promise<void> {
  return withLock(ledgerPath(rootDir), async () => {
    const runs = await loadLedger(rootDir);
    const i = runs.findIndex((r) => r.runId === entry.runId);
    if (i >= 0) runs[i] = entry;
    else runs.push(entry);
    await saveLedger(rootDir, capLedger(runs));
  });
}

export interface DispatchOutcome {
  timedOut: boolean;
  /** The silent-death reconcile already recorded this run as failed. */
  reconciledDead: boolean;
  parsed: {
    ok?: boolean;
    summary?: string;
    sessionId?: string;
    handRaised?: boolean;
    question?: string;
    /** The node's verification-gate outcome (issue #62), when a gate was configured. */
    verified?: boolean;
    verifyDetails?: unknown;
  };
}

/**
 * Final ledger entry for a synchronous dispatch: the SAME run with its new
 * state (startedAt/engine/pid preserved), never a fresh entry, and never
 * overriding a silent-death failure with timed-out.
 *
 * The run's `verified` outcome is recorded on the entry and the state
 * derivation consults it (issue #62 review). Process-level failures keep
 * their state ("failed"/"timed-out"); the would-be "completed" branch refuses
 * to launder a FAILED verification gate: verified === false =>
 * "failed-verification", so a clean exit that produced nothing is never
 * persisted as a completed run. verified absent/true keeps "completed"
 * (backward compatible), and verifyDetails is persisted so the failure
 * survives node state cleanup.
 */
export function outcomeEntry(base: LedgerEntry, o: DispatchOutcome, now: string = new Date().toISOString()): LedgerEntry {
  const state: RunState =
    o.reconciledDead
      ? "failed"
      : o.timedOut
        ? "timed-out"
        : o.parsed.ok === false
          ? "failed"
          : o.parsed.verified === false
            ? "failed-verification"
            : "completed";
  return {
    ...base,
    updatedAt: now,
    state,
    summary: o.reconciledDead ? "run died without completion record (silent death)" : o.parsed.summary,
    sessionId: o.parsed.sessionId,
    handRaised: o.parsed.handRaised,
    question: o.parsed.question,
    verified: o.parsed.verified ?? undefined,
    verifyDetails: o.parsed.verifyDetails,
  };
}

export function newRunId(): string {
  // Unguessable (issue #32): the id becomes part of node-side file paths.
  return `run-${randomUUID()}`;
}

/**
 * Probe a node for the live state of a recorded run: is the worker process
 * active, and does the checkout have uncommitted changes?
 *
 * Issue #30 finding I: the old probe only matched `opencode` processes, so a
 * live Pi worker was classified dead. Now it is engine-independent: it checks
 * the recorded pid directly (opts.pid) and, as a fallback, greps for BOTH
 * opencode and pi processes.
 */
export async function probeRun(
  nodeHost: string,
  cwd: string,
  opts: { harness?: string; pid?: number } = {},
): Promise<{ procRunning: boolean; procs?: string[]; uncommitted?: number; error?: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const pidCheck = opts.pid
      ? `kill -0 ${opts.pid} 2>/dev/null && echo "PIDALIVE ${opts.pid}" || true`
      : "true";
    const cmd = [
      pidCheck,
      `ps -eo pid,etime,command | grep -iE "[o]pencode|[p]i -p " | grep -vE "grep|opencode-fleet|node-activity" | head -5 || true`,
      `echo "---UNCOMMITTED---"`,
      `cd ${shq(cwd)} 2>/dev/null && git status --porcelain 2>/dev/null | wc -l || echo "-1"`,
    ].join(";");
    const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), cmd], { timeout: 30_000 });
    const [procPartRaw, uncommittedPart] = stdout.split("---UNCOMMITTED---\n");
    const procPart = procPartRaw ?? "";
    // Issue #30 finding I: engine-independent liveness (recorded pid OR any
    // matching opencode/pi process line), extracted as a pure helper.
    const { alive, procs } = interpretLiveness(procPart, opts.pid);
    const uncommitted = parseInt((uncommittedPart ?? "").trim(), 10);
    return {
      procRunning: alive,
      procs,
      uncommitted: Number.isFinite(uncommitted) ? uncommitted : -1,
    };
  } catch (err) {
    return { procRunning: false, error: (err as Error).message };
  }
}

function procLines(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}
/**
 * Split a file into base64 chunks sized for the node channel (~48KB decoded
 * per chunk keeps the invoke params well under message limits).
 */
export function chunkBuffer(buf: Buffer, chunkBytes = 48 * 1024): Array<{ index: number; data: string }> {
  const b64 = buf.toString("base64");
  // base64 expands 4/3; take decoded-chunk-bytes worth of base64 chars.
  const per = Math.ceil((chunkBytes * 4) / 3);
  const chunks: Array<{ index: number; data: string }> = [];
  for (let i = 0; i < b64.length; i += per) {
    chunks.push({ index: chunks.length, data: b64.slice(i, i + per) });
  }
  return chunks;
}
