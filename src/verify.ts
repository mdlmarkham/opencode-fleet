/**
 * Issue #62: OPTIONAL post-run verification gate.
 *
 * A worker that exits 0 but produced nothing must not be reported as a
 * success. `fleet_dispatch` accepts an optional `expect` spec:
 *
 *     { files?: string[]; command?: string }
 *
 * After the worker process finishes, the NODE evaluates the spec in the run's
 * cwd and records the outcome alongside the run result:
 *
 *   - every path in `expect.files` must exist (relative to cwd, and inside it:
 *     absolute paths and `..` are refused, symlinks that leave cwd do not count);
 *   - if `expect.command` is given, it is run via `bash -c` in cwd and must
 *     exit 0.
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

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The `expect` gate spec a dispatch can carry. */
export interface ExpectCheck {
  /** Paths relative to the run cwd that must exist after the run (absolute paths and `..` are refused). */
  files?: string[];
  /** Command run via `bash -c` in the run cwd; must exit 0. */
  command?: string;
}

/** Per-path outcome of the file-existence check. */
export interface ExpectFileCheck {
  path: string;
  ok: boolean;
}

/** Outcome of the verification command (absent when no command was given). */
export interface ExpectCommandCheck {
  cmd: string;
  exitCode: number | null;
  ok: boolean;
}

/** Full result of evaluating an `expect` spec. */
export interface VerifyDetails {
  files: ExpectFileCheck[];
  command?: ExpectCommandCheck;
}

/** Outcome recorded on the run result (issue #62). */
export interface ExpectOutcome {
  verified: boolean;
  verifyDetails: VerifyDetails;
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
    return { ok: false, error: "expect must be an object {files?, command?}" };
  }
  const e = value as { files?: unknown; command?: unknown };
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

  if (files !== undefined && files.length === 0) files = undefined; // an empty file list checks nothing
  if (files === undefined && command === undefined) {
    return { ok: false, error: "expect requires at least one of files or command" };
  }
  return { ok: true, expect: { files, command } };
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
 * The pure evaluator for the expect gate (issue #62).
 *
 * Checks every path in `files` (relative to `cwd`), runs `command` via
 * `bash -c` in `cwd` when given, and derives `verified` as: all files exist
 * AND (no command OR command exited 0). Never throws for expected failure
 * modes — a missing file, a failing command, or a killed command all produce
 * an honest `verified: false` outcome.
 */
export async function evaluateExpect(
  expect: ExpectCheck,
  cwd: string,
  opts: EvaluateExpectOptions = {},
): Promise<ExpectOutcome> {
  const files: ExpectFileCheck[] = await Promise.all(
    (expect.files ?? []).map(async (p) => ({ path: p, ok: await expectFileOk(cwd, p) })),
  );

  let command: ExpectCommandCheck | undefined;
  if (typeof expect.command === "string" && expect.command.trim().length > 0) {
    command = await runExpectCommand(expect.command, cwd, opts.commandTimeoutMs ?? DEFAULT_EXPECT_COMMAND_TIMEOUT_MS);
  }

  const verified =
    files.every((f) => f.ok) && (command ? command.ok : true);
  return { verified, verifyDetails: command ? { files, command } : { files } };
}

/** Hard bound on how long we wait for the whole process group to disappear after SIGKILL. */
const GROUP_REAP_MS = 2_000;

/** Run the expect command (bash -c, cwd, own process group) and capture its exit status. */
async function runExpectCommand(cmd: string, cwd: string, timeoutMs: number): Promise<ExpectCommandCheck> {
  const { spawn } = await import("node:child_process");
  return new Promise<ExpectCommandCheck>((resolveDone) => {
    let settled = false;
    // detached => its own process group, so a timeout (or exit) can take down
    // forked descendants and background jobs, not just the bash child.
    const child = spawn("bash", ["-c", cmd], { cwd, stdio: ["ignore", "ignore", "ignore"], detached: true });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A gate must not leave stragglers mutating the workspace after it returned.
      killGroup();
      resolveDone({ cmd, exitCode, ok: exitCode === 0 });
    };
    const timer = setTimeout(() => {
      // A hanging gate must fail, not hang the run record.
      killGroup();
      setTimeout(() => finish(null), GROUP_REAP_MS).unref();
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(typeof code === "number" ? code : null));
  });
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
 * still returns `verified` instead of the relay timing out mid-gate.
 */
export function relayTimeoutWithGate(timeoutMs: number, hasGate: boolean): number {
  return hasGate ? timeoutMs + DEFAULT_EXPECT_COMMAND_TIMEOUT_MS + GATE_RELAY_GRACE_MS : timeoutMs;
}
