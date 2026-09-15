/**
 * Post-install self-check for fleet_deploy (issue #24).
 *
 * Every false-success defect in this repo's history — #12, #13, #18, #22 —
 * had the same shape: a check that could not measure reported a verdict
 * anyway. The missing piece was always the same: an *end-to-end* assertion
 * that the installed plugin actually does the thing it claims.
 *
 * This module runs a known-trivial dispatch through the freshly installed
 * plugin on a node and asserts a token comes back. If it does not, the deploy
 * FAILS — because "installed and verified by hash" is still not "works".
 *
 * It is deliberately transport-level (SSH + the node's own `opencode`) rather
 * than going through the manager's node channel, so it exercises the same
 * principal and PATH the real dispatch will use.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface SelfCheckResult {
  ok: boolean;
  /** The token we asked the worker to echo. */
  token: string;
  /** Whether the token appeared in the worker's output. */
  tokenSeen: boolean;
  /** Truncated worker output for diagnosis. */
  output?: string;
  /** The cwd the check ran in (must be traversable by the worker principal). */
  cwd?: string;
  error?: string;
}

/** Quote a string for safe use as a single POSIX shell argument. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pick a cwd the worker principal can actually traverse.
 *
 * Issue #26 is the wider version of this, but even the self-check needs a
 * usable directory: probing from a cwd the worker cannot enter would fail for
 * the wrong reason and look like "the plugin is broken".
 *
 * We prefer the service user's HOME, then /tmp. Both are traversable by the
 * service principal on a normal install.
 */
export function selfCheckCwdCandidates(serviceHome: string | undefined): string[] {
  const out: string[] = [];
  if (serviceHome && serviceHome.startsWith("/")) out.push(serviceHome);
  out.push("/tmp");
  return out;
}

/**
 * Build the shell command that runs a trivial dispatch through the node's own
 * `opencode`, echoing a unique token. Runs AS THE WORKER PRINCIPAL so it
 * exercises the same code path a real dispatch will.
 *
 * Bug-#22-aware: the prompt is passed AFTER `--` so it is delivered as the
 * message, never absorbed as a flag value. If the installed build still has
 * the #22 defect, the prompt is mispositioned and the token will not come
 * back — which is exactly what we want to detect.
 */
export function selfCheckScript(cwd: string, token: string, timeoutSec = 90): string {
  // Keep the prompt single-line and unambiguous so a passing result cannot be
  // confused with a refusal/greeting.
  const prompt = `Reply with exactly this token and nothing else: ${token}`;
  return [
    `cd ${shq(cwd)} || { echo "FLEET_SELFCHECK_CD_FAILED"; exit 66; }`,
    `timeout ${timeoutSec} opencode run --format json -- ${shq(prompt)} 2>&1`,
    `echo "FLEET_SELFCHECK_EXIT=$?"`,
  ].join("\n");
}

/**
 * Decide whether a self-check passed, from raw output. Pure, so it is unit
 * testable without a node.
 *
 * PASS requires the token to appear in the output. We deliberately do NOT
 * accept "exit 0" alone: a run that opens an empty session exits 0 and would
 * otherwise look like success (this is the #22 lesson).
 */
export function evaluateSelfCheck(raw: string, token: string): { ok: boolean; tokenSeen: boolean; detail: string } {
  const tokenSeen = raw.includes(token);
  const cdFailed = raw.includes("FLEET_SELFCHECK_CD_FAILED");
  const exitMatch = raw.match(/FLEET_SELFCHECK_EXIT=(-?\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;

  if (cdFailed) {
    return { ok: false, tokenSeen: false, detail: "worker principal could not enter the self-check cwd" };
  }
  if (!tokenSeen) {
    const why = exitCode === undefined
      ? "no exit marker and no token in output"
      : `exit ${exitCode} but the token never appeared`;
    return { ok: false, tokenSeen: false, detail: `${why} — the installed dispatch did not deliver the prompt` };
  }
  return { ok: true, tokenSeen: true, detail: `token echoed (exit ${exitCode ?? "?"})` };
}

/**
 * Run the post-install self-check against one node, AS THE WORKER PRINCIPAL.
 *
 * @param sshArgs   SSH_ARGS
 * @param sshHost   host or user@host
 * @param serviceUser  the worker principal, or undefined to run as the SSH user
 * @param serviceHome  the worker principal's HOME (for cwd preference)
 */
export async function runSelfCheck(
  sshArgs: string[],
  sshHost: string,
  serviceUser: string | undefined,
  serviceHome: string | undefined,
  timeoutSec = 120,
): Promise<SelfCheckResult> {
  // A unique token so a stale/cached output cannot be mistaken for a fresh pass.
  const token = `FLEET_SELFCHECK_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const candidates = selfCheckCwdCandidates(serviceHome);
  let lastError = "";

  for (const cwd of candidates) {
    const script = selfCheckScript(cwd, token, 90);
    // Issue #24: do NOT wrap an already-quoted multi-line script in another
    // shq() for `bash -c` — the second escaping layer corrupts the inner
    // quoting (paths gain a stray backslash). Instead feed the script to bash
    // over stdin, which applies no further escaping.
    //
    //   sudo -n -u <user> -H bash -s <<'FLEET_SC_EOF'
    //   <script>
    //   FLEET_SC_EOF
    //
    // The heredoc is quoted ('FLEET_SC_EOF') so nothing inside is expanded by
    // the outer shell; `-s` makes bash read the program from stdin.
    const heredoc = `sudo -n -u ${shq(serviceUser ?? "root")} -H bash -s <<'FLEET_SC_EOF'\n${script}\nFLEET_SC_EOF`;
    const cmd = serviceUser ? heredoc : script;
    let raw = "";
    try {
      const { stdout } = await execFileP("ssh", [...sshArgs, sshHost, cmd], { timeout: timeoutSec * 1000 });
      raw = stdout;
    } catch (e) {
      const anyErr = e as { stdout?: string; message?: string };
      raw = anyErr.stdout ?? "";
      if (!raw.trim()) {
        lastError = anyErr.message ?? "self-check command failed with no output";
      }
    }
    if (!raw.trim()) continue;
    const verdict = evaluateSelfCheck(raw, token);
    if (verdict.ok) {
      return { ok: true, token, tokenSeen: true, cwd, output: raw.slice(-800) };
    }
    lastError = `${cwd}: ${verdict.detail}`;
    // If the failure was specifically that the worker could not cd in, try the
    // next candidate; otherwise a real dispatch failure — stop and report it.
    if (!verdict.detail.includes("could not enter the self-check cwd")) {
      return { ok: false, token, tokenSeen: false, cwd, output: raw.slice(-800), error: lastError };
    }
  }

  return { ok: false, token, tokenSeen: false, error: lastError || "self-check produced no output" };
}
