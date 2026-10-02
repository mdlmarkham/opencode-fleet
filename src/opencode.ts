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

/** Worker engine harness: the opencode CLI (default) or the Pi coding agent. */
export type FleetHarness = "opencode" | "pi";

export interface OpenCodeTask {
  /** Task prompt / goal for OpenCode. */
  prompt: string;
  /** Working directory on the node. */
  cwd: string;
  /** Transport to use. */
  transport: OpenCodeTransport;
  /** Worker engine harness (default "opencode"). "pi" runs the Pi coding agent. */
  harness?: FleetHarness;
  /**
   * Pi model override (harness="pi"). Pi refs are `provider/id`
   * (e.g. aperture/glm-5.3-flash:cloud), NOT opencode's `aperture-anthropic/...`.
   */
  piModel?: string;
  /** Optional model override (must exist on the node's provider). */
  model?: string;
  /** Optional agent (build/plan). */
  agent?: string;
  /**
   * Opt-in: append `--auto` to `opencode run` so non-denied permissions are
   * auto-approved for an unattended detached run. Default FALSE — this is a
   * trust-posture change and must be requested explicitly (issue #30 finding D).
   */
  autoApprove?: boolean;
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
  /** Worker engine that produced this result (issue #30 finding A). */
  harness?: FleetHarness;
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
  // Issue #30 finding D: `--auto` auto-approves every non-denied permission.
  // That is a real trust-posture change, so it is OPT-IN per dispatch/default
  // FALSE; it is only appended when the caller explicitly asks for it.
  const autoFlag = task.autoApprove === true ? " --auto" : "";

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

  // Pi harness: same cd guard and env block, but drive the `pi` coding agent
  // in one-shot prompt mode. Pi model refs are `provider/id`
  // (e.g. aperture/glm-5.3-flash:cloud) — NOT opencode's `aperture-anthropic/...`
  // — so a plain `model` value cannot be forwarded safely; fall back to a known
  // default when `piModel` is absent.
  if (task.harness === "pi") {
    // Issue #30 finding B: Pi model refs are `provider/id`
    // (e.g. aperture/glm-5.3-flash:cloud) — NOT opencode's
    // `aperture-anthropic/...` — so the opencode `model` value must NEVER be
    // forwarded. Fall back to a known Pi default when `piModel` is absent.
    const piModel = task.piModel ?? "aperture/glm-5.3-flash:cloud";
    // Issue #30 finding C: flag-injection guard. The prompt is passed as a
    // POSITIONAL argument AFTER an explicit `--` separator, and every flag
    // (including `--model`) precedes the separator. A prompt beginning with
    // `-` can therefore never be parsed as a flag.
    //
    // NOTE: `pi` is NOT installed on the host used to author this change, so
    // this could not be verified against `pi --help`. Assumption: pi-mono's
    // `-p/--print` is a BOOLEAN print-mode flag and the prompt is positional;
    // `--` terminates option parsing. If a future pi takes `-p <prompt>`, the
    // equivalent injection-safe form is `-p=${shq(task.prompt)}`.
    return [
      cdGuard,
      envExports,
      `timeout ${Math.floor(timeout / 1000)} pi -p --model ${shq(piModel)} -- ${shq(task.prompt)} 2>&1`,
    ].filter(Boolean).join("\n");
  }

  if (task.transport === "acp") {
    // Issue #30 finding D(1): `opencode acp` has NO `--auto` flag (verified
    // against `opencode acp --help`, v1.18.30). It was inert here because acp
    // routes to runAcpPrompt, but leaving it would break if that changed.
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
    // `--auto` (opt-in via task.autoApprove) auto-approves any permission that
    // is not explicitly denied. In a DETACHED, unattended run there is no human
    // to answer a prompt, and the default "ask" permissions (notably
    // external_directory) auto-REJECT — which kills the whole session with exit
    // 0 and reads as a silent no-op. Explicit "deny" rules still apply. It is
    // NOT sent by default because it widens the trust posture. (Fleet lesson:
    // this class cost us #48/#52.)
    `timeout ${Math.floor(timeout / 1000)} opencode run${autoFlag}${modelFlag}${agentFlag} --format json -- ${shq(task.prompt)} 2>&1`,
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

/** Execution status threaded from the node shell run (issue #30 finding A). */
export interface PiExecStatus {
  /** Shell exit code of the wrapped `timeout N pi ...` process (null if killed). */
  exitCode?: number | null;
  /** True when the node-side watchdog killed the run on timeout. */
  timedOut?: boolean;
  /** True when the node-side watchdog killed the run for idling/exceeding max duration. */
  stuck?: boolean;
}

/**
 * Parse raw `pi -p` output into a structured result.
 * Pi prints a plain (non-NDJSON) transcript, so the tail is kept as the summary.
 * HAND_RAISE detection mirrors `parseOpenCodeOutput`.
 *
 * Issue #30 finding A: `ok` is derived from the ACTUAL execution status — a
 * non-zero exit, exit 124 (`timeout`), a node watchdog kill, or a
 * `FLEET_ERROR:` (cd guard) marker all yield `ok:false` with diagnostics.
 */
export function parsePiOutput(raw: string, exec?: PiExecStatus): OpenCodeRunResult {
  const summary = raw.trim().slice(-4000);
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const handRaised = Boolean(handRaiseMatch);
  const question = handRaiseMatch ? handRaiseMatch[1].trim() : undefined;

  const cdError = /FLEET_ERROR:/.test(raw);
  const timedOut = exec?.timedOut === true || /(^|\n)\[timeout\]/.test(raw) || exec?.exitCode === 124;
  const stuck = exec?.stuck === true || /(^|\n)\[stuck:/.test(raw);
  const nonzeroExit = typeof exec?.exitCode === "number" && exec.exitCode !== 0;
  const failed = cdError || timedOut || stuck || nonzeroExit;

  let error: string | undefined;
  if (failed) {
    if (cdError) {
      error = raw.match(/FLEET_ERROR:[^\n]*/)?.[0] ?? "worker could not enter cwd";
    } else if (timedOut) {
      error = `pi run timed out${exec?.exitCode != null ? ` (exit ${exec.exitCode})` : ""}`;
    } else if (stuck) {
      error = `pi run killed by watchdog: ${raw.match(/\[stuck:[^\]]*\]/)?.[0] ?? "stuck"}`;
    } else {
      error = `pi run exited non-zero (exit ${exec?.exitCode})`;
    }
  }

  return {
    ok: !failed,
    harness: "pi",
    transport: "http",
    summary: handRaised ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised,
    question,
    ...(error ? { error } : {}),
  };
}
