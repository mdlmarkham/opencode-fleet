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
  /**
   * Pi tool allowlist (harness="pi"): passed as `--tools`. An empty list disables every
   * tool (`--no-tools`). Absent = Pi's defaults. Fail-closed: a node whose Pi lacks the flag
   * refuses the run rather than running unrestricted.
   */
  piTools?: string[];
  /** Run Pi with `--offline` (no automatic network activity). Fail-closed like piTools. */
  piOffline?: boolean;
  /**
   * Opt-in (harness="pi"): ask Pi for `--mode json` and parse the JSONL events into tool calls,
   * usage and a reliable final message. Only applied when the node's Pi lists `--mode`; otherwise
   * the plain-text path runs unchanged.
   */
  piJson?: boolean;
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
  /**
   * Issue #62: optional post-run verification gate. When present the node
   * evaluates it in the run cwd AFTER the worker finishes and records
   * `verified` + `verifyDetails` on the run result. Verified is distinct from
   * `ok` (process exit status); absent spec => verified null, no behavior change.
   */
  expect?: FleetExpect;
  /** Issue #65 slice 2: advisory file scope; the node reports changed files outside it. */
  scope?: { files: string[] };
  /**
   * Issue #283: references to install INTO the run's clone before the worker starts,
   * so a reference the operator named is actually present to read. Each entry is a
   * repo-relative `path` (copied into the clone; `..`/absolute refs are refused) or a
   * `note`-only pointer (nothing to install). Distinct from #262, which only NAMES
   * references in the prompt.
   */
  references?: Array<{ path?: string; note?: string }>;
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
  /** The transport the run used. Issue #103: never hard-coded — the caller's
   * real transport wins; an unknown one falls back to the legacy "http". */
  transport?: OpenCodeTransport;
  /** Worker engine that produced this result (issue #30 finding A). */
  harness?: FleetHarness;
  sessionId?: string;
  summary?: string;
  diffSummary?: string;
  iterations?: number;
  durationMs?: number;
  error?: string;
  /** Which limit ended the run, when one did (issue #168): the wall-clock `timeout`, or the node's idle/duration watchdog. */
  endedBy?: "wall-clock" | "idle-watchdog";
  /** Pi version the node reported (harness=pi; issue #137). */
  piVersion?: string;
  /** Baseline hardening flags this node's Pi did NOT support, so they were not applied (harness=pi; issue #137). Absent when all were applied. */
  piHardeningGaps?: string[];
  /** True when the worker stopped to ask a clarifying question. */
  handRaised?: boolean;
  /** The worker's clarifying question (when handRaised). */
  question?: string;
  /**
   * Issue #62: outcome of the optional `expect` verification gate, evaluated
   * by the node after the worker finished. null/absent = no gate was given.
   */
  verified?: boolean | null;
  /** Issue #309: the gate did not finish in time. `verified` stays null (unverified, never a pass, never "failed"). */
  gateTimedOut?: boolean;
  verifyDetails?: VerifyDetails;
  /** Pi `--mode json` only (#137 Pi-1): tools the worker ran, in order. */
  toolCalls?: PiToolCall[];
  /** Pi `--mode json` only: provider-reported usage from the last assistant message, passed through. */
  usage?: Record<string, unknown>;
  /** Pi `--mode json` only: the assistant's stopReason. */
  stopReason?: string;
}

export interface PiToolCall {
  tool: string;
  /** The bash command, or a short rendering of the args, redacted and capped. */
  input?: string;
  isError?: boolean;
}

import { shq } from "./shell.js";
import { partitionEnv } from "./policy.js";
import { redactSecrets, sanitizeQuestion } from "./untrusted.js";
import type { ExpectCheck, VerifyDetails } from "./verify.js";

