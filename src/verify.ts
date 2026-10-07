/**
 * Issue #62: OPTIONAL post-run verification gate.
 *
 * A worker that exits 0 but produced nothing must not be reported as a
 * success. `fleet_dispatch` accepts an optional `expect` spec:
 *
 *     { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number }
 *
 * After the worker process finishes, the NODE evaluates the spec in the run's
 * cwd and records the outcome alongside the run result:
 *
 *   - every path in `expect.files` must exist (relative to cwd, and inside it:
 *     absolute paths and `..` are refused, symlinks that leave cwd do not count);
 *   - if `expect.command`/`expect.commands` is given, each command is run via
 *     `bash -c` in cwd and must exit 0; with `commands[]` EVERY command must
 *     exit 0 for the gate to pass (issue #104), each bounded by `timeoutMs`
 *     (shared, overrides the default) or DEFAULT_EXPECT_COMMAND_TIMEOUT_MS. The
 *     singular `command` is normalized onto the plural so there is ONE
 *     evaluation path.
 *
 * The outcome is recorded as `verified: boolean` + `verifyDetails` on the
 * run result. `verified` is deliberately DISTINCT from `ok` (`ok` remains the
 * process exit status); callers that opt into a gate check `verified`. When
 * `expect` is absent nothing is evaluated and `verified` is `null` — fully
 * backward compatible.
 *
 * The evaluators here are side-effect-light and driven by explicit inputs so
 * they are unit-testable without a node (see issue62.test.ts).
 */

import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The `expect` gate spec a dispatch can carry. */
export interface ExpectCheck {
  /** Paths relative to the run cwd that must exist after the run (absolute paths and `..` are refused). */
  files?: string[];
  /**
   * Single-command alias (issue #104): normalized onto `commands` so there is
   * ONE evaluation path. Kept working unchanged for backward compatibility.
   */
  command?: string;
  /** Commands run via `bash -c` in the run cwd; EVERY one must exit 0 (issue #104). */
  commands?: string[];
  /** Shared wall-clock bound for every command; overrides DEFAULT_EXPECT_COMMAND_TIMEOUT_MS when given (issue #104). */
  timeoutMs?: number;
}

/**
 * The normalized gate: `command` (singular) is folded onto `commands` here so
 * every consumer (evaluateExpect, the launcher gate script) sees ONE shape.
 */
export interface NormalizedExpectCheck {
  files?: string[];
  commands: string[];
  timeoutMs?: number;
}

/** Normalize a parsed spec onto the single plural evaluation path (issue #104). */
export function normalizeExpect(expect: ExpectCheck): NormalizedExpectCheck {
  const commands = expect.commands ?? (expect.command !== undefined ? [expect.command] : []);
  const out: NormalizedExpectCheck = { commands };
  if (expect.files !== undefined) out.files = expect.files;
  if (expect.timeoutMs !== undefined) out.timeoutMs = expect.timeoutMs;
  return out;
}

/** Per-path outcome of the file-existence check. */
export interface ExpectFileCheck {
  path: string;
  ok: boolean;
}

/** Outcome of one verification command. */
export interface ExpectCommandCheck {
  cmd: string;
  exitCode: number | null;
  ok: boolean;
  /** The command was killed by the gate's own time bound: it did not finish, so it is not a verdict on the work (issue #309). */
  timedOut?: true;
  /**
   * Issue #324: WHY a non-zero exit happened. `environment-unavailable` = the command could not START the
   * toolchain (a missing binary, exit 127 / "not found") — the gate never stood a chance, so a `verified:false`
   * here says nothing about the work. Omitted for a plain failure (`ok:false`, `exitCode`) — "the command ran
   * and failed" is already what `ok:false` means, so a `kind` there would be noise (and would churn the
   * recorded shape for ordinary failures).
   */
  kind?: "environment-unavailable";
  /** When kind is environment-unavailable: the command/binary that was missing (best effort, e.g. "tsc"). */
  missing?: string;
}

