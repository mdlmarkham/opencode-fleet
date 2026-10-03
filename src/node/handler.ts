/**
 * Node-side handler of the `opencode.run` command (issue #43).
 *
 * Each control operation is its own function in an `op` table; the request is
 * validated (protocol op, ids, cwd confinement) before any op runs, and every
 * result is stamped with the protocol version so the gateway can detect a
 * node that predates the protocol.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { shq } from "../shell.js";
import {
  buildOpenCodeCommand,
  parseOpenCodeOutput,
  parsePiOutput,
  validateHarnessTransport,
  type OpenCodeTask,
} from "../opencode.js";
import type { VerifyDetails } from "../verify.js";
import { evaluateExpect, parseExpectSpec } from "../verify.js";
import { B64_MARKER, MAX_TRANSFER_B64, parseBundleOutput, parseStatusOutput, statusCommand } from "../outputs.js";
import { acceptChunk, assembleChunks, isCanonicalBase64 } from "../xfer.js";
import { guardCwd, taskUsesCwd, validateTaskIds } from "../guard.js";
import { ensureStateDir, runPaths, xferPaths, writePrivate } from "../paths.js";
import { resolveOp, stampProtocol, type Op } from "../protocol.js";
import {
  OPCODE_PS_COMMAND,
  abortRunById,
  detachedLaunchCommand,
  doneMarkerLine,
  parseActivity,
  readNodeModels,
  remoteBundlePath,
  runScriptPath,
  runShell,
  runShellDetailed,
  runStatePath,
  listProcessTable,
  pruneStateDir,
  parseProcessTable,
  runScriptRows,
  selfStateLines,
  verifyGateScript,
} from "./runtime.js";

/** OpenCode task plus the dispatch watchdog knobs (idle/duration guards). */
export type FleetOpenCodeTask = OpenCodeTask & {
  /** Kill the run if no output chunk arrives for this long, ms. */
  maxIdleMs?: number;
  /** Kill the run if total runtime exceeds this, ms. */
  maxDurationMs?: number;
};

export interface NodeIo {
  emitChunk?: (chunk: string) => Promise<void> | void;
}

export interface NodeContext {
  signal?: AbortSignal;
}

interface OpCtx {
  task: FleetOpenCodeTask;
  io?: NodeIo;
  context?: NodeContext;
}

type OpFn = (c: OpCtx) => Promise<string>;

const OPS: Partial<Record<Op, OpFn>> = {};

OPS["abort"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Issue #30 finding H: cancellation was engine-blind — `pkill -f
      // "opencode (run|acp|serve)"` never matched a Pi worker. Terminate by
      // the run's own script (engine-independent) and only report success
      // after confirming termination.
      const runId = String(task.runId ?? "");
      if (runId) {
        const r = await abortRunById(runId);
        return JSON.stringify({ ...r, sessionId: task.sessionId });
      }
      // Issue #63: there is no node-wide fallback. A pattern `pkill` would kill
      // other runs' (and other users') workers; abort addresses ONE run.
      return JSON.stringify({
        ok: false,
        aborted: false,
        sessionId: task.sessionId,
        error: "abort requires a runId; refusing to kill workers by name pattern (use fleet_abort with runId, or a sessionId that fleet_dispatch recorded)",
      });
};

OPS["state.prune"] = async ({ task }: OpCtx) => {
  // Issue #63: drop finished runs' files and stale transfer staging from the
  // private state dir. Never touches a run whose script is still in the process
  // table, and (if `ps` fails) refuses rather than guessing.
  const days = (task as { olderThanDays?: unknown }).olderThanDays;
  const d = typeof days === "number" && Number.isFinite(days) ? days : 7;
  if (d < 1 || d > 3650) return JSON.stringify({ ok: false, error: "olderThanDays must be between 1 and 3650" });
  let alive = new Set<string>();
  try {
    const rows = parseProcessTable(await listProcessTable());
    for (const r of rows) {
      const m = r.args.match(/(?:^|\/)bash(?:\s+-\S+)*\s+\S*\/run-([A-Za-z0-9_-]{1,64})\.sh\s*$/);
      if (m) alive.add(m[1]);
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: `cannot list processes, not pruning: ${(e as Error).message}` });
  }
  const res = await pruneStateDir(ensureStateDir(), d * 86_400_000, alive);
  return JSON.stringify({ ok: true, olderThanDays: d, ...res });
};

