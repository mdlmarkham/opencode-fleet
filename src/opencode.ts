/**
 * OpenCode driver — runs OpenCode on a node via the `opencode.run` node command.
 *
 * Two transports:
 *  - "http":  `opencode run --format json` (one-shot, detached by the dispatcher).
 *             Best for fire-and-forget batch dispatch. (Historically named for the
 *             `opencode serve` + `--attach` design; the code never used `serve`.)
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
   * (e.g. myprovider/some-model), NOT opencode's `provider-prefix/...` form.
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
  /** Expected sha256 (hex) of the decoded bundle for __UNPACK__ (channel path). */
  sha256?: string;
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
import { partitionEnv } from "./policy.js";
import { redactSecrets, sanitizeQuestion } from "./untrusted.js";

/**
 * Validate an engine/transport combination BEFORE any command is built or the
 * node is invoked (issue #30 finding G). Pi is driven over the shell (http
 * path) only; `opencode acp` has no Pi transport, so `harness="pi"` with
 * `transport="acp"` would silently run the opencode ACP client and drop Pi
 * (and piModel). Extracted as a pure function so it is unit-testable.
 */
export function validateHarnessTransport(task: {
  harness?: string;
  transport?: string;
}): { ok: true } | { ok: false; harness?: string; error: string } {
  if (task.transport === "acp" && task.harness === "pi") {
    return {
      ok: false,
      harness: "pi",
      error:
        "harness=pi requires transport=http (opencode acp has no Pi transport; Pi would be silently ignored)",
    };
  }
  return { ok: true };
}

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
  // Names that execute code or redirect config are filtered by policy.ts; the
  // gateway refuses a dispatch that names any (see partitionEnv), so reaching
  // this filter with one means a caller bypassed it — drop, never export.
  const envExports = Object.entries(partitionEnv(task.env).allowed)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n");

  // Issue #22 bug 1/4: fail closed if we cannot enter the checkout. `cd X || {
  // ...; exit 1; }` makes the failure fatal so `opencode` never runs from the
  // wrong directory (and the exit code is not laundered).
  const cdGuard =
    `cd ${shq(cwd)} || { echo "FLEET_ERROR: cannot enter cwd ${cwd} as $(id -un) (uid $(id -u)): $?" >&2; exit 66; }`;

  // Pi harness: same cd guard and env block, but drive the `pi` coding agent
  // in one-shot prompt mode. Pi model refs are `provider/id`, unlike opencode's
  // provider-prefixed ids, so an opencode `model` is never forwarded; the caller
  // (or operator config) must supply `piModel`.
  if (task.harness === "pi") {
    // Issue #30 finding B: the opencode `model` value must NEVER be forwarded
    // to Pi (different ref format). Issue #44: and there is no built-in model.
    const piModel = task.piModel;
    if (!piModel) throw new Error("harness=pi requires piModel (provider/id); there is no built-in default");
    // Issue #30 finding C (VALIDATED LIVE on dev2, pi 0.73.1 as svcuser):
    // pi does NOT support `--` (`Error: Unknown option: --`), and a positional
    // prompt beginning with `-`/`--` is parsed as a FLAG (`pi -p -- --version`
    // prints 0.73.1; `--model x` injects a model flag). So the old
    // `pi -p --model M -- <prompt>` form failed outright AND voided the guard.
    //
    // FIX: feed the prompt via STDIN — no `--`, no positional prompt. Live
    // proof: a normal prompt arrives as message content; a hostile `--evil ...`
    // prompt is delivered as MESSAGE CONTENT (no parser error) — injection-proof.
    return [
      cdGuard,
      envExports,
      `printf '%s' ${shq(task.prompt)} | timeout ${Math.floor(timeout / 1000)} pi -p --model ${shq(piModel)} 2>&1`,
    ].filter(Boolean).join("\n");
  }

  if (task.transport === "acp") {
    // Issue #30 finding D(1): `opencode acp` has NO `--auto` flag (verified
    // against `opencode acp --help`; the live dev2 node runs 1.18.26 — the
    // `--auto` absence still holds there). It was inert here because acp
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
 *
 * Issue #35: when the execution status is known (`exec`), `ok` is derived from
 * it — a non-zero exit, exit 124 (`timeout`), a watchdog kill, a `FLEET_ERROR:`
 * line, an `error` event in the stream, or a stream with no events at all (an
 * empty session exits 0) all yield `ok:false`. Without `exec` (legacy callers)
 * it falls back to the old output heuristic.
 */
export function parseOpenCodeOutput(raw: string, exec?: ExecStatus): OpenCodeRunResult {
  // Collect text from NDJSON `text` events.
  const texts: string[] = [];
  const errorEvents: string[] = [];
  let sessionId: string | undefined;
  let sawEvents = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt && typeof evt.type === "string") sawEvents = true;
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        texts.push(evt.part.text);
      }
      if (evt.type === "step_start" && evt.sessionID) sessionId = evt.sessionID;
      if (evt.type === "error") {
        const msg = evt.error?.data?.message ?? evt.error?.message ?? evt.message ?? evt.error?.name;
        errorEvents.push(typeof msg === "string" ? msg : "opencode reported an error event");
      }
    } catch {
      // Not JSON — ignore (could be a plain error line).
    }
  }

  const summary = redactSecrets(texts.join("\n").trim());

  let ok: boolean;
  let error: string | undefined;
  if (exec) {
    const cdError = /(^|\n)FLEET_ERROR:/.test(raw);
    const timedOut = exec.timedOut === true || exec.exitCode === 124 || /(^|\n)\[timeout\]/.test(raw);
    const stuck = exec.stuck === true || /(^|\n)\[stuck:/.test(raw);
    const nonzeroExit = typeof exec.exitCode === "number" && exec.exitCode !== 0;
    const emptySession = !sawEvents && summary.length === 0;
    ok = !(cdError || timedOut || stuck || nonzeroExit || errorEvents.length > 0 || emptySession);
    if (!ok) {
      error = cdError
        ? (raw.match(/(?:^|\n)(FLEET_ERROR:[^\n]*)/)?.[1] ?? "worker could not enter cwd")
        : timedOut
          ? `opencode run timed out${exec.exitCode != null ? ` (exit ${exec.exitCode})` : ""}`
          : stuck
            ? `opencode run killed by watchdog: ${raw.match(/\[stuck:[^\]]*\]/)?.[0] ?? "stuck"}`
            : nonzeroExit
              ? `opencode run exited non-zero (exit ${exec.exitCode})`
              : errorEvents.length > 0
                ? `opencode error: ${errorEvents[0]}`
                : "opencode produced no events (empty session)";
    }
  } else {
    ok = !/error|failed|timed out/i.test(raw) || summary.length > 0;
    if (!ok) error = raw.slice(0, 500);
  }

  // Detect a hand-raise: the worker stopped to ask a clarifying question.
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const handRaised = Boolean(handRaiseMatch);
  const question = handRaiseMatch ? sanitizeQuestion(handRaiseMatch[1]) : undefined;

  return {
    ok,
    transport: "http",
    sessionId,
    summary: handRaised ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised,
    question,
    iterations: 1,
    diffSummary: undefined,
    error: error ? redactSecrets(error) : undefined,
  };
}