/** Full result of evaluating an `expect` spec. */
export interface VerifyDetails {
  files: ExpectFileCheck[];
  /** The FIRST command's outcome (singular compatibility, issue #104). */
  command?: ExpectCommandCheck;
  /** Every command's outcome, in order (issue #104). */
  commands?: ExpectCommandCheck[];
}

/** Outcome recorded on the run result (issue #62). */
export interface ExpectOutcome {
  /** true: the gate ran and passed. false: it ran and failed. null: it did not finish in time (`endedBy: "gate-timeout"`, issue #309) or could not start its toolchain (`endedBy: "gate-unavailable"`, issue #324b) — a property of the check and the node's environment, not of the work. Never a pass. */
  verified: boolean | null;
  verifyDetails: VerifyDetails;
  /** Set exactly when `verified` is null: `"gate-timeout"` (a bound killed it, issue #309) or `"gate-unavailable"` (a missing toolchain, issue #324b). */
  endedBy?: "gate-timeout" | "gate-unavailable";
  /**
   * Issue #324b (best effort): when `endedBy` is "gate-unavailable", the first
   * environment-unavailable command's missing tool (e.g. "tsc"), so consumers
   * do not have to dig into verifyDetails.
   */
  missing?: string;
}

/** Default wall-clock bound for `expect.command` so a hanging check cannot wedge a run record. */
export const DEFAULT_EXPECT_COMMAND_TIMEOUT_MS = 120_000;

/** Options accepted by `evaluateExpect`. */
export interface EvaluateExpectOptions {
  commandTimeoutMs?: number;
}

/**
 * Validate an `expect` spec from an untrusted caller (the gateway does not
 * fully trust tool params and the node does not trust the gateway). Returns
 * the normalized spec, or an error. `undefined`/`null` means "no gate" and is
 * always acceptable (backward compatibility).
 */
export type ExpectSpecResult = { ok: true; expect?: ExpectCheck } | { ok: false; error: string };

