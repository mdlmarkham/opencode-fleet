/**
 * Node-side runtime helpers: shell execution, run-state paths, detached
 * launcher, activity/model readers. Extracted from index.ts (issue #43); no
 * behavior change.
 */

import { join } from "node:path";
import { shq } from "./../shell.js";
import { abortStateWrite } from "./../recovery.js";
import { runPaths, writePrivate, xferPaths } from "./../paths.js";
import { DEFAULT_EXPECT_COMMAND_TIMEOUT_MS, type ExpectCheck } from "./../verify.js";

/** One running OpenCode process on a node (from `ps`). */
export interface NodeActivityEntry {
  pid?: number;
  elapsed?: string;
  cpu?: string;
  command?: string;
  error?: string;
}

/** ps command listing running OpenCode processes on a node. */
export function remoteBundlePath(transferId: string): string {
  // Windows-safe temp path (no /tmp assumption).
  return xferPaths(transferId).bundle;
}


export const OPCODE_PS_COMMAND =
  // Match any opencode invocation — including `timeout N opencode run ...`
  // wrapper processes and detached/`nohup` runs — so activity detection
  // covers dispatch runs, not just serve/acp daemons (issue #5).
  `ps -eo pid,etime,pcpu,command | grep -iE "[o]pencode" | grep -vE "grep|opencode-fleet|node-activity" | grep -vE "^[0-9]+ .*opencode (serve|acp) --hostname" || true`;


/**
 * Parse `ps -eo pid,etime,pcpu,command` lines into activity entries.
 */
export function parseActivity(raw: string): NodeActivityEntry[] {
  const out: NodeActivityEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pid, elapsed, cpu, ...rest] = trimmed.split(/\s+/);
    const command = rest.join(" ");
    if (!pid || !command) continue;
    out.push({
      pid: Number.isFinite(Number(pid)) ? Number(pid) : undefined,
      elapsed,
      cpu,
      command,
    });
  }
  return out;
}


/**
 * Read the model catalog from the node's OpenCode config.
 */
export async function readNodeModels(): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(homedir(), ".config", "opencode", "opencode.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      model?: string;
      provider?: Record<string, { name?: string; models?: Record<string, { name?: string }> }>;
    };
    const out: Array<Record<string, unknown>> = [];
    if (cfg.model) out.push({ default: true, id: cfg.model });
    for (const [providerId, p] of Object.entries(cfg.provider ?? {})) {
      for (const [modelId, m] of Object.entries(p.models ?? {})) {
        out.push({ provider: providerId, id: `${providerId}/${modelId}`, name: m.name ?? modelId });
      }
    }
    return out;
  } catch {
    return [{ error: "no OpenCode config found on this node" }];
  }
}


/**
 * Run a shell command on the node host, streaming output chunks.
 * Watchdog: kills the process if no output arrives within maxIdleMs, or if
 * total runtime exceeds maxDurationMs (stuck-loop guard).
 *
 * Shell selection: bash on Unix; on Windows prefer git-bash (keeps POSIX
 * command grammar working), fall back to cmd.exe.
 */
export function nodeShellCommand(): { file: string; argsPrefix: string[] } {
  if (process.platform === "win32") {
    for (const candidate of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("node:fs");
        if (fs.existsSync(candidate)) return { file: candidate, argsPrefix: ["-c"] };
      } catch {
        // probe failed — try next candidate
      }
    }
    return { file: process.env.ComSpec ?? "cmd.exe", argsPrefix: ["/d", "/s", "/c"] };
  }
  return { file: "/bin/bash", argsPrefix: ["-c"] };
}


/** Result of a node shell run, including the real exit code (issue #30 A). */
export interface ShellRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  stuck: boolean;
}


export async function runShell(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => Promise<void>,
  maxIdleMs?: number,
  maxDurationMs?: number,
): Promise<string> {
  return (await runShellDetailed(command, timeoutMs, signal, onChunk, maxIdleMs, maxDurationMs)).output;
}


/**
 * Run a shell command on the node host, returning the output PLUS the real
 * exit code and whether the watchdog killed it. Issue #30 finding A: the Pi
 * parser needs the actual execution status, not just the transcript.
 */
