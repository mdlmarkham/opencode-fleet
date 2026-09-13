/**
 * OpenCode driver — runs OpenCode on a node via the `opencode.run` node command.
 *
 * Two transports:
 *  - "http":  `opencode serve` (headless HTTP server) + `opencode run --attach`
 *             Best for fire-and-forget batch dispatch. Mirrors the legacy
 *             OpenCodeFleet HTTP approach.
 *  - "acp":   `opencode acp` (ACP stdio server). Mirrors the Codex
 *             paired-device placement pattern. Best for interactive/steerable
 *             sessions.
 *
 * The node side owns provider auth (its own OpenCode login). The Gateway
 * relays only the task prompt + workspace path — never credentials.
 */

export type OpenCodeTransport = "http" | "acp";

export interface OpenCodeTask {
  /** Task prompt / goal for OpenCode. */
  prompt: string;
  /** Working directory on the node. */
  cwd: string;
  /** Transport to use. */
  transport: OpenCodeTransport;
  /** Optional model override (must exist on the node's provider). */
  model?: string;
  /** Optional agent (build/plan). */
  agent?: string;
  /** Max iterations for the completion loop (http transport). */
  maxIterations?: number;
  /** Completion marker string (http transport). */
  completionPromise?: string;
  /** Timeout for the whole run, ms. */
  timeoutMs?: number;
  /** Kill the run if no output chunk arrives for this long, ms (stuck-loop guard). */
  maxIdleMs?: number;
  /** Kill the run if total runtime exceeds this, ms (stuck-loop guard). */
  maxDurationMs?: number;
  /** Optional session id (used for abort/diff control messages). */
  sessionId?: string;
  /** Environment variables for the worker process (per-dispatch environment). */
  env?: Record<string, string>;
  /** Git ref to check out before running (dispatch-time environment selection). Refused if the checkout has uncommitted changes. */
  ref?: { branch?: string; commit?: string };
  /** Fleet run id — enables detached execution + durable completion record. */
  runId?: string;
  /** Detached execution (default true): node returns immediately with a run handle. */
  async?: boolean;
  /** Worker pid from the detached-start ack (for liveness checks). */
  pid?: number;
  /** Node-channel transfer id (provisioning fallback when SSH unavailable). */
  transferId?: string;
  /** Node-channel transfer chunks: ordered base64 segments of a bundle. */
  chunks?: Array<{ index: number; data: string }>;
  /** Expected chunk index for ordered node-channel transfer. */
  chunkIndex?: number;
  /** Commit SHA for __UNPACK__ (channel path). */
  commit?: string;
  /** Internal control flag: abort a running session. */
  abort?: boolean;
  /** Internal control flag: pull a diff for a session. */
  diff?: boolean;
  /**
   * Issue #22: the REAL task prompt for a detached launch. `prompt` carries the
   * `__RUN_START__` transport sentinel on the wire, so the actual message must
   * travel in a separate field or it is destroyed before the command is built.
   */
  realPrompt?: string;
}

export interface OpenCodeRunResult {
  ok: boolean;
  transport: OpenCodeTransport;
  sessionId?: string;
  summary?: string;
  diffSummary?: string;
  iterations?: number;
  durationMs?: number;
  error?: string;
  /** True when the worker stopped to ask a clarifying question. */
  handRaised?: boolean;
  /** The worker's clarifying question (when handRaised). */
  question?: string;
}

import { shq } from "./shell.js";

/**
 * Build the shell command that runs OpenCode on the node for a given task.
 * Returns a single command string executed via the node's shell.
 * All interpolated values are shell-escaped (shq) to prevent injection.
 *
 * Issue #22:
 *  - Bug 1: `cd` must fail closed. A worker that cannot enter the checkout
 *    (e.g. a /root path the service principal cannot traverse) must abort with
 *    a clear, greppable error instead of running `opencode` in the wrong place.
 *  - Bug 2/3: the prompt is passed AFTER `--` so it is delivered as the
 *    message, never absorbed as a flag value. An empty prompt fails closed.
 *  - Bug 4: no exit-code laundering — the `cd` failure propagates.
 */