OPS["diff"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Show the working-tree diff in the checkout (real diff).
      const diff = await runShell(
        `cd ${shq(task.cwd)} && git diff --stat 2>/dev/null; echo "---"; git diff 2>/dev/null | head -200`,
        30_000,
        context?.signal,
      );
      return JSON.stringify({ ok: true, diff: diff.trim(), sessionId: task.sessionId });
};

OPS["models"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      const models = await readNodeModels();
      return JSON.stringify({ ok: true, models });
};

OPS["activity"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // List running OpenCode processes on this node (local ps, no SSH needed here).
      const activity = await runShell(OPCODE_PS_COMMAND, 15_000, context?.signal);
      return JSON.stringify({ ok: true, activity: parseActivity(activity) });
};

OPS["status"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Working-tree state of the checkout (issue #4: manager visibility).
      const st = await runShell(statusCommand(shq(task.cwd)), 20_000, context?.signal);
      const status = parseStatusOutput(st);
      if (!status.ok) return JSON.stringify({ ok: false, cwd: task.cwd, error: status.error });
      return JSON.stringify({ ok: true, cwd: task.cwd, uncommittedCount: status.uncommittedCount, files: status.files });
};

OPS["xfer.receive"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Node-channel bundle transfer: accumulate base64 chunks into a
      // temp file across multiple invokes. Used when SSH is unavailable
      // (e.g. Windows nodes). task.chunks: { index, data }[]
      const transferId = String(task.transferId ?? "t");
      const accDir = xferPaths(transferId).dir;
      await (await import("node:fs/promises")).mkdir(accDir, { recursive: true });
      const first = (task.chunks ?? [])[0];
      if (!first) return JSON.stringify({ ok: false, error: "no chunk supplied" });
      let last: Awaited<ReturnType<typeof acceptChunk>> = { ok: true, received: 0 };
      for (const c of task.chunks ?? []) {
        last = await acceptChunk(accDir, c.index, c.data, MAX_TRANSFER_B64);
        if (!last.ok) return JSON.stringify(last);
      }
      return JSON.stringify({ ok: true, transferId, received: last.received });
};

OPS["xfer.unpack"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Decode accumulated base64 and clone into cwd (SSH-free path).
      const transferId = String(task.transferId ?? "t");
      const accDir = xferPaths(transferId).dir;
      try {
        // Integrity is mandatory: a direct or malformed request without a
        // digest must not reach `git clone`.
        if (typeof task.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(task.sha256)) {
          return JSON.stringify({ ok: false, error: "sha256 (64 hex chars) required for __UNPACK__" });
        }
        const b64 = await assembleChunks(accDir);
        if (!b64 || !isCanonicalBase64(b64)) {
          return JSON.stringify({ ok: false, error: "assembled transfer is empty or not canonical base64" });
        }
        const bundlePath = remoteBundlePath(transferId);
        const decoded = Buffer.from(b64, "base64");
        const got = createHash("sha256").update(decoded).digest("hex");
        if (got !== task.sha256) {
          return JSON.stringify({ ok: false, error: `bundle checksum mismatch (expected ${task.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…); refusing to unpack a corrupted transfer` });
        }
        await (await import("node:fs/promises")).writeFile(bundlePath, decoded);
        // Issue #71 (F2): the clone runs as whatever principal the node process
        // is; on SSH-free nodes the manager never ssh'd a chown, so hand the
        // checkout to the node's service user (when present) so the worker
        // principal can actually write it. Mirror of the SSH-path unpackCmd.
        const unpackCmd = [
          `rm -rf ${shq(task.cwd)}`,
          `mkdir -p ${shq(task.cwd)}`,
          `git clone -q ${shq(bundlePath)} ${shq(task.cwd)}`,
          task.commit ? `cd ${shq(task.cwd)} && git checkout -q ${shq(task.commit)}` : "",
          `if id -u svcuser >/dev/null 2>&1; then chown -R svcuser:svcuser ${shq(task.cwd)}; fi`,
          `cd ${shq(task.cwd)} && git rev-parse HEAD`,
        ].filter(Boolean).join(" && ");
        const out = await runShell(unpackCmd, 180_000, context?.signal);
        if (!/^[0-9a-f]{7,40}/m.test(out.trim())) {
          return JSON.stringify({ ok: false, error: `unpack failed: ${out.trim().slice(0, 300)}` });
        }
        return JSON.stringify({ ok: true, commit: out.trim().split("\n").pop(), bytes: b64.length });
      } finally {
        await (await import("node:fs/promises")).rm(accDir, { recursive: true, force: true }).catch(() => {});
      }
};

OPS["xfer.clean"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      const transferId = String(task.transferId ?? "t");
      await (await import("node:fs/promises")).rm(remoteBundlePath(transferId), { force: true }).catch(() => {});
      await (await import("node:fs/promises")).rm(xferPaths(transferId).dir, { recursive: true, force: true }).catch(() => {});
      return JSON.stringify({ ok: true });
};

OPS["bundle"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // SSH-free sync, worker side: bundle current state (auto-committing
      // uncommitted changes first, same as the SSH path) and stage as base64.
      const transferId = String(task.transferId ?? "t");
      const accDir = xferPaths(transferId).dir;
      await (await import("node:fs/promises")).mkdir(accDir, { recursive: true });
      const bundlePath = join(accDir, "sync.bundle");
      // Fail-closed worker bundle (issue #18): the old form masked every
      // git error with `2>/dev/null`, so a bad cwd produced an empty (or
      // stale-ref) bundle that the manager then reported as "pushed".
      // Now: verify we are in a work tree, stage untracked files too, and
      // abort the bundle if git itself fails.
      const commitOut = await runShell(
        [
          `cd ${shq(task.cwd)}`,
          `git rev-parse --is-inside-work-tree >/dev/null`,
          `DIRTY=$(git status --porcelain --untracked-files=all)`,
          `if [ -n "$DIRTY" ]; then git add -A && git -c user.email=fleet-worker@node -c user.name="fleet-worker" commit -q -m "fleet_sync: auto-commit worker working-tree changes before sync"; fi`,
          `git bundle create ${shq(join(accDir, "sync.bundle"))} --all`,
          `git rev-parse HEAD`,
          `git rev-parse --abbrev-ref HEAD`,
          `echo "${B64_MARKER}"`,
          `base64 ${shq(join(accDir, "sync.bundle"))}`,
        ].filter(Boolean).join(" && "),
        120_000,
        context?.signal,
      );
      const bundled = parseBundleOutput(commitOut);
      if (!bundled.ok) return JSON.stringify({ ok: false, error: bundled.error });
      await (await import("node:fs/promises")).writeFile(join(accDir, "bundle.b64"), bundled.base64);
      const bundleBytes = await (await import("node:fs/promises")).readFile(join(accDir, "sync.bundle"));
      return JSON.stringify({
        ok: true, transferId, staged: true, head: bundled.head, branch: bundled.branch,
        sha256: createHash("sha256").update(bundleBytes).digest("hex"), bytes: bundleBytes.length,
      });
};

OPS["run.start"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Issue #6: detached execution. The child survives relay timeouts
      // and gateway cancellations; its completion is recorded in a run
      // state file that the manager polls.
      const runId = String(task.runId ?? "");
      if (!runId || !/^[-a-zA-Z0-9_]+$/.test(runId)) {
        return JSON.stringify({ ok: false, error: "runId required for detached run" });
      }
      // Issue #22 bug 2: the sentinel is a TRANSPORT control value, not the
      // task. The real prompt must arrive separately (`realPrompt`), since
      // `task.prompt` here IS the sentinel. If it is missing we must NOT
      // build a command with the placeholder as the message — that launches
      // an empty session, exits 0, and reads as success.
      const realPrompt = String(task.realPrompt ?? "");
      if (realPrompt.trim().length === 0) {
        return JSON.stringify({
          ok: false,
          error: "detached launch missing realPrompt — refusing to launch an empty session (the task prompt would be lost)",
        });
      }
      const statePath = runStatePath(runId);
      const logPath = runPaths(runId).log;
      const scriptPath = runScriptPath(runId);
      // The script re-echoes the launch command with its own timeout, then
      // writes the final output into the state file on exit.
      const inner = buildOpenCodeCommand({
        ...task,
        prompt: realPrompt,
        timeoutMs: task.maxDurationMs ?? task.timeoutMs ?? 600_000,
      });
      // Issue #62: optional post-run verification gate. The node must not
      // trust the gateway, so the spec is re-validated here; a malformed one
      // fails the launch instead of silently dropping the gate.
      const expectSpec = parseExpectSpec(task.expect);
      if (!expectSpec.ok) {
        return JSON.stringify({ ok: false, error: `refused: ${expectSpec.error}` });
      }
      const expect = expectSpec.expect;
      // Completion is written to a SEPARATE file so the manager's JSON
      // state write (below) and the worker's completion write never race.
      const donePath = runPaths(runId).done;
      // With an `expect` gate the tail evaluates it in the run cwd AFTER the
      // worker exits (issue #62) and the done record gains verified +
      // verifyDetails; without one this is byte-identical to before.
      const gate = expect ? verifyGateScript(expect, donePath, { cwd: task.cwd }) : undefined;
      const script = [
        "#!/bin/bash",
        // Issue #22 bug 4: no exit-code laundering. `set -o pipefail` is not
        // enough on its own; we already fail closed at each step, and the
        // final exit propagates the worker's real status.
        "set -u",
        // The script publishes its own pid/pgid/state first (issues #64, #69).
        ...selfStateLines(statePath, { runId, harness: task.harness ?? "opencode", ...(task.piModel ? { piModel: task.piModel } : {}) }),
        inner,
        `EC=$?`,
        ...(gate?.verifyLines ?? []),
        gate?.doneLine ?? doneMarkerLine(donePath),
        `exit $EC`,
      ].join("\n");
      await writePrivate(scriptPath, script, 0o700);
      // Issue #21: a slow node host was the likely trigger for the launch
      // ack timing out. Give the local spawn a more generous window than the
      // old 15s — setsid/nohup return immediately, so this only matters when
      // the host itself is under load. The manager still never blocks on
      // the run (the child is detached).
      const launchOut = await runShell(detachedLaunchCommand(runId, scriptPath, statePath), 45_000, context?.signal);
      const pidMatch = launchOut.match(/LAUNCHED_PID=(\d+)/);
      if (!pidMatch) {
        // Fail closed: no pid means no receipt. Report the real reason
        // rather than letting the manager mint an optimistic handle.
        return JSON.stringify({
          ok: false,
          error: `launch failed (no LAUNCHED_PID): ${launchOut.trim().slice(0, 200) || "empty launcher output"}`,
        });
      }
      // The script writes its own state (real pid and group) as its first action.
      // Wait briefly for it; if it has not appeared (a very loaded node) fall back
      // to the launcher subshell's pid, marked as such. Abort and liveness do not
      // depend on this pid: they find the run by its script.
      const launcherPid = Number(pidMatch[1]);
      let selfState: { pid?: number; pgid?: number } | undefined;
      for (let i = 0; i < 40 && !selfState; i++) {
        try {
          const st = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8")) as { pid?: number; pgid?: number };
          if (Number.isInteger(st.pid) && (st.pid as number) > 1) selfState = st;
        } catch { /* not written yet */ }
        if (!selfState) await new Promise((r) => setTimeout(r, 100));
      }
      if (!selfState) {
        await writePrivate(
          statePath,
          JSON.stringify({ runId, pid: launcherPid, pidSource: "launcher", startedAt: new Date().toISOString(), state: "running", harness: task.harness ?? "opencode", ...(task.piModel ? { piModel: task.piModel } : {}) }),
        );
      }
      const runPid = selfState?.pid ?? launcherPid;
      return JSON.stringify({ ok: true, detached: true, runId, pid: runPid, ...(selfState?.pgid ? { pgid: selfState.pgid } : {}), pidSource: selfState ? "script" : "launcher", statePath, logPath, harness: task.harness ?? "opencode" });
};

OPS["run.status"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Read the run-state file + liveness; never blocks on the run.
      const runId = String(task.runId ?? "");
      const statePath = runStatePath(runId);
      try {
        const raw = await (await import("node:fs/promises")).readFile(statePath, "utf8");
        const st = JSON.parse(raw) as { pid?: number; state?: string; startedAt?: string; finishedAt?: string; exitCode?: number; verified?: boolean; verifyDetails?: VerifyDetails };
        // Merge worker completion record when present (issue #6). Issue #62:
        // the record may also carry the verify-gate outcome.
        try {
          const doneRaw = await (await import("node:fs/promises")).readFile(runPaths(runId).done, "utf8");
          const done = JSON.parse(doneRaw) as { exitCode?: number; finishedAt?: string; verified?: boolean; verifyDetails?: VerifyDetails };
          st.state = "finished";
          st.exitCode = done.exitCode;
          st.finishedAt = done.finishedAt;
          if (typeof done.verified === "boolean") {
            st.verified = done.verified;
            if (done.verifyDetails) st.verifyDetails = done.verifyDetails;
          }
        } catch { /* still running or not finished */ }
        // Liveness: is the pid still alive?
        // Alive = the run's script is in the process table (not `kill -0` on a
        // recorded pid, which may be the launcher subshell or a reused pid).
        let alive = false;
        try {
          alive = runScriptRows(parseProcessTable(await listProcessTable(context?.signal)), runScriptPath(runId)).length > 0;
        } catch {
          if (st.pid) {
            const ps = await runShell(`kill -0 ${Number(st.pid)} 2>/dev/null && echo ALIVE || echo DEAD`, 10_000, context?.signal);
            alive = ps.includes("ALIVE");
          }
        }
        return JSON.stringify({ ok: true, runId, ...st, alive, verified: typeof st.verified === "boolean" ? st.verified : null, verifyDetails: st.verifyDetails ?? null });
      } catch {
        // Distinguish never-started from cleaned (issue #21): if the
        // launch was never acked, no state file was ever written. We can't
        // tell "never started" from "cleaned up" by absence alone, so look
        // for the worker script and log as corroborating evidence.
        const scriptExists = await (await import("node:fs/promises"))
          .stat(runScriptPath(runId))
          .then(() => true)
          .catch(() => false);
        const logExists = await (await import("node:fs/promises"))
          .stat(runPaths(runId).log)
          .then(() => true)
          .catch(() => false);
        // A state file that EXISTS but could not be parsed is not "cleaned" (#64).
        const stateExists = await (await import("node:fs/promises"))
          .stat(runStatePath(runId))
          .then(() => true)
          .catch(() => false);
        if (stateExists) {
          return JSON.stringify({ ok: false, status: "unknown-state", error: "run state file exists but is unreadable or not valid JSON" });
        }
        return JSON.stringify({
          ok: false,
          status: scriptExists || logExists ? "cleaned" : "never-started",
          error: scriptExists || logExists
            ? "no run state (script/log present, state cleaned)"
            : "no run state (never started)",
        });
      }
};

OPS["run.result"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Final output of a detached run: tail of the log + state.
      // Issue #30 finding F: parse with the engine that ACTUALLY ran —
      // read the persisted harness from the run state, and the exit code
      // from the done marker so failure is not read as success. The
      // default (opencode) path is unchanged.
      const runId = String(task.runId ?? "");
      const logPath = runPaths(runId).log;
      const tail = await runShell(`tail -c 64000 ${shq(logPath)} 2>/dev/null || true`, 15_000, context?.signal);
      let harness = "opencode";
      let exitCode: number | undefined;
      // Issue #62: verify-gate outcome (from the launcher-written done record).
      let verified: boolean | null = null;
      let vDetails: VerifyDetails | undefined;
      try {
        const raw = await (await import("node:fs/promises")).readFile(runStatePath(runId), "utf8");
        const st = JSON.parse(raw) as { harness?: string };
        if (st.harness) harness = st.harness;
      } catch { /* no state file */ }
      try {
        const doneRaw = await (await import("node:fs/promises")).readFile(runPaths(runId).done, "utf8");
        const done = JSON.parse(doneRaw) as { exitCode?: number; verified?: boolean; verifyDetails?: VerifyDetails };
        if (typeof done.exitCode === "number") exitCode = done.exitCode;
        // Issue #62: surface the verification gate outcome recorded by the
        // launcher. The parsed result below stays untouched; verified rides
        // alongside it (null when no gate was configured).
        if (typeof done.verified === "boolean") verified = done.verified;
        if (done.verifyDetails) vDetails = done.verifyDetails;
      } catch { /* still running or no marker */ }
      const parsed =
        harness === "pi" ? parsePiOutput(tail, { exitCode }) : parseOpenCodeOutput(tail, exitCode !== undefined ? { exitCode } : undefined);
      // Issue #62: attach the gate outcome to the run result (distinct from
      // `ok`, which remains the process exit status) and alongside it for
      // control-plane consumers.
      if (verified !== null) {
        parsed.verified = verified;
        if (vDetails) parsed.verifyDetails = vDetails;
      }
      return JSON.stringify({
        ok: true,
        runId,
        harness,
        result: parsed,
        verified,
        verifyDetails: vDetails ?? null,
      });
};

OPS["xfer.send"] = async ({ task, io, context }: OpCtx) => {
  void io; void context;
      // Manager pulls staged base64 back in ~64KB pieces.
      const transferId = String(task.transferId ?? "t");
      const accFile = join(xferPaths(transferId).dir, "bundle.b64");
      try {
        const b64 = await (await import("node:fs/promises")).readFile(accFile, "utf8");
        const per = 64 * 1024;
        const idx = Number(task.chunkIndex ?? 0);
        if (idx * per >= b64.length) {
          return JSON.stringify({ ok: true, done: true, chunks: idx });
        }
        return JSON.stringify({ ok: true, done: false, index: idx, data: b64.slice(idx * per, (idx + 1) * per) });
      } catch {
        return JSON.stringify({ ok: false, error: "no staged transfer for this id" });
      }
};

/** The ordinary task: run the engine on the node and parse its result. */
async function runTask({ task, io, context }: OpCtx): Promise<string> {
    // Issue #62: the node does not trust the gateway; validate the optional
    // verification gate FIRST (before the ref checkout or any worker run).
    const expectSpec = parseExpectSpec(task.expect);
    if (!expectSpec.ok) {
      return JSON.stringify({ ok: false, error: `refused: ${expectSpec.error}` });
    }
    // Per-dispatch environment (issue: agent-specified environment).
    // 1. Git ref selection: refuse when the checkout is dirty, to avoid
    //    clobbering another run's uncommitted work on a shared cwd.
    if (task.ref && (task.ref.branch || task.ref.commit)) {
      const refCheck = await runShell(
        `cd ${shq(task.cwd)} && test -z "$(git status --porcelain 2>/dev/null)" || echo DIRTY`,
        15_000,
        context?.signal,
      );
      if (refCheck.trim().includes("DIRTY")) {
        return JSON.stringify({
          ok: false,
          error: `refused: ${task.cwd} has uncommitted changes; commit or sync them before dispatching with a ref`,
        });
      }
      const refSpec = task.ref.commit ?? task.ref.branch;
      await runShell(
        `cd ${shq(task.cwd)} && git fetch --all --prune 2>/dev/null; git checkout -q ${shq(refSpec ?? "")} && git rev-parse HEAD`,
        60_000,
        context?.signal,
      );
    }

    const command = buildOpenCodeCommand(task);
    // Emit progress chunks to keep the node invoke alive during long runs.
    const onChunk = async (chunk: string) => {
      if (io?.emitChunk) {
        try {
          await io.emitChunk(chunk);
        } catch {
          // Progress emission is best-effort; ignore failures.
        }
      }
    };

    // Issue #30 finding G: harness=pi + transport=acp silently routed to the
    // opencode ACP client, ignoring Pi and piModel. Pi has no ACP transport;
    // reject the combination explicitly rather than run something else.
    const harnessCheck = validateHarnessTransport(task);
    if (!harnessCheck.ok) {
      return JSON.stringify({ ok: false, harness: harnessCheck.harness, error: harnessCheck.error });
    }
    if (task.transport === "acp") {
      const { runAcpPrompt } = await import("../acp-client.js");
      const acpResult = await runAcpPrompt({
        prompt: task.prompt,
        cwd: task.cwd,
        model: task.model,
        agent: task.agent,
        timeoutMs: task.timeoutMs ?? 300_000,
        onChunk,
      });
      // Issue #62: an `expect` gate applies to this transport too — evaluate
      // it after the worker (the ACP session) finished.
      if (expectSpec.expect) {
        const outcome = await evaluateExpect(expectSpec.expect, task.cwd);
        acpResult.verified = outcome.verified;
        acpResult.verifyDetails = outcome.verifyDetails;
      }
      return JSON.stringify(acpResult);
    }

    // Issue #30 finding A: thread the shell exit code (and watchdog flags)
    // through so a non-zero exit / timeout / FLEET_ERROR is not read as
    // success by the Pi parser.
    const run = await runShellDetailed(
      command,
      task.timeoutMs ?? 300_000,
      context?.signal,
      onChunk,
      task.maxIdleMs,
      task.maxDurationMs,
    );
    const parsed =
      task.harness === "pi"
        ? parsePiOutput(run.output, { exitCode: run.exitCode, timedOut: run.timedOut, stuck: run.stuck })
        : parseOpenCodeOutput(run.output, { exitCode: run.exitCode, timedOut: run.timedOut, stuck: run.stuck });
    // Issue #62: when the dispatch carries an `expect` gate, evaluate it in
    // the run cwd AFTER the worker finished. `verified` is independent of the
    // exit status: a run that exits 0 but produced nothing ends up ok:true
    // verified:false — visible, not laundered.
    if (expectSpec.expect) {
      const outcome = await evaluateExpect(expectSpec.expect, task.cwd);
      parsed.verified = outcome.verified;
      parsed.verifyDetails = outcome.verifyDetails;
    }
    return JSON.stringify(parsed);
}

export async function handleOpencodeRun(
  paramsJSON: string | null | undefined,
  io?: NodeIo,
  context?: NodeContext,
): Promise<string> {
  let task: FleetOpenCodeTask | null = null;
  try {
    task = paramsJSON ? (JSON.parse(paramsJSON) as FleetOpenCodeTask) : null;
  } catch {
    return stampProtocol(JSON.stringify({ ok: false, error: "opencode.run params are not valid JSON." }));
  }
  if (!task || !task.prompt || !task.cwd) {
    return stampProtocol(JSON.stringify({ ok: false, error: "opencode.run requires prompt and cwd." }));
  }

  // Protocol: the explicit op (if any) must agree with the prompt.
  const resolved = resolveOp(task);
  if (!resolved.ok) return stampProtocol(JSON.stringify({ ok: false, error: resolved.error }));

  // Issue #31: the node must not trust what the gateway relays. Validate
  // identifiers used in file paths, and confine cwd to the workspace
  // roots before any destructive/clone operation can run.
  const idErr = validateTaskIds(task);
  if (idErr) return stampProtocol(JSON.stringify({ ok: false, error: idErr }));
  if (taskUsesCwd(task.prompt)) {
    const cwdCheck = await guardCwd(task.cwd);
    if (!cwdCheck.ok) return stampProtocol(JSON.stringify({ ok: false, error: `refused: ${cwdCheck.error}` }));
  }

  const ctx: OpCtx = { task, io, context };
  const fn = OPS[resolved.op];
  return stampProtocol(fn ? await fn(ctx) : await runTask(ctx));
}