export async function runShellDetailed(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => Promise<void>,
  maxIdleMs?: number,
  maxDurationMs?: number,
): Promise<ShellRunResult> {
  const { spawn } = await import("node:child_process");
  const shell = nodeShellCommand();
  return new Promise<ShellRunResult>((resolve) => {
    const child = spawn(shell.file, [...shell.argsPrefix, command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastChunkAt = Date.now();
    const startedAt = Date.now();
    let exitCode: number | null = null;
    let timedOut = false;
    let stuck = false;

    const finish = (extra: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      resolve({ output: stdout + (stderr ? `\n${stderr}` : "") + extra, exitCode, timedOut, stuck });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish("\n[timeout]");
    }, timeoutMs);

    // Idle watchdog: kill if no output for maxIdleMs.
    const idleTimer = setInterval(() => {
      if (settled) return;
      if (maxIdleMs && Date.now() - lastChunkAt > maxIdleMs) {
        stuck = true;
        child.kill("SIGKILL");
        finish(`\n[stuck: no output for ${Math.round((Date.now() - lastChunkAt) / 1000)}s]`);
      }
      if (maxDurationMs && Date.now() - startedAt > maxDurationMs) {
        stuck = true;
        child.kill("SIGKILL");
        finish(`\n[stuck: exceeded max duration ${Math.round(maxDurationMs / 1000)}s]`);
      }
    }, 5000);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      lastChunkAt = Date.now();
      if (onChunk) onChunk(s).catch(() => {});
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish(`\nERROR: ${err.message}`);
    });
    child.on("close", (code) => {
      if (typeof code === "number") exitCode = code;
      finish("");
    });

    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}


/**
 * Issue #63: identity check for a recorded run pid before any signal is sent.
 *
 * The detached launcher (detachedLaunchCommand) records the pid of the
 * `setsid nohup /bin/bash <run script>` chain, so the live process's cmdline
 * always carries the run's script file name. Matching that marker:
 *   - live + matched  → verified (`live`);
 *   - nothing running at that pid (exited and NOT recycled — a recycled pid
 *     would be visible again) or an unreaped zombie (empty cmdline) → `gone`:
 *     nothing at that pid is signalable, and the process-group check in
 *     abortRunById still covers orphaned children of the run;
 *   - anything else (live with a foreign cmdline = a REUSED pid, an unreadable
 *     /proc entry, a platform without /proc) → refused: never kill.
 */
export type PidIdentity =
  | { ok: true; kind: "live" | "gone" }
  | { ok: false; error: string };

export async function verifyRunPidIdentity(pid: number, scriptPath: string): Promise<PidIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: `invalid recorded pid ${String(pid)} — refusing to kill an unverifiable target` };
  }
  const marker = scriptPath.split(/[\\/]/).filter(Boolean).pop() || scriptPath;
  let cmdline = "";
  try {
    cmdline = (await (await import("node:fs/promises")).readFile(join("/proc", String(pid), "cmdline"), "utf8"))
      .replace(/\0/g, " ");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && (code === "ENOENT" || code === "ESRCH")) {
      return { ok: true, kind: "gone" };
    }
    return {
      ok: false,
      error: `cannot verify pid ${pid} belongs to this run (identity unreadable: ${(e as Error).message}) — refusing to kill`,
    };
  }
  // An empty cmdline means the process is a zombie (already dead, awaiting
  // reaping) or a kernel thread: nothing of it is signalable at that pid.
  if (!cmdline.trim()) return { ok: true, kind: "gone" };
  if (cmdline.includes(marker)) return { ok: true, kind: "live" };
  return {
    ok: false,
    error: `recorded pid ${pid} is alive but is NOT this run's process (its cmdline does not mention ${marker}) — refusing to kill a possibly recycled pid`,
  };
}

/**
 * Engine-independent termination of a recorded run (issue #30 findings H).
 * Reads the recorded pid and kills its process group (covers Pi AND opencode),
 * waiting until the group is actually gone before reporting success.
 *
 * Issue #63: the pid is verified to STILL be this run's process (cmdline
 * marker, see verifyRunPidIdentity) before any signal is sent, so a killed
 * run's recycled pid can never take an innocent process group with it.
 */
