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
  /** Internal control flag: abort a running session. */
  abort?: boolean;
  /** Internal control flag: pull a diff for a session. */
  diff?: boolean;
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
 */
export function buildOpenCodeCommand(task: OpenCodeTask): string {
  const cwd = task.cwd || ".";
  const timeout = task.timeoutMs ?? 300_000;
  const modelFlag = task.model ? ` --model ${shq(task.model)}` : "";
  const agentFlag = task.agent ? ` --agent ${shq(task.agent)}` : "";

  if (task.transport === "acp") {
    // ACP stdio: run `opencode acp` in the workspace. For v1 we run a
    // one-shot prompt through the ACP server.
    return [
      `cd ${shq(cwd)}`,
      `timeout ${Math.floor(timeout / 1000)} opencode acp${modelFlag}${agentFlag} --print-logs 2>&1 <<'OPENCODE_EOF'`,
      task.prompt,
      "OPENCODE_EOF",
    ].join("\n");
  }

  // HTTP transport: run `opencode run` directly (standalone, no server).
  // Output is NDJSON streaming; we capture it and extract the final text.
  return [
    `cd ${shq(cwd)}`,
    `timeout ${Math.floor(timeout / 1000)} opencode run${modelFlag}${agentFlag} ${shq(task.prompt)} --format json 2>&1`,
  ].join("\n");
}

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