/** Issue #62: optional post-run verification gate spec (files must exist, command must exit 0). */
export type FleetExpect = ExpectCheck;

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
  const timeout = task.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
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
    const piModel = task.piModel?.trim();
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
    const piErr = validatePiOptions(task);
    if (piErr) throw new Error(piErr);
    return [
      cdGuard,
      envExports,
      ...piFlagLines(task),
      `printf '%s' ${shq(task.prompt)} | timeout ${Math.floor(timeout / 1000)} pi -p $PI_FLAGS --model ${shq(piModel)} 2>&1`,
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
/**
 * Issue #103: the transport/iteration count are NOT hard-coded here — the
 * caller supplies the ACTUAL values via `exec` (see ExecStatus). With no
 * caller input the historical defaults (`http`, 1) are used as a fallback so
 * legacy call sites behave exactly as before.
 */
const DEFAULT_PARSED_TRANSPORT: OpenCodeTransport = "http";
const DEFAULT_PARSED_ITERATIONS = 1;

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
          ? `opencode run timed out at the wall-clock limit${exec.exitCode != null ? ` (exit ${exec.exitCode})` : ""}`
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
    // Issue #103: report the REAL transport/iterations the caller supplied;
    // when it does not know them, fall back to the historical http/1 defaults
    // (backward compatible) rather than omitting or asserting a wrong value.
    transport: exec?.transport ?? DEFAULT_PARSED_TRANSPORT,
    sessionId,
    summary: handRaised ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised,
    question,
    iterations: exec?.iterations ?? DEFAULT_PARSED_ITERATIONS,
    ...(endedByOf(raw, exec) ? { endedBy: endedByOf(raw, exec) } : {}),
    diffSummary: undefined,
    error: error ? redactSecrets(error) : undefined,
  };
}