export async function abortRunById(
  runId: string,
): Promise<{ ok: boolean; aborted: boolean; pid?: number; confirmed?: boolean; error?: string }> {
  const statePath = runStatePath(runId);
  let pid: number | undefined;
  try {
    const raw = await (await import("node:fs/promises")).readFile(statePath, "utf8");
    pid = (JSON.parse(raw) as { pid?: number }).pid;
  } catch {
    // no state file
  }
  if (!pid) {
    return { ok: false, aborted: false, error: "no recorded run state/pid — cannot terminate engine-independently" };
  }
  // Issue #63: never `kill -- -<pid>` an unverified target. If the run's
  // process exited and the pid was recycled, the old code killed whatever
  // unrelated process (and process group) had inherited the number.
  const identity = await verifyRunPidIdentity(pid, runScriptPath(runId));
  if (!identity.ok) {
    return { ok: false, aborted: false, pid, error: identity.error };
  }
  const out = await runShell(
    `kill -TERM -- -${pid} 2>/dev/null; sleep 1; ` +
      `if kill -0 -- -${pid} 2>/dev/null; then kill -9 -- -${pid} 2>/dev/null; sleep 1; fi; ` +
      `if kill -0 -- -${pid} 2>/dev/null; then echo ALIVE; else echo DEAD; fi`,
    15_000,
  );
  const confirmed = out.includes("DEAD");
  // Issue #30 finding H: only record `aborted` when termination is CONFIRMED.
  // Otherwise leave the state file untouched — never claim aborted for a
  // possibly-live run. Preserve existing fields (harness/piModel/pid/startedAt)
  // so later __RUN_STATUS__/__RUN_RESULT__ reads still parse correctly.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
  } catch { /* keep {} */ }
  const next = abortStateWrite(existing, confirmed, new Date().toISOString());
  if (next) {
    await writePrivate(statePath, JSON.stringify(next)).catch(() => {});
  }
  return { ok: confirmed, aborted: confirmed, pid, confirmed };
}


/**
 * Node-side run-state directory helpers (issue #6: detached execution with a
 * durable completion record).
 *
 * Flow:
 *  1. __RUN_START__ spawns the opencode command DETACHED (nohup + setsid on
 *     unix) and records pid + startedAt in the run-state file. Returns
 *     immediately, so the invoke relay can never kill the run.
 *  2. The worker writes __RUN_RESULT__-readable state (exit marker + final
 *     output) into the same file when it finishes.
 *  3. Manager polls __RUN_STATUS__; reconciles ledger + reports result.
 */

export function runStatePath(runId: string): string {
  return runPaths(runId).state;
}


export function runScriptPath(runId: string): string {
  return runPaths(runId).script;
}


/** Build the detached launcher command for a run (unix; git-bash handles it on Windows). */
export function detachedLaunchCommand(runId: string, scriptPath: string, statePath: string): string {
  // Issue #21: the launcher must be fast and must never block on the child.
  // We bound the whole launch sequence so a wedged node host cannot burn the
  // manager's 30s invoke budget: setsid/nohup return immediately, and the
  // `wait`-free structure means LAUNCHED_PID is echoed right after spawn.
  return [
    `rm -f ${shq(statePath)}`,
    `printf 'pid=0\nstartedAt=%s\n' "$(date +%s)" > ${shq(statePath)}`,
    // setsid detaches from the node-host process group so relay cancellation
    // (node.invoke.cancel kills the process tree) cannot reach the child.
    // NOTE: the background `&` must terminate the whole chain, not sit inside a
    // `&&`-joined element — `... 2>&1 & && echo` is a bash syntax error. So we
    // join the setup steps with `&&`, background that entire chain, then emit
    // the LAUNCHED_PID line as a separate statement.
    `setsid nohup /bin/bash ${shq(scriptPath)} > ${shq(runPaths(runId).log)} 2>&1`,
  ].join(" && ") + ` &\necho "LAUNCHED_PID=$!"`;
}

/** Options for the verification-gate section of the generated launcher. */
export interface VerifyGateOptions {
  /** The run's cwd — the gate is evaluated there. */
  cwd: string;
  /** Wall-clock bound for `expect.command` (default 120s) so a hanging check cannot wedge the run record. */
  commandTimeoutMs?: number;
}

/**
 * Issue #62: the bash fragment that evaluates the optional `expect` gate in
 * the run's cwd AFTER the worker exits, plus the done-marker write.
 *
 * By the time these lines run, the launcher's `inner` command has already
 * cd'd into the workspace (or exited), so cwd is the run cwd; we re-cd
 * defensively and fail closed (verification cannot be satisfied) if that
 * somehow fails.
 *
 * All values are pre-escaped in TypeScript (shq for bash, JSON.stringify for
 * the recorded strings), so bash only moves literals around — no expansion of
 * untrusted content happens on the node.
 */