/** Execution status threaded from the node shell run (issues #30, #35). */
export interface ExecStatus {
  /** Shell exit code of the wrapped `timeout N pi ...` process (null if killed). */
  exitCode?: number | null;
  /** True when the node-side watchdog killed the run on timeout. */
  timedOut?: boolean;
  /** True when the node-side watchdog killed the run for idling/exceeding max duration. */
  stuck?: boolean;
}

/** @deprecated use ExecStatus */
export type PiExecStatus = ExecStatus;

/**
 * Parse raw `pi -p` output into a structured result.
 * Pi prints a plain (non-NDJSON) transcript, so the tail is kept as the summary.
 * HAND_RAISE detection mirrors `parseOpenCodeOutput`.
 *
 * Issue #30 finding A: `ok` is derived from the ACTUAL execution status — a
 * non-zero exit, exit 124 (`timeout`), a node watchdog kill, or a
 * `FLEET_ERROR:` (cd guard) marker all yield `ok:false` with diagnostics.
 */
export function parsePiOutput(raw: string, exec?: ExecStatus): OpenCodeRunResult {
  const summary = redactSecrets(raw.trim().slice(-4000));
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const handRaised = Boolean(handRaiseMatch);
  const question = handRaiseMatch ? sanitizeQuestion(handRaiseMatch[1]) : undefined;

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
