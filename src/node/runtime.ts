/**
 * Node-side runtime helpers: shell execution, run-state paths, detached
 * launcher, activity/model readers. Extracted from index.ts (issue #43); no
 * behavior change.
 */

import { dirname, join, resolve } from "node:path";
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
  const re = new RegExp(`^(?:\\S*/)?bash(?:\\s+-\\S+)*\\s+${escapeRe(scriptPath)}\\s*$`);
  return rows.filter((r) => re.test(r.args));
}

/** Injection points so the abort logic is testable with real or fake processes. */
export interface AbortDeps {
  /** Raw `PS_TABLE_COMMAND` output. */
  list: () => Promise<string>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

/** Raw process table; THROWS if `ps` failed or timed out (its diagnostics must never parse as "no processes"). */
export async function listProcessTable(signal?: AbortSignal): Promise<string> {
  const r = await runShellDetailed(PS_TABLE_COMMAND, 10_000, signal);
  if (r.timedOut || r.exitCode !== 0) throw new Error(`ps failed (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})`);
  return r.output;
}

const realAbortDeps = (): AbortDeps => ({
  list: () => listProcessTable(),
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
  // Groups can appear after any snapshot (an engine child may setsid), so every
  // signal round re-reads the table and targets the session's CURRENT groups.
  const signalRound = async (sig: NodeJS.Signals): Promise<void> => {
    const live = parseProcessTable(await deps.list());
    for (const r of live) if (sids.has(r.sid)) pgids.add(r.pgid);
    for (const g of pgids) {
      if (g <= 1 || g === own) continue;
      try { deps.kill(-g, sig); } catch { /* group already gone */ }
    }
  };
  let gone: boolean;
  try {
    await signalRound("SIGTERM");
    gone = await groupsGone(deps, pgids, sids, 3_000);
    if (!gone) {
      await signalRound("SIGKILL");
      gone = await groupsGone(deps, pgids, sids, 2_000);
    }
  } catch (e) {
    return { ok: false, aborted: false, error: `cannot confirm termination: ${(e as Error).message}` };
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
 * Issue #104: the gate may carry a plural `commands[]` (every entry must exit
 * 0) with a shared `timeoutMs`; a singular `command` is normalized onto the
 * same plural loop so bash has one evaluation path too. The recorded details
 * keep the legacy singular `command` key on the FIRST entry for old consumers.
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
  const commands = (expect.commands ?? (expect.command !== undefined ? [expect.command] : []))
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  // Legacy shape: a singular `command` spec generates the exact historical
  // lines (issue #62 tests pin them); a plural `commands` spec takes the
  // normalized loop. One evaluation semantics (every command must exit 0,
  // bounded); only the emitted bytes differ for wire-shape compatibility.
  const plural = expect.commands !== undefined;
  const sharedTimeout = expect.timeoutMs ?? opts.commandTimeoutMs ?? DEFAULT_EXPECT_COMMAND_TIMEOUT_MS;

  const lines: string[] = [
    "# Issue #62: post-run verification gate, evaluated in the run's cwd after the worker exits.",
    "__V_ALL_OK=true",
    // Issue #309: a gate command killed by its own time bound (timeout exits 124, or 137 after the -k grace) did
    // not finish: that is "unverified", not "failed". HARD marks any real failure; TO marks a timeout.
    "__V_HARD=false",
    "__V_TO=false",
    "__V_FILES_JSON=''",
    `if cd ${shq(opts.cwd)} 2>/dev/null; then __V_CDW=true; else __V_CDW=false; __V_ALL_OK=false; __V_HARD=true; fi`,
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
    lines.push('  if [ "$__ok" != true ]; then __V_ALL_OK=false; __V_HARD=true; fi');
    lines.push('  __V_FILES_JSON="${__V_FILES_JSON}${__V_SEP}{\\\"path\\\":${__V_JPATHS[$__i]},\\\"ok\\\":$__ok}"');
    lines.push("__V_SEP=','");
    lines.push("done");
  }
  if (commands.length) {
    // Issue #104: the plural path is a normalized loop over the commands —
    // each runs via `bash -c`, must exit 0, and is bounded (record order
    // preserved). A singular `command` (plural === false) keeps the EXACT
    // legacy fragment bytes (issue #62 tests pin them) — but it is the SAME
    // evaluation semantics: run 1 command, require exit 0. One normalized
    // representation in TypeScript (the `commands` array above) drives both;
    // only the emitted bytes differ for wire-shape compatibility.
    const timeoutSec = String(Math.max(1, Math.round(sharedTimeout / 1000)));
    if (!plural) {
      const command = commands[0];
      lines.push("__V_JCMD=" + shq(JSON.stringify(command)));
      lines.push('if [ "$__V_CDW" = true ]; then');
      lines.push(
        `  if timeout -k 5 ${timeoutSec} bash -c ${shq(command)} >/dev/null 2>&1; then __V_CMD_OK=true; __V_CMD_EXIT=0; else __V_CMD_EXIT=$?; __V_CMD_OK=false; __V_ALL_OK=false; fi`,
      );
      lines.push('  case "$__V_CMD_OK$__V_CMD_EXIT" in true0) ;; false124|false137) __V_TO=true;; *) __V_HARD=true;; esac');
      lines.push('  __V_CMD_JSON="{\\\"cmd\\\":$__V_JCMD,\\\"exitCode\\\":$__V_CMD_EXIT,\\\"ok\\\":$__V_CMD_OK}"');
      lines.push("else");
      lines.push("  __V_CMD_OK=false; __V_ALL_OK=false; __V_HARD=true");
      lines.push('  __V_CMD_JSON="{\\\"cmd\\\":$__V_JCMD,\\\"exitCode\\\":null,\\\"ok\\\":false}"');
      lines.push("fi");
      lines.push('__V_DETAILS="{\\\"files\\\":[$__V_FILES_JSON],\\\"command\\":$__V_CMD_JSON}"');
    } else {
    lines.push(`__V_CMDS=( ${commands.map(shq).join(" ")} )`);
    lines.push(`__V_JCMDS=( ${commands.map((c) => shq(JSON.stringify(c))).join(" ")} )`);
    lines.push(`__V_TOOLS=( ${commands.map(() => String(Math.max(1, Math.round(sharedTimeout / 1000)))).join(" ")} )`);
    lines.push("__V_CMDS_JSON=''");
    lines.push("__V_SEP=''");
    lines.push('for __i in "${!__V_CMDS[@]}"; do');
    lines.push('if [ "$__V_CDW" = true ]; then');
    lines.push(
      `  if timeout -k 5 "\${__V_TOOLS[$__i]}" bash -c "\${__V_CMDS[$__i]}" >/dev/null 2>&1; then __V_CMD_OK=true; __V_CMD_EXIT=0; else __V_CMD_EXIT=$?; __V_CMD_OK=false; __V_ALL_OK=false; fi`,
    );
    lines.push('  case "$__V_CMD_OK$__V_CMD_EXIT" in true0) ;; false124|false137) __V_TO=true;; *) __V_HARD=true;; esac');
    lines.push('  __V_CMD_JSON="{\\\"cmd\\\":${__V_JCMDS[$__i]},\\\"exitCode\\\":$__V_CMD_EXIT,\\\"ok\\\":$__V_CMD_OK}"');
    lines.push("else");
    lines.push("  __V_CMD_OK=false; __V_ALL_OK=false; __V_HARD=true");
    lines.push('  __V_CMD_JSON="{\\\"cmd\\\":${__V_JCMDS[$__i]},\\\"exitCode\\\":null,\\\"ok\\\":false}"');
    lines.push("fi");
    lines.push('  __V_CMDS_JSON="${__V_CMDS_JSON}${__V_SEP}$__V_CMD_JSON"');
    lines.push('  if [ "$__i" -eq 0 ]; then __V_FIRST_JSON="$__V_CMD_JSON"; fi');
    lines.push("__V_SEP=','");
    lines.push("done");
    lines.push(
      '__V_DETAILS="{\\\"files\\\":[$__V_FILES_JSON],\\\"command\\":$__V_FIRST_JSON,\\\"commands\\":[$__V_CMDS_JSON]}"',
    );
    }
  } else {
    lines.push('__V_DETAILS="{\\\"files\\\":[$__V_FILES_JSON]}"');
  }
  // verified: true when everything passed; null (+ endedBy gate-timeout) when the ONLY failures were timeouts; else false.
  lines.push('if [ "$__V_ALL_OK" = true ]; then __V_VERIFIED=true; __V_ENDED=\'\'; elif [ "$__V_HARD" = false ] && [ "$__V_TO" = true ]; then __V_VERIFIED=null; __V_ENDED=\',"endedBy":"gate-timeout"\'; else __V_VERIFIED=false; __V_ENDED=\'\'; fi');
  const doneLine =
    `printf '{"done":1,"exitCode":%s,"finishedAt":"%s","verified":%s,"verifyDetails":%s%s}\\n' "$EC" "$(date -u +%FT%TZ)" "$__V_VERIFIED" "$__V_DETAILS" "$__V_ENDED" > ${shq(donePath)}`;
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

export interface PruneResult {
  removedRuns: string[];
  removedTransfers: string[];
  keptAlive: string[];
  errors: string[];
}

/**
 * Remove finished runs' files (script, log, state, done marker) and stale
 * transfer staging from the private state dir (issue #63). Only entries whose
 * names match the exact fleet patterns are considered; a run whose script is in
 * `aliveRunIds` is never touched; an entry is pruned only when EVERY file of it
 * is older than the cutoff. Symlinks are never followed.
 */
export async function pruneStateDir(
  dir: string,
  olderThanMs: number,
  aliveRunIds: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<PruneResult> {
  const fsp = await import("node:fs/promises");
  const out: PruneResult = { removedRuns: [], removedTransfers: [], keptAlive: [], errors: [] };
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  const cutoff = now - olderThanMs;
  const runFiles = new Map<string, string[]>();
  const xfers = new Map<string, string[]>();
  for (const n of names) {
    let m = n.match(/^run-([A-Za-z0-9_-]{1,64})\.(json|sh|log|changes)$/) ?? n.match(/^(?:done|manifest)-([A-Za-z0-9_-]{1,64})\.json$/);
    if (m) {
      (runFiles.get(m[1]) ?? runFiles.set(m[1], []).get(m[1])!).push(n);
      continue;
    }
    m = n.match(/^xfer-([A-Za-z0-9_-]{1,64})(?:\.bundle)?$/);
    if (m) (xfers.get(m[1]) ?? xfers.set(m[1], []).get(m[1])!).push(n);
  }
  const newest = async (files: string[]): Promise<number | undefined> => {
    let max = 0;
    for (const f of files) {
      try {
        max = Math.max(max, (await fsp.lstat(`${dir}/${f}`)).mtimeMs);
      } catch {
        /* vanished */
      }
    }
    return max || undefined;
  };
  const remove = async (files: string[]) => {
    for (const f of files) {
      const full = `${dir}/${f}`;
      try {
        const st = await fsp.lstat(full);
        // a plain file, or a real directory (never a symlink target)
        if (st.isSymbolicLink() || st.isFile()) await fsp.unlink(full);
        else if (st.isDirectory()) await fsp.rm(full, { recursive: true, force: true });
      } catch (e) {
        out.errors.push(`${f}: ${(e as Error).message}`);
      }
    }
  };
  for (const [id, files] of runFiles) {
    if (aliveRunIds.has(id)) { out.keptAlive.push(id); continue; }
    const t = await newest(files);
    if (t !== undefined && t < cutoff) {
      await remove(files);
      out.removedRuns.push(id);
    }
  }
  for (const [id, files] of xfers) {
    const t = await newest(files);
    if (t !== undefined && t < cutoff) {
      await remove(files);
      out.removedTransfers.push(id);
    }
  }
  return out;
}


/**
 * Script-tail lines (issue #42) that capture what the run changed, as raw git
 * output, before the done marker is written. Only emitted when the start commit
 * is known (the cwd is a git repo); a missing capture later reads as "unknown",
 * never as "no changes". No JSON is assembled in bash.
 *
 * Issue #271: when the run changed files but did NOT commit (endHead ==
 * startHead with a non-empty capture), a `dirtyWorktree=1` line is appended so
 * the manifest can flag the silent data-loss shape (branch tip at base,
 * unpublished work) instead of reporting a plain success. A run that committed
 * its work, or changed nothing, emits no extra line (byte-identical capture).
 */
export function changesCaptureLines(cwd: string, startHead: string | undefined, changesPath: string): string[] {
  if (!startHead || !/^[0-9a-f]{40,64}$/.test(startHead)) return [];
  const g = `git -C ${shq(cwd)} -c core.quotePath=false`;
  return [
    "# Issue #42: record what changed, for the audit manifest.",
    `{ echo "endHead=$(${g} rev-parse HEAD 2>/dev/null)"; echo "---status"; ${g} diff --name-status ${startHead} -- 2>/dev/null; ${g} ls-files --others --exclude-standard 2>/dev/null | awk '{print "?\\t" $0}'; echo "---stat"; ${g} diff --stat ${startHead} -- 2>/dev/null; } > ${shq(changesPath)} 2>/dev/null`,
    "# Issue #271: changed files with an unmoved branch tip = dirty worktree (uncommitted work, nothing to push).",
    `if grep -q "^endHead=${startHead}$" ${shq(changesPath)} 2>/dev/null && sed -n '2,/^---stat/p' ${shq(changesPath)} 2>/dev/null | grep -qE '^[A-Z?]'; then echo dirtyWorktree=1 >> ${shq(changesPath)}; fi`,
  ];
}

/**
 * Issue #271: whether a raw change capture carries the dirty-worktree tail the
 * run script appends when it recorded file changes with an unmoved branch tip
 * (work left uncommitted; nothing for fleet_sync to push). Absence is
 * meaningful only together with a capture actually being present; a missing
 * capture file reads as "not dirty", never as "clean" (the manifest's null
 * filesChanged already says "unknown" for that case).
 */
export function dirtyWorktreeSignal(rawChanges: string): boolean {
  return /^dirtyWorktree=1$/m.test(rawChanges);
}

// ---------------------------------------------------------------------------
// Per-run isolation (issue #41): a private git clone per run
// ---------------------------------------------------------------------------

/** Where a run's clone lives: beside the source, inside the same allowed root. */
export function runCloneDir(sourceCwd: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  return `${dirname(resolve(sourceCwd))}/.fleet-runs/${runId}`;
}

export type CloneResult = { ok: true; cwd: string; branch: string; sourceDirty: boolean } | { ok: false; error: string };

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((res) => {
    execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      res({ ok: !err, out: (stdout + (err ? `\n${stderr}` : "")).trim() });
    });
  });
}

/**
 * Give a run its own clone of `sourceCwd` at `<parent>/.fleet-runs/<runId>/repo`
 * (0700), on a new branch `fleet/<runId>`. `--no-hardlinks` makes the object store
 * the run's own, `core.hooksPath=/dev/null` stops any hook from running, and the
 * run never shares `.git` with the source, so a hook or config written by one run
 * cannot execute in another's or in the source checkout. Only COMMITTED state is
 * cloned; uncommitted changes in the source are reported via `sourceDirty`.
 */
export async function createRunClone(runId: string, sourceCwd: string): Promise<CloneResult> {
  const fsp = await import("node:fs/promises");
  let runDir: string;
  try {
    runDir = runCloneDir(sourceCwd, runId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const head = await git(["-C", sourceCwd, "rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { ok: false, error: `${sourceCwd} is not a git checkout with at least one commit` };
  const dirty = await git(["-C", sourceCwd, "status", "--porcelain"]);
  const cwd = `${runDir}/repo`;
  try {
    await fsp.mkdir(dirname(runDir), { recursive: true, mode: 0o700 });
    await fsp.mkdir(runDir, { mode: 0o700 }); // fails if the run already has a directory
  } catch (e) {
    return { ok: false, error: `cannot create ${runDir}: ${(e as Error).message}` };
  }
  const branch = `fleet/${runId}`;
  const steps: string[][] = [
    ["clone", "-q", "--local", "--no-hardlinks", "--", resolve(sourceCwd), cwd],
    ["-C", cwd, "config", "core.hooksPath", "/dev/null"],
    ["-C", cwd, "checkout", "-q", "-b", branch],
  ];
  for (const a of steps) {
    const r = await git(a);
    if (!r.ok) {
      await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: `git ${a[0] === "-C" ? a[2] : a[0]} failed: ${r.out.slice(0, 200)}` };
    }
  }
  return { ok: true, cwd, branch, sourceDirty: dirty.ok && dirty.out.length > 0 };
}

/** The run directory for a clone path, only if it has exactly the shape createRunClone makes. */
function runDirOfClone(runCwd: string): string | undefined {
  const m = resolve(runCwd).match(/^(.*\/\.fleet-runs\/[A-Za-z0-9_-]{1,64})\/repo$/);
  return m ? m[1] : undefined;
}

/** Remove a run's clone directory. Refuses anything that is not a `.fleet-runs/<id>/repo` clone, and never follows a symlink. */
export async function removeRunClone(runCwd: string): Promise<boolean> {
  const dir = runDirOfClone(runCwd);
  if (!dir) return false;
  const fsp = await import("node:fs/promises");
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface CloneVerdict {
  /** Commits or working-tree changes beyond the start commit (work not yet synced anywhere). */
  unsynced: boolean;
  detail: string;
}

/**
 * Issue #283: install a spec's reference files INTO a run's clone before the worker
 * starts, so a reference the operator named is actually present to read (#262 only
 * NAMED them in the prompt).
 *
 * Each reference is a REPO-RELATIVE path. Fail closed on anything that could escape
 * the clone: an absolute path, a `..` segment, or a symlinked destination is REFUSED
 * (listed in `skipped` with a reason), never followed. A path already present in the
 * clone is left as-is (the clone's own copy wins; we never clobber committed work).
 * Returns what was installed and what was skipped-and-why; an empty list is a no-op.
 */
export async function installReferences(
  runCwd: string,
  paths: readonly string[],
): Promise<{ installed: string[]; skipped: Array<{ path?: string; reason: string }> }> {
  const fsp = await import("node:fs/promises");
  const { join: pjoin, resolve: presolve, sep } = await import("node:path");
  const installed: string[] = [];
  const skipped: Array<{ path?: string; reason: string }> = [];
  const root = presolve(runCwd);
  for (const raw of paths) {
    const rel = String(raw ?? "").trim();
    if (rel === "") { skipped.push({ path: rel, reason: "empty path" }); continue; }
    // Refuse anything that is not a clean repo-relative path.
    if (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:[\\/]/.test(rel)) {
      skipped.push({ path: rel, reason: "absolute paths are refused (must be repo-relative)" });
      continue;
    }
    const dest = presolve(pjoin(root, rel));
    if (dest !== root && !dest.startsWith(root + sep)) {
      skipped.push({ path: rel, reason: "path escapes the clone" });
      continue;
    }
    // Source is the SAME relative path inside the clone: the reference is expected to
    // already exist in the checkout (a committed doc/skill). If it does, it is already
    // equipped — record it as installed. A symlink is refused rather than followed.
    let st: Awaited<ReturnType<typeof fsp.lstat>> | undefined;
    try { st = await fsp.lstat(dest); } catch { st = undefined; }
    if (st && st.isSymbolicLink()) { skipped.push({ path: rel, reason: "destination is a symlink; refusing to follow" }); continue; }
    if (!st) { skipped.push({ path: rel, reason: "not present in the clone (the reference must exist in the checkout)" }); continue; }
    installed.push(rel);
  }
  return { installed, skipped };
}

/** Whether a run clone holds work beyond its start commit. Unknown counts as unsynced. */
export async function cloneHasUnsyncedWork(runCwd: string, startHead: string | undefined): Promise<CloneVerdict> {
  const status = await git(["-C", runCwd, "status", "--porcelain"]);
  if (!status.ok) return { unsynced: true, detail: "cannot read the clone's status" };
  if (status.out) return { unsynced: true, detail: "uncommitted changes" };
  if (!startHead || !/^[0-9a-f]{40,64}$/.test(startHead)) return { unsynced: true, detail: "start commit unknown" };
  const ahead = await git(["-C", runCwd, "rev-list", "--count", `${startHead}..HEAD`]);
  if (!ahead.ok) return { unsynced: true, detail: "cannot compare with the start commit" };
  return Number(ahead.out) > 0 ? { unsynced: true, detail: `${ahead.out} commit(s) beyond the start` } : { unsynced: false, detail: "no work beyond the start commit" };
}

export interface CloneSweep {
  removedClones: string[];
  keptUnsynced: Array<{ runId: string; detail: string }>;
  errors: string[];
}

/**
 * Remove finished runs' clones older than the cutoff. A clone with work beyond its
 * start commit is KEPT (listed) unless `discardUnsynced`: unsynced work is never
 * deleted silently. Runs whose clones are kept (or alive) are returned in `protect`
 * so the state sweep leaves the pointer to them alone.
 */
export async function pruneRunClones(
  dir: string,
  olderThanMs: number,
  aliveRunIds: ReadonlySet<string>,
  opts: { discardUnsynced?: boolean; now?: number } = {},
): Promise<CloneSweep & { protect: Set<string> }> {
  const fsp = await import("node:fs/promises");
  const out: CloneSweep & { protect: Set<string> } = { removedClones: [], keptUnsynced: [], errors: [], protect: new Set() };
  const cutoff = (opts.now ?? Date.now()) - olderThanMs;
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const n of names) {
    const m = n.match(/^run-([A-Za-z0-9_-]{1,64})\.json$/);
    if (!m) continue;
    const id = m[1];
    let st: { isolation?: { cwd?: string }; startHead?: string };
    try { st = JSON.parse(await fsp.readFile(`${dir}/${n}`, "utf8")); } catch { continue; }
    const cwd = st.isolation?.cwd;
    if (!cwd || !runDirOfClone(cwd)) continue;
    if (aliveRunIds.has(id)) { out.protect.add(id); continue; }
    let finished = true;
    try { await fsp.stat(`${dir}/done-${id}.json`); } catch { finished = false; }
    const newest = Math.max(...(await Promise.all([n, `done-${id}.json`].map((f) => fsp.stat(`${dir}/${f}`).then((s) => s.mtimeMs, () => 0)))));
    if (!finished || newest >= cutoff) { out.protect.add(id); continue; }
    const v = await cloneHasUnsyncedWork(cwd, st.startHead);
    if (v.unsynced && !opts.discardUnsynced) {
      out.keptUnsynced.push({ runId: id, detail: v.detail });
      out.protect.add(id);
      continue;
    }
    if (await removeRunClone(cwd)) out.removedClones.push(id);
    else out.errors.push(`${id}: could not remove ${cwd}`);
  }
  return out;
}