export function verifyGateScript(
  expect: ExpectCheck,
  donePath: string,
  opts: VerifyGateOptions,
): { verifyLines: string[]; doneLine: string } {
  const files = (expect.files ?? []).filter((p) => typeof p === "string" && p.length > 0);
  const command = typeof expect.command === "string" && expect.command.trim().length > 0 ? expect.command : undefined;
  const timeoutSec = Math.max(1, Math.round((opts.commandTimeoutMs ?? DEFAULT_EXPECT_COMMAND_TIMEOUT_MS) / 1000));

  const lines: string[] = [
    "# Issue #62: post-run verification gate, evaluated in the run's cwd after the worker exits.",
    "__V_ALL_OK=true",
    "__V_FILES_JSON=''",
    `if cd ${shq(opts.cwd)} 2>/dev/null; then __V_CDW=true; else __V_CDW=false; __V_ALL_OK=false; fi`,
  ];
  if (files.length) {
    // Paths are shell-quoted for the existence check; the recorded JSON path
    // strings are pre-rendered with JSON.stringify (then shq-wrapped) so no
    // escaping happens in bash — bash only moves literals around.
    lines.push(`__V_PATHS=( ${files.map(shq).join(" ")} )`);
    lines.push(`__V_JPATHS=( ${files.map((p) => shq(JSON.stringify(p))).join(" ")} )`);
    lines.push("__V_SEP=''");
    lines.push('for __i in "${!__V_PATHS[@]}"; do');
    lines.push('  if [ "$__V_CDW" = true ] && [ -e "${__V_PATHS[$__i]}" ]; then __ok=true; else __ok=false; __V_ALL_OK=false; fi');
    lines.push('  __V_FILES_JSON="${__V_FILES_JSON}${__V_SEP}{\\\"path\\\":${__V_JPATHS[$__i]},\\\"ok\\\":$__ok}"');
    lines.push("__V_SEP=','");
    lines.push("done");
  }
  if (command) {
    lines.push("__V_JCMD=" + shq(JSON.stringify(command)));
    lines.push('if [ "$__V_CDW" = true ]; then');
    lines.push(
      `  if timeout ${timeoutSec} bash -lc ${shq(command)} >/dev/null 2>&1; then __V_CMD_OK=true; __V_CMD_EXIT=0; else __V_CMD_EXIT=$?; __V_CMD_OK=false; __V_ALL_OK=false; fi`,
    );
    lines.push('  __V_CMD_JSON="{\\\"cmd\\\":$__V_JCMD,\\\"exitCode\\\":$__V_CMD_EXIT,\\\"ok\\\":$__V_CMD_OK}"');
    lines.push("else");
    lines.push("  __V_CMD_OK=false; __V_ALL_OK=false");
    lines.push('  __V_CMD_JSON="{\\\"cmd\\\":$__V_JCMD,\\\"exitCode\\\":null,\\\"ok\\\":false}"');
    lines.push("fi");
  }
  // verifyDetails is fully assembled by the generator: the accumulated JSON
  // file array, plus the command object only when one was given.
  lines.push(
    command
      ? '__V_DETAILS="{\\\"files\\\":[$__V_FILES_JSON],\\\"command\\\":$__V_CMD_JSON}"'
      : '__V_DETAILS="{\\\"files\\\":[$__V_FILES_JSON]}"',
  );
  const doneLine =
    `printf '{"done":1,"exitCode":%s,"finishedAt":"%s","verified":%s,"verifyDetails":%s}\\n' "$EC" "$(date -u +%FT%TZ)" "$__V_ALL_OK" "$__V_DETAILS" > ${shq(donePath)}`;
  return { verifyLines: lines, doneLine };
}

/**
 * The done-marker write for a run without an `expect` gate: the exact
 * historical line (issue #6). With a gate (issue #62), `verifyGateScript`
 * returns the verifying done line instead.
 */
export function doneMarkerLine(donePath: string): string {
  return `printf '{"done":1,"exitCode":%s,"finishedAt":"%s"}\\n' "$EC" "$(date -u +%FT%TZ)" > ${shq(donePath)}`;
}