export function buildOpenCodeCommand(task: OpenCodeTask): string {
  const cwd = task.cwd || ".";
  const timeout = task.timeoutMs ?? 300_000;
  const modelFlag = task.model ? ` --model ${shq(task.model)}` : "";
  const agentFlag = task.agent ? ` --agent ${shq(task.agent)}` : "";

  // Issue #22 bug 2/3: a prompt that is empty, missing, or an unsubstituted
  // control placeholder must never reach `opencode run` — that launches an
  // empty session which exits 0 and reads as success.
  const prompt = task.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("opencode task has no prompt (empty or unsubstituted placeholder) — refusing to launch an empty session");
  }
  if (CONTROL_PLACEHOLDER_RE.test(prompt)) {
    throw new Error(`opencode task prompt is an internal control placeholder (${prompt}) — the real prompt was not substituted`);
  }

  // Per-dispatch environment: emitted as leading `export` lines so the worker
  // process (and anything it spawns) sees them. Keys/values are shell-escaped.
  // PATH/HOME/LD_* are deliberately excluded — overriding those on a remote
  // node is a footgun; use the node's own service config for that.
  const envExports = Object.entries(task.env ?? {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .filter(([k]) => !/^(PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH|SHELL|USER|LOGNAME|PWD|OLDPWD)$/i.test(k))
    .map(([k, v]) => `export ${k}=${shq(String(v))}`)
    .join("\n");

  // Issue #22 bug 1/4: fail closed if we cannot enter the checkout. `cd X || {
  // ...; exit 1; }` makes the failure fatal so `opencode` never runs from the
  // wrong directory (and the exit code is not laundered).
  const cdGuard =
    `cd ${shq(cwd)} || { echo "FLEET_ERROR: cannot enter cwd ${cwd} as $(id -un) (uid $(id -u)): $?" >&2; exit 66; }`;

  if (task.transport === "acp") {
    return [
      cdGuard,
      envExports,
      `timeout ${Math.floor(timeout / 1000)} opencode acp${modelFlag}${agentFlag} --print-logs 2>&1 <<'OPENCODE_EOF'`,
      task.prompt,
      "OPENCODE_EOF",
    ].filter(Boolean).join("\n");
  }

  return [
    cdGuard,
    envExports,
    `timeout ${Math.floor(timeout / 1000)} opencode run${modelFlag}${agentFlag} --format json -- ${shq(task.prompt)} 2>&1`,
  ].filter(Boolean).join("\n");
}

/** Internal control sentinels that must never appear as a real prompt. */
const CONTROL_PLACEHOLDER_RE = /^__RUN_(START|STATUS|RESULT|ABORT)__$/;

/**
 * Parse the raw node command output into a structured result.
 * Handles NDJSON streaming output from `opencode run --format json`.
 */
export function parseOpenCodeOutput(raw: string): OpenCodeRunResult {
  // Collect text from NDJSON `text` events.
  const texts: string[] = [];
  let sessionId: string | undefined;
  let cost: number | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        texts.push(evt.part.text);
      }
      if (evt.type === "step_start" && evt.sessionID) sessionId = evt.sessionID;
      if (evt.type === "step_finish" && evt.part?.tokens) {
        cost = evt.part.tokens.total;
      }
    } catch {
      // Not JSON — ignore (could be a plain error line).
    }
  }

  const summary = texts.join("\n").trim();
  const ok = !/error|failed|timed out/i.test(raw) || summary.length > 0;

  // Detect a hand-raise: the worker stopped to ask a clarifying question.
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const handRaised = Boolean(handRaiseMatch);
  const question = handRaiseMatch ? handRaiseMatch[1].trim() : undefined;

  return {
    ok,
    transport: "http",
    sessionId,
    summary: handRaised ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised,
    question,
    iterations: 1,
    diffSummary: undefined,
    error: ok ? undefined : raw.slice(0, 500),
  };
}