export function parseExpectSpec(value: unknown): ExpectSpecResult {
  if (value === undefined || value === null) return { ok: true, expect: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expect must be an object {files?, command?, commands?, timeoutMs?}" };
  }
  const e = value as { files?: unknown; command?: unknown; commands?: unknown; timeoutMs?: unknown };
  const bad = (msg: string): ExpectSpecResult => ({ ok: false, error: msg });

  let files: string[] | undefined;
  if (e.files !== undefined) {
    if (!Array.isArray(e.files)) return bad("expect.files must be an array of strings");
    // Empty-string paths would never exist; refuse rather than always-fail.
    if (e.files.some((x) => typeof x !== "string" || x.trim().length === 0)) {
      return bad("expect.files must be an array of non-empty strings");
    }
    for (const f of e.files as string[]) {
      if (f.includes("\0")) return bad("expect.files entries must not contain NUL");
      // The check runs with the node's privileges: an absolute or `..` path would
      // let the caller probe for files anywhere on the node.
      if (isAbsolute(f) || f.split(/[\\/]/).includes("..")) {
        return bad(`expect.files entry ${JSON.stringify(f)} must be relative to the run directory without '..'`);
      }
    }
    files = e.files as string[];
  }

  let command: string | undefined;
  if (e.command !== undefined) {
    if (typeof e.command !== "string" || e.command.trim().length === 0) {
      return bad("expect.command must be a non-empty string");
    }
    if (e.command.includes("\0")) return bad("expect.command must not contain NUL");
    command = e.command;
  }

  // Issue #104: the plural gate. Each entry is validated like the single
  // `command` (non-empty, no NUL) so the plural cannot smuggle what the
  // singular would refuse.
  let commands: string[] | undefined;
  if (e.commands !== undefined) {
    if (!Array.isArray(e.commands) || e.commands.some((c) => typeof c !== "string" || c.trim().length === 0)) {
      return bad("expect.commands must be an array of non-empty strings");
    }
    for (const c of e.commands as string[]) {
      if (c.includes("\0")) return bad("expect.commands entries must not contain NUL");
    }
    commands = e.commands as string[];
  }

  // Issue #104: the shared bound. A malformed number would otherwise silently
  // fall back to the default or wedge the gate; refuse instead.
  let timeoutMs: number | undefined;
  if (e.timeoutMs !== undefined) {
    if (typeof e.timeoutMs !== "number" || !Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0) {
      return bad("expect.timeoutMs must be a positive number of milliseconds");
    }
    timeoutMs = e.timeoutMs;
  }

  if (files !== undefined && files.length === 0) files = undefined; // an empty file list checks nothing
  if (commands !== undefined && commands.length === 0) commands = undefined; // an empty command list checks nothing
  if (files === undefined && command === undefined && commands === undefined) {
    // Exact historical text (issue #65 pins it): the plural does not change the
    // "checks nothing" refusal.
    return { ok: false, error: "expect requires at least one of files or command" };
  }
  const expect: ExpectCheck = {
    ...(files !== undefined ? { files } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return { ok: true, expect };
}

/**
 * Resolve one expected path against the run cwd. Relative paths are relative
 * to cwd; an absolute path is honored as-is (both are legitimate "relative to
 * cwd" expectations: the check runs IN that directory).
 */
export function resolveExpectPath(cwd: string, p: string): string {
  return resolve(cwd, p);
}

/**
 * Existence check following symlinks (a broken link does not "exist"). The
 * resolved target must stay inside the run directory: a symlink to somewhere
 * else on the node does not satisfy the gate.
 */
export async function expectFileOk(cwd: string, p: string): Promise<boolean> {
  try {
    const target = resolveExpectPath(cwd, p);
    await stat(target);
    const root = await realpath(cwd);
    const real = await realpath(target);
    const rel = relative(root, real);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * The pure evaluator for the expect gate (issue #62; plural for issue #104).
 *
 * Checks every path in `files` (relative to `cwd`), runs every command in
 * `commands` (the singular `command` is normalized onto it) via `bash -c` in
 * `cwd`, honoring the shared `timeoutMs` bound, and derives `verified` as: all
 * files exist AND every command exited 0 (issue #104: EVERY command must pass
 * for the gate to pass). Never throws for expected failure modes — a missing
 * file, a failing command, or a killed command all produce an honest
 * `verified: false` outcome.
 */
export async function evaluateExpect(
  expect: ExpectCheck,
  cwd: string,
  opts: EvaluateExpectOptions = {},
): Promise<ExpectOutcome> {
  const norm = normalizeExpect(expect);
  const files: ExpectFileCheck[] = await Promise.all(
    (norm.files ?? []).map(async (p) => ({ path: p, ok: await expectFileOk(cwd, p) })),
  );

  const commands: ExpectCommandCheck[] = [];
  for (const cmd of norm.commands) {
    if (typeof cmd !== "string" || cmd.trim().length === 0) continue;
    commands.push(
      await runExpectCommand(cmd, cwd, expect.timeoutMs ?? opts.commandTimeoutMs ?? DEFAULT_EXPECT_COMMAND_TIMEOUT_MS),
    );
  }

  const passed = files.every((f) => f.ok) && commands.every((c) => c.ok);
  // Issue #309: a gate that did not finish is not a failed gate. Only when every failure is a timeout (no file
  // check failed, no command failed outright) is the outcome "unverified" (null); any real failure still wins.
  const timeoutOnly = !passed && files.every((f) => f.ok) && commands.every((c) => c.ok || c.timedOut === true);
  // Issue #324b: the outcome half. #326 already tags a command that could not START its toolchain
  // (exit 126/127) as kind:"environment-unavailable"; treat those the same way as #309's timeouts —
  // the gate never stood a chance, so the result says "unverified" (null), not "failed". Fail-closed
  // per the owner: a command failing WITHOUT timedOut/kind, or a failed file check, still wins false.
  // Mixed edge (one timed-out + one unavailable command): neither timeout-only nor unavailable-only
  // holds, so conservative false — pinned deliberately, like #309's strict shape.
  const unavailableOnly = !passed && files.every((f) => f.ok) && commands.every((c) => c.ok || c.kind === "environment-unavailable");
  const firstMissing = commands.find((c) => c.kind === "environment-unavailable" && c.missing)?.missing;
  const verified: boolean | null = passed ? true : timeoutOnly ? null : unavailableOnly ? null : false;
  const ended = unavailableOnly
    ? { endedBy: "gate-unavailable" as const, ...(firstMissing ? { missing: firstMissing } : {}) }
    : timeoutOnly
      ? { endedBy: "gate-timeout" as const }
      : {};
  if (commands.length === 0) return { verified, verifyDetails: { files } };
  // Issue #104: the ledger shape follows the WIRE shape — a singular `command`
  // records the exact legacy `{files, command}` details (byte-identical, so
  // old consumers keep reading the same shape), only a plural `commands[]`
  // adds the `commands` array (the legacy `command` key stays on the FIRST
  // entry there for the same reason).
  if (expect.commands === undefined) {
    return { verified, verifyDetails: { files, command: commands[0] }, ...ended };
  }
  return {
    verified,
    verifyDetails: { files, commands, command: commands[0] },
    ...ended,
  };
}

/** Hard bound on how long we wait for the whole process group to disappear after SIGKILL. */
const GROUP_REAP_MS = 2_000;

/** Injection points so both platforms' kill paths are testable on one OS. */
export interface KillDeps {
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  taskkill: (pid: number) => void;
}

const realKillDeps = (): KillDeps => ({
  platform: process.platform,
  kill: (pid, signal) => void process.kill(pid, signal),
  taskkill: (pid) => {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  },
});

/**
 * Terminate a spawned process and its descendants. POSIX: SIGKILL the process
 * group (the child was spawned detached, so it leads one). Windows has no
 * negative-pid signalling: use `taskkill /T /F`. Either way fall back to killing
 * the direct child, and never throw.
 */
export function killProcessTree(pid: number | undefined, direct: (() => void) | undefined, deps: KillDeps = realKillDeps()): void {
  if (!pid) {
    direct?.();
    return;
  }
  try {
    if (deps.platform === "win32") deps.taskkill(pid);
    else deps.kill(-pid, "SIGKILL");
    return;
  } catch {
    /* fall through to the direct child */
  }
  try {
    direct?.();
  } catch {
    /* already gone */
  }
}

/** Run the expect command (bash -c, cwd, own process group) and capture its exit status. */
async function runExpectCommand(cmd: string, cwd: string, timeoutMs: number): Promise<ExpectCommandCheck> {
  const { spawn } = await import("node:child_process");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  // Issue #324: capture stderr to a FILE, not a pipe. A pipe keeps the process group's lifetime
  // open, so a detached background job outlives the gate's group kill (#67 caught that regression).
  // A file descriptor does not: the group is reaped as before, and the tail is read after close.
  // The capture is best-effort — any failure here must not change the gate's verdict.
  let errDir: string | undefined;
  let errFile: string | undefined;
  try {
    errDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fleet-gate-err-"));
    errFile = path.join(errDir, "stderr.txt");
  } catch { /* no capture; the classifier simply sees no stderr */ }
  // `exec 2>FILE` first, so the whole command (`a && b`, `;`, comments, `&`) is captured.
  const prefix = errFile ? `exec 2>'${errFile.replace(/'/g, "'\\''")}'\n` : "";
  return new Promise<ExpectCommandCheck>((resolveDone) => {
    let settled = false;
    // detached (POSIX) => its own process group, so a timeout (or exit) can take
    // down forked descendants and background jobs, not just the bash child.
    const child = spawn("bash", ["-c", prefix ? `${prefix}${cmd}` : cmd], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const killTree = () => killProcessTree(child.pid, () => void child.kill("SIGKILL"));
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A gate must not leave stragglers mutating the workspace after it returned.
      killTree();
      const base = { cmd, exitCode, ok: exitCode === 0, ...(timedOut ? { timedOut: true as const } : {}) };
      // Issue #324: classify a non-zero exit as environmental (a missing toolchain) vs a real
      // failure, from the captured stderr tail. Read it, then clean up, both best-effort.
      const classifyAndFinish = (errTail: string) => {
        const env = timedOut || exitCode === 0 || exitCode === null ? undefined : classifyEnvironmentFailure(cmd, exitCode, errTail);
        resolveDone({ ...base, ...(env ? { kind: "environment-unavailable" as const, ...(env.missing ? { missing: env.missing } : {}) } : {}) });
        if (errDir) void fsp.rm(errDir, { recursive: true, force: true }).catch(() => {});
      };
      if (!errFile || exitCode === 0 || exitCode === null || timedOut) return classifyAndFinish("");
      void fsp
        .readFile(errFile, "utf8")
        .then((s) => classifyAndFinish(s.slice(-2000)))
        .catch(() => classifyAndFinish(""));
    };
    const timer = setTimeout(() => {
      // A hanging gate must not hang the run record; it is recorded as TIMED OUT (not failed, issue #309).
      timedOut = true;
      killTree();
      setTimeout(() => finish(null), GROUP_REAP_MS).unref();
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(typeof code === "number" ? code : null));
  });
}

/**
 * Issue #324: is a non-zero gate exit an ENVIRONMENT failure or a TEST failure?
 *
 * Exit 127 is the POSIX shell's "command not found"; a Node/TS repo whose clone has no `node_modules`
 * fails exactly here (`sh: 1: tsc: not found`) and used to read as `verified: false` — a verdict on the
 * work for something that never had a chance to run. Other known signatures of a missing/damaged
 * toolchain are matched too. Everything else is a genuine test failure.
 *
 * Returns the missing tool when it can be named (best effort), else an empty object. Pure.
 */
export function classifyEnvironmentFailure(cmd: string, exitCode: number, stderrTail: string): { missing?: string } | undefined {
  const t = String(stderrTail ?? "");
  // Only the shell's own "cannot execute" (126) / "not found" (127) are environmental; a test that
  // exits 1 printing "Cannot find module" is a genuine failure of the work.
  if (exitCode !== 126 && exitCode !== 127) return undefined;
  const notFound = /([\w.@/-]+):\s*(?:command )?not found\b/.exec(t);
  void cmd;
  return { ...(notFound?.[1] ? { missing: notFound[1] } : {}) };
}

/**
 * Merge a node-side verification outcome (e.g. the parsed run payload) onto a
 * result object so EVERY gateway tool result carries the same `verified`
 * shape (issue #62; review finding: the sync path omitted the key entirely
 * while the detached path returned `verified: null`).
 *
 * `verified` is ALWAYS present on the returned object: null when no gate was
 * evaluated (absent `expect`) or the outcome carries no boolean, boolean
 * otherwise; `verifyDetails` rides alongside (null when unknown). Consumers
 * can rely on `verified in result` without probing tool shapes.
 */
export function withVerified<T extends Record<string, unknown>>(
  target: T,
  outcome: { verified?: boolean; verifyDetails?: unknown } | null,
): T & { verified: boolean | null; verifyDetails: unknown } {
  const verified = typeof outcome?.verified === "boolean" ? outcome.verified : null;
  return {
    ...target,
    verified,
    verifyDetails: outcome?.verifyDetails ?? null,
  };
}

/** Extra time the relay must allow when a verification gate runs after the worker. */
export const GATE_RELAY_GRACE_MS = 15_000;

/**
 * The relay timeout for a run that carries a gate: the worker's own budget PLUS
 * the gate's bound and a grace period, so a worker that uses its whole budget
 * still returns `verified` instead of the relay timing out mid-gate. Issue
 * #104: a spec-declared shared `timeoutMs` overrides the default bound in the
 * budget too (bounded below by the default so the relay never budgets LESS
 * than the historical grace).
 */
export function relayTimeoutWithGate(timeoutMs: number, hasGate: boolean, gate?: ExpectCheck): number {
  if (!hasGate) return timeoutMs;
  return timeoutMs + Math.max(gate?.timeoutMs ?? DEFAULT_EXPECT_COMMAND_TIMEOUT_MS, DEFAULT_EXPECT_COMMAND_TIMEOUT_MS) + GATE_RELAY_GRACE_MS;
}
