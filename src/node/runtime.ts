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


/** One row of the process table (`ps -eo pid=,pgid=,args=`). */
export interface ProcRow {
  pid: number;
  pgid: number;
  /** Session id: every descendant of a `setsid` script shares the script's. */
  sid: number;
  /** `ps` state letters (first letter `Z` = zombie: dead, merely not yet reaped). */
  stat: string;
  args: string;
}

/** Command whose output `parseProcessTable` reads. */
export const PS_TABLE_COMMAND = "ps -eo pid=,pgid=,sid=,stat=,args=";

/** Parse `PS_TABLE_COMMAND` output. Unparseable lines are skipped; zombies are dropped (they are dead). */
export function parseProcessTable(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m && !m[4].startsWith("Z")) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), sid: Number(m[3]), stat: m[4], args: m[5] });
  }
  return rows;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The processes that ARE a run's script: `bash [flags] <scriptPath>` and nothing
 * else that merely mentions the path (an editor, `tail -f`, ...). The script path
 * is unique per run and lives in a private directory, so this identifies the run
 * without trusting a recorded pid (which can be stale, reused, or the launcher
 * subshell instead of the script: issue #69).
 */
export function runScriptRows(rows: ProcRow[], scriptPath: string): ProcRow[] {
  const re = new RegExp(`(?:^|/)bash(?:\\s+-\\S+)*\\s+${escapeRe(scriptPath)}\\s*$`);
  return rows.filter((r) => re.test(r.args));
}

/** Injection points so the abort logic is testable with real or fake processes. */
export interface AbortDeps {
  /** Raw `PS_TABLE_COMMAND` output. */
  list: () => Promise<string>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

const realAbortDeps = (): AbortDeps => ({
  list: () => runShell(PS_TABLE_COMMAND, 10_000),
  kill: (pid, signal) => void process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Poll until no process remains in any of `pgids`, up to `waitMs`. */
async function groupsGone(deps: AbortDeps, pgids: Set<number>, sids: Set<number>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = parseProcessTable(await deps.list());
    if (!rows.some((r) => pgids.has(r.pgid) || sids.has(r.sid))) return true;
    if (Date.now() >= deadline) return false;
    await deps.sleep(150);
  }
}

/**
 * Engine-independent termination of a detached run (issues #30, #69).
 *
 * The run is found by its SCRIPT, not by a recorded pid: the process table is
 * searched for `bash <run script>`, its process group (the script is a
 * session/group leader after `setsid`) is signalled — TERM, then KILL — and
 * success is reported only when NO process remains in that group. If nothing
 * is running, that is said plainly; it is never reported as an abort.
 */
export async function abortRunById(
  runId: string,
  deps: AbortDeps = realAbortDeps(),
): Promise<{ ok: boolean; aborted: boolean; pid?: number; pgid?: number; confirmed?: boolean; alreadyFinished?: boolean; error?: string }> {
  const statePath = runStatePath(runId);
  const scriptPath = runScriptPath(runId);
  let rows: ProcRow[];
  try {
    rows = parseProcessTable(await deps.list());
  } catch (e) {
    return { ok: false, aborted: false, error: `cannot list processes on this node: ${(e as Error).message}` };
  }
  const leaders = runScriptRows(rows, scriptPath);
  if (!leaders.length) {
    let finished = false;
    try {
      await (await import("node:fs/promises")).stat(runPaths(runId).done);
      finished = true;
    } catch { /* no done record */ }
    return {
      ok: false,
      aborted: false,
      alreadyFinished: finished,
      error: finished
        ? "run already finished; nothing to abort"
        : "no live process for this run (it never started, died, or was already stopped); nothing was signalled",
    };
  }
  // Never signal our own group, init, or a group that is not the script's own.
  const own = rows.find((r) => r.pid === process.pid)?.pgid;
  // The engine usually runs in its OWN process group (e.g. under `timeout`), so
  // signal every group in the script's session, not just the script's.
  const sids = new Set(leaders.map((r) => r.sid).filter((x) => x > 1));
  const pgids = new Set(leaders.map((r) => r.pgid));
  for (const r of rows) if (sids.has(r.sid)) pgids.add(r.pgid);
  for (const g of pgids) {
    if (g <= 1 || g === own) {
      return { ok: false, aborted: false, error: `refusing to signal process group ${g}: it is not the run's own group` };
    }
  }
  for (const g of pgids) {
    try { deps.kill(-g, "SIGTERM"); } catch { /* group already gone */ }
  }
  let gone = await groupsGone(deps, pgids, sids, 3_000);
  if (!gone) {
    for (const g of pgids) {
      try { deps.kill(-g, "SIGKILL"); } catch { /* gone */ }
    }
    gone = await groupsGone(deps, pgids, sids, 2_000);
  }
  const confirmed = gone;
  const pid = leaders[0].pid;
  const pgid = leaders[0].pgid;
  // Issue #30 finding H: only record `aborted` when termination is CONFIRMED.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
  } catch { /* keep {} */ }
  const next = abortStateWrite(existing, confirmed, new Date().toISOString());
  if (next) {
    await writePrivate(statePath, JSON.stringify(next)).catch(() => {});
  }
  return { ok: confirmed, aborted: confirmed, pid, pgid, confirmed };
}

/**
 * Lines at the top of a run's script that publish its OWN state: the script is
 * the one process that knows its real pid/pgid (after `setsid` it leads both),
 * so it writes the state file itself, atomically, as valid JSON, before doing
 * anything else. No placeholder, no dependence on the launcher or the handler
 * surviving (issue #64).
 */
export function selfStateLines(statePath: string, base: Record<string, unknown>): string[] {
  // JSON for the static fields, with the closing brace left off; `%` doubled for printf.
  const head = JSON.stringify(base).slice(0, -1).replace(/\\/g, "\\\\").replace(/%/g, "%%");
  return [
    `__ST=${shq(statePath)}`,
    `__PG=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')`,
    `printf '${head.replace(/'/g, `'\\''`)},"pid":%s,"pgid":%s,"startedAt":"%s","state":"running"}\n' "$$" "\${__PG:-$$}" "$(date -u +%FT%TZ)" > "$__ST.tmp" && mv -f "$__ST.tmp" "$__ST"`,
  ];
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
    // setsid detaches from the node-host process group so relay cancellation
    // (node.invoke.cancel kills the process tree) cannot reach the child.
    // NOTE: the background `&` must terminate the whole chain, not sit inside a
    // `&&`-joined element — `... 2>&1 & && echo` is a bash syntax error. So we
    // join the setup steps with `&&`, background that entire chain, then emit
    // the LAUNCHED_PID line as a separate statement.
    `setsid nohup /bin/bash ${shq(scriptPath)} > ${shq(runPaths(runId).log)} 2>&1`,
  ].join(" && ").replace(/^/, "{ ") + `; } > /dev/null 2>&1 < /dev/null &\necho "LAUNCHED_PID=$!"`;
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
    lines.push("__V_ROOT=$(pwd -P 2>/dev/null)");
    lines.push(`__V_PATHS=( ${files.map(shq).join(" ")} )`);
    lines.push(`__V_JPATHS=( ${files.map((p) => shq(JSON.stringify(p))).join(" ")} )`);
    lines.push("__V_SEP=''");
    lines.push('for __i in "${!__V_PATHS[@]}"; do');
    // Exists AND resolves inside the run directory (a symlink out of it does not count).
    lines.push('  __ok=false');
    lines.push('  if [ "$__V_CDW" = true ] && [ -e "${__V_PATHS[$__i]}" ]; then');
    lines.push('    __rp=$(realpath -e -- "${__V_PATHS[$__i]}" 2>/dev/null)');
    lines.push('    case "$__rp" in "$__V_ROOT"/*) __ok=true;; esac');
    lines.push('  fi');
    lines.push('  if [ "$__ok" != true ]; then __V_ALL_OK=false; fi');
    lines.push('  __V_FILES_JSON="${__V_FILES_JSON}${__V_SEP}{\\\"path\\\":${__V_JPATHS[$__i]},\\\"ok\\\":$__ok}"');
    lines.push("__V_SEP=','");
    lines.push("done");
  }
  if (command) {
    lines.push("__V_JCMD=" + shq(JSON.stringify(command)));
    lines.push('if [ "$__V_CDW" = true ]; then');
    lines.push(
      `  if timeout -k 5 ${timeoutSec} bash -c ${shq(command)} >/dev/null 2>&1; then __V_CMD_OK=true; __V_CMD_EXIT=0; else __V_CMD_EXIT=$?; __V_CMD_OK=false; __V_ALL_OK=false; fi`,
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