/** Which limit ended the run, from the raw output and exec status (issue #168). */
export function endedByOf(raw: string, exec?: { timedOut?: boolean; stuck?: boolean; exitCode?: number | null }): "wall-clock" | "idle-watchdog" | undefined {
  if (exec?.stuck === true || /(^|\n)\[stuck:/.test(raw)) return "idle-watchdog";
  if (exec?.timedOut === true || exec?.exitCode === 124 || /(^|\n)\[timeout\]/.test(raw)) return "wall-clock";
  return undefined;
}

/** Execution status threaded from the node shell run (issues #30, #35). */
export interface ExecStatus {
  /** Shell exit code of the wrapped `timeout N pi ...` process (null if killed). */
  exitCode?: number | null;
  /** True when the node-side watchdog killed the run on timeout. */
  timedOut?: boolean;
  /** True when the node-side watchdog killed the run for idling/exceeding max duration. */
  stuck?: boolean;
  /**
   * Issue #103: the REAL transport the run used. Never assumed: when the
   * caller does not know it, the parser falls back to the legacy default.
   */
  transport?: OpenCodeTransport;
  /** Issue #103: the REAL iteration count when the caller knows it. */
  iterations?: number;
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
/** Wall-clock backstop for a dispatched run (issue #168): real coding tasks outlive the old 5 minutes. The idle watchdog (maxIdleMs) is the primary hung-run guard. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

/** `fleet_watch` is a blocking call whose timeoutMs is the run's only limit; 5 minutes killed real tasks (issue #190). */
export const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000;

export const PI_TOOL_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Validate the Pi restriction fields; they are interpolated into a shell command, so be strict. */
export function validatePiOptions(task: { piTools?: unknown; piOffline?: unknown }): string | null {
  if (task.piTools !== undefined) {
    if (!Array.isArray(task.piTools) || task.piTools.length > 16 || !task.piTools.every((t) => typeof t === "string" && PI_TOOL_NAME.test(t))) {
      return "piTools must be an array of at most 16 tool names (lowercase letters, digits, _ or -)";
    }
  }
  if (task.piOffline !== undefined && typeof task.piOffline !== "boolean") return "piOffline must be a boolean";
  if ((task as { piJson?: unknown }).piJson !== undefined && typeof (task as { piJson?: unknown }).piJson !== "boolean") return "piJson must be a boolean";
  return null;
}

/**
 * Shell lines that build `PI_FLAGS` from what this node's Pi actually supports (`pi --help`).
 * Baseline hardening flags are added only when supported, so an older Pi still runs; requested
 * restrictions (piTools, piOffline) are mandatory: unsupported means exit 67, never unrestricted.
 */
/** Marker line the Pi launcher prints so the parser can report the version and applied flags (issue #137). */
export const PI_MARKER = "FLEET_PI: ";
export const PI_BASELINE_FLAGS = ["--no-session", "--no-approve", "--no-extensions", "--no-skills"] as const;

/** Strip the launcher marker from Pi output and read what it said. Pure. */
export function extractPiMarker(raw: string): { rest: string; version?: string; flags?: string[] } {
  // Anchored at the start of the output: the launcher prints it before Pi runs, so a model that prints
  // a look-alike line later cannot spoof it.
  const m = /^\s*FLEET_PI: version=([^\n]*?) flags=([^\n]*)(?:\n|$)/.exec(raw);
  if (!m) return { rest: raw };
  const version = m[1]!.trim();
  return { rest: raw.slice(m[0].length), ...(version ? { version } : {}), flags: m[2]!.split(/\s+/).filter((f) => f.startsWith("--")) };
}

export function piFlagLines(task: { piTools?: string[]; piOffline?: boolean; piJson?: boolean }): string[] {
  const lines = [
    'PI_HELP="$(pi --help 2>&1)"',
    'PI_FLAGS=""',
    'for f in --no-session --no-approve --no-extensions --no-skills; do case "$PI_HELP" in *"$f"*) PI_FLAGS="$PI_FLAGS $f";; esac; done',
  ];
  const need = (flag: string, add: string): string =>
    `case "$PI_HELP" in *"${flag}"*) PI_FLAGS="$PI_FLAGS ${add}";; *) echo "FLEET_ERROR: this node's pi does not support ${flag}; refusing to run unrestricted" >&2; exit 67;; esac`;
  if (Array.isArray(task.piTools)) {
    lines.push(task.piTools.length === 0 ? need("--no-tools", "--no-tools") : need("--tools", `--tools ${task.piTools.join(",")}`));
  }
  if (task.piOffline === true) lines.push(need("--offline", "--offline"));
  // Output format only, so a node without it just keeps the plain-text path.
  // Issue #137: JSON mode is the DEFAULT (live-verified on pi 0.73.1): without it the audit manifest
  // is empty (no commands, no usage). `piJson: false` opts out; a node without --mode keeps plain text.
  if (task.piJson !== false) lines.push('case "$PI_HELP" in *"--mode"*) PI_FLAGS="$PI_FLAGS --mode json";; esac');
  // One marker line says which Pi ran and which flags it got, so a hardening flag this version lacks is visible.
  lines.push(`echo "${PI_MARKER}version=$(pi --version 2>&1 | head -n 1 | tr -cd 'A-Za-z0-9._+ -' | cut -c1-40) flags=$PI_FLAGS"`);
  return lines;
}

export function parsePiOutput(rawIn: string, exec?: ExecStatus): OpenCodeRunResult {
  const marker = extractPiMarker(rawIn);
  const res = parsePiOutputBody(marker.rest, exec);
  if (marker.version === undefined && marker.flags === undefined) return res;
  const gaps = marker.flags ? PI_BASELINE_FLAGS.filter((f) => !marker.flags!.includes(f)) : [];
  return { ...res, ...(marker.version ? { piVersion: marker.version } : {}), ...(gaps.length ? { piHardeningGaps: [...gaps] } : {}) };
}

function parsePiOutputBody(raw: string, exec?: ExecStatus): OpenCodeRunResult {
  const events = parsePiJsonEvents(raw);
  if (events) return parsePiJsonOutput(raw, events, exec);
  const summary = redactSecrets(raw.trim().slice(-4000));
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const handRaised = Boolean(handRaiseMatch);
  const question = handRaiseMatch ? sanitizeQuestion(handRaiseMatch[1]) : undefined;

  const cdError = /(^|\n)FLEET_ERROR:/.test(raw);
  const timedOut = exec?.timedOut === true || /(^|\n)\[timeout\]/.test(raw) || exec?.exitCode === 124;
  const stuck = exec?.stuck === true || /(^|\n)\[stuck:/.test(raw);
  const nonzeroExit = typeof exec?.exitCode === "number" && exec.exitCode !== 0;
  const failed = cdError || timedOut || stuck || nonzeroExit;

  let error: string | undefined;
  if (failed) {
    if (cdError) {
      error = raw.match(/(?:^|\n)(FLEET_ERROR:[^\n]*)/)?.[1] ?? "worker could not enter cwd";
    } else if (timedOut) {
      error = `pi run timed out at the wall-clock limit${exec?.exitCode != null ? ` (exit ${exec.exitCode})` : ""}`;
    } else if (stuck) {
      error = `pi run killed by watchdog: ${raw.match(/\[stuck:[^\]]*\]/)?.[0] ?? "stuck"}`;
    } else {
      error = `pi run exited non-zero (exit ${exec?.exitCode})`;
    }
  }

  return {
    ok: !failed,
    harness: "pi",
    // Issue #103: real transport from the caller, http fallback for legacy calls.
    transport: exec?.transport ?? DEFAULT_PARSED_TRANSPORT,
    summary: handRaised ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised,
    question,
    // Issue #103: real iteration count from the caller, 1 fallback for legacy calls.
    iterations: exec?.iterations ?? DEFAULT_PARSED_ITERATIONS,
    ...(endedByOf(raw, exec) ? { endedBy: endedByOf(raw, exec) } : {}),
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pi `--mode json` (#137 Pi-1). Shapes follow Pi's docs (json.md), not yet verified live:
// every field is read defensively and anything unexpected is ignored, never thrown on.
// ---------------------------------------------------------------------------

type PiEvent = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON event lines of a Pi run, or null when the output is not JSONL (plain-text path). */
export function parsePiJsonEvents(raw: string): PiEvent[] | null {
  const events: PiEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (isObj(v) && typeof v.type === "string") events.push(v);
    } catch { /* a stray non-JSON line */ }
  }
  return events.some((e) => e.type === "message_end" || e.type === "agent_end" || e.type === "agent_start") ? events : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

const cap = (s: string, n: number): string => redactSecrets(s.length > n ? `${s.slice(0, n)}…` : s);

function parsePiJsonOutput(raw: string, events: PiEvent[], exec?: ExecStatus): OpenCodeRunResult {
  let finalText = "";
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let providerError: string | undefined;
  const toolCalls: PiToolCall[] = [];
  const open = new Map<string, PiToolCall>();
  for (const e of events) {
    if (e.type === "message_end" && isObj(e.message) && e.message.role === "assistant") {
      const text = textOf(e.message.content);
      if (text) finalText = text;
      if (typeof e.message.stopReason === "string") stopReason = e.message.stopReason;
      if (isObj(e.message.usage)) usage = e.message.usage;
    } else if (e.type === "message_update") {
      if (isObj(e.usage)) usage = e.usage;
      const ame = e.assistantMessageEvent;
      if (isObj(ame) && ame.type === "error") providerError = cap(String(ame.reason ?? ame.error ?? "provider error"), 300);
    } else if (e.type === "tool_execution_start" && typeof e.toolName === "string") {
      const a = isObj(e.args) ? e.args : {};
      const input = typeof a.command === "string" ? a.command : Object.keys(a).length ? JSON.stringify(a) : undefined;
      const call: PiToolCall = { tool: e.toolName, ...(input ? { input: cap(input, 500) } : {}) };
      toolCalls.push(call);
      if (typeof e.toolCallId === "string") open.set(e.toolCallId, call);
    } else if (e.type === "tool_execution_end" && typeof e.toolCallId === "string") {
      const call = open.get(e.toolCallId);
      if (call && e.isError === true) call.isError = true;
    }
  }
  const summary = redactSecrets((finalText || raw).trim().slice(-4000));
  const handRaiseMatch = summary.match(/HAND_RAISE\s*[:\-]?\s*([\s\S]{1,500})/i);
  const cdError = /(^|\n)FLEET_ERROR:/.test(raw);
  const timedOut = exec?.timedOut === true || /(^|\n)\[timeout\]/.test(raw) || exec?.exitCode === 124;
  const stuck = exec?.stuck === true || /(^|\n)\[stuck:/.test(raw);
  const nonzeroExit = typeof exec?.exitCode === "number" && exec.exitCode !== 0;
  const modelFailed = stopReason === "error" || (providerError !== undefined && !finalText);
  const failed = cdError || timedOut || stuck || nonzeroExit || modelFailed;
  let error: string | undefined;
  if (failed) {
    if (cdError) error = raw.match(/(?:^|\n)(FLEET_ERROR:[^\n]*)/)?.[1] ?? "worker could not enter cwd";
    else if (timedOut) error = `pi run timed out at the wall-clock limit${exec?.exitCode != null ? ` (exit ${exec.exitCode})` : ""}`;
    else if (stuck) error = `pi run killed by watchdog: ${raw.match(/\[stuck:[^\]]*\]/)?.[0] ?? "stuck"}`;
    else if (nonzeroExit) error = `pi run exited non-zero (exit ${exec?.exitCode})`;
    else error = `pi run failed: ${providerError ?? `stopReason ${stopReason}`}`;
  }
  return {
    ok: !failed,
    harness: "pi",
    // Issue #103: real transport from the caller, http fallback for legacy calls.
    transport: exec?.transport ?? DEFAULT_PARSED_TRANSPORT,
    summary: handRaiseMatch ? summary.replace(/HAND_RAISE\s*[:\-]?\s*/i, "").trim() : summary,
    handRaised: Boolean(handRaiseMatch),
    ...(handRaiseMatch ? { question: sanitizeQuestion(handRaiseMatch[1]) } : {}),
    // Issue #103: real iteration count from the caller, 1 fallback for legacy calls.
    iterations: exec?.iterations ?? DEFAULT_PARSED_ITERATIONS,
    ...(endedByOf(raw, exec) ? { endedBy: endedByOf(raw, exec) } : {}),
    ...(error ? { error } : {}),
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}
