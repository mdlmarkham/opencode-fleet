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
import { shq } from "./shell.js";
import { interpretLiveness } from "./recovery.js";
import { SSH_ARGS } from "./ssh.js";

export type RunState = "running" | "completed" | "failed" | "timed-out" | "discarded";

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
  summary?: string;
  sessionId?: string;
  handRaised?: boolean;
  question?: string;
  /** Env var NAMES dispatched with (values never stored in the ledger). */
  env?: string[];
  ref?: { branch?: string; commit?: string };
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

export async function upsertRun(rootDir: string, entry: LedgerEntry): Promise<void> {
  const runs = await loadLedger(rootDir);
  const i = runs.findIndex((r) => r.runId === entry.runId);
  if (i >= 0) runs[i] = entry;
  else runs.push(entry);
  // Cap the ledger at 200 most recent runs.
  const capped = runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 200);
  await saveLedger(rootDir, capped);
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
    const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, cmd], { timeout: 30_000 });
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
