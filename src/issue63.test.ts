/**
 * Issue #63: abort/state hardening + private bundle staging.
 *
 * 1. `__ABORT__` is run-addressed: without a runId the old handler fell back
 *    to a node-wide pkill of every opencode/pi process. It must be REFUSED.
 * 2. Before `kill -- -<pid>`, the recorded pid must be verified to still be
 *    the run's process — a recycled pid must never be killed.
 * 3. SSH-path bundle staging moves out of world-writable /tmp into a per-run
 *    0700 dir under the node's private state dir; cleanup removes only the
 *    dir this run created.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleOpencodeRun } from "./node/handler.js";
import { abortRunById, verifyRunPidIdentity, runScriptPath, runStatePath } from "./node/runtime.js";
import { validateTaskIds } from "./guard.js";
import { bundleStageLayout, fleetStateDir, writePrivate } from "./paths.js";
import { bundleStageSweepCommand, cleanBundleStageCommand, resolveStageDir, stageBundleDirCommand } from "./provision.js";

const execFileP = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

/** Spawn a live process that has nothing to do with any run (a foreign pid). */
function foreignProcess(): ReturnType<typeof spawn> {
  return spawn("sleep", ["30"], { stdio: "ignore" });
}

describe("issue #63: run-addressed abort without runId is refused (no pkill fallback)", () => {
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));

  it("the guard layer requires a runId for __ABORT__", () => {
    expect(validateTaskIds({ prompt: "__ABORT__" })).toMatch(/runId required/);
    expect(validateTaskIds({ prompt: "__ABORT__", runId: "run-63" })).toBeUndefined();
  });

  it("a run-abort without runId is refused with a clear error", async () => {
    const r = await call({ prompt: "__ABORT__", cwd: "/", transport: "http" });
    expect(r.ok).toBe(false);
    // The id-validation layer refuses BEFORE any op runs.
    expect(r.error).toMatch(/runId required|refused/);
  });

  it("no pkill/pgrep fallback remains in the node code at all", () => {
    for (const f of ["node/handler.ts", "node/runtime.ts"]) {
      const src = readFileSync(join(here, f), "utf8");
      expect(src, f).not.toContain("pkill");
      expect(src, f).not.toContain("pgrep");
    }
  });
});

describe("issue #63: pid verification before kill", () => {
  let dir: string;
  const prevState = process.env.FLEET_STATE_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet63-"));
    process.env.FLEET_STATE_DIR = dir;
  });
  afterEach(() => {
    if (prevState === undefined) delete process.env.FLEET_STATE_DIR;
    else process.env.FLEET_STATE_DIR = prevState;
    rmSync(dir, { recursive: true, force: true });
  });
  const waitDead = async (pid: number, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      if (Date.now() > end) throw new Error(`pid ${pid} is still alive`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("verifyRunPidIdentity: live+matching cmdline verifies; foreign live pid and junk pids refuse", async () => {
    const scriptPath = runScriptPath("mine63");
    writeFileSync(scriptPath, "sleep 30\n", { mode: 0o700 });
    const mine = spawn("/bin/bash", [scriptPath], { stdio: "ignore" });
    try {
      expect(await verifyRunPidIdentity(mine.pid!, scriptPath)).toEqual({ ok: true, kind: "live" });
      const foreign = await verifyRunPidIdentity(mine.pid!, runScriptPath("other63"));
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error).toMatch(/refusing to kill/);
    } finally {
      mine.kill("SIGKILL");
    }
    // A pid that can never exist (above Linux pid_max) = nothing running there.
    expect(await verifyRunPidIdentity(99999999, scriptPath)).toEqual({ ok: true, kind: "gone" });
    const junk = await verifyRunPidIdentity(-1, scriptPath);
    expect(junk.ok).toBe(false);
  });

  it("refuses (and does not kill) when the recorded pid is a live foreign process — a reused pid", async () => {
    const runId = "reuse63";
    const child = foreignProcess();
    try {
      await writeFile(
        runStatePath(runId),
        JSON.stringify({ runId, pid: child.pid, state: "running", harness: "opencode", startedAt: new Date().toISOString() }),
      );
      const res = await abortRunById(runId);
      expect(res.ok).toBe(false);
      expect(res.aborted).toBe(false);
      expect(res.pid).toBe(child.pid);
      expect(res.error).toMatch(/NOT this run's process/);
      expect(res.error).toMatch(/refusing to kill/);
      // The foreign process was NOT killed.
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      // The state file was not rewritten as "aborted".
      const st = JSON.parse(await readFile(runStatePath(runId), "utf8")) as { state?: string };
      expect(st.state).toBe("running");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("verified pid: kills the run's process group, confirms termination, marks the state aborted (existing semantics)", async () => {
    const runId = "live63";
    const scriptPath = runScriptPath(runId);
    writeFileSync(scriptPath, "sleep 30\n", { mode: 0o700 });
    // detached:true makes the child a session/group leader, exactly like the
    // node's setsid launcher — so `kill -- -<pid>` reaches its whole group.
    const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
    try {
      await writeFile(
        runStatePath(runId),
        JSON.stringify({ runId, pid: child.pid, state: "running", harness: "opencode", startedAt: new Date().toISOString() }),
      );
      const res = await abortRunById(runId);
      expect(res.ok).toBe(true);
      expect(res.aborted).toBe(true);
      expect(res.confirmed).toBe(true);
      expect(res.pid).toBe(child.pid);
      await waitDead(child.pid!);
      expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
      // Existing confirmed-termination semantics: the state file is marked.
      const st = JSON.parse(await readFile(runStatePath(runId), "utf8")) as { state?: string };
      expect(st.state).toBe("aborted");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a run whose pid is gone (not recycled) keeps the confirmed-terminated reporting semantics", async () => {
    const runId = "gone63";
    await writeFile(
      runStatePath(runId),
      JSON.stringify({ runId, pid: 99999999, state: "running", harness: "opencode", startedAt: new Date().toISOString() }),
    );
    const res = await abortRunById(runId);
    expect(res.ok).toBe(true);
    expect(res.confirmed).toBe(true);
    expect(res.aborted).toBe(true);
    const st = JSON.parse(await readFile(runStatePath(runId), "utf8")) as { state?: string };
    expect(st.state).toBe("aborted");
  });

  it("without any recorded state the abort is still refused (nothing killed, nothing guessed)", async () => {
    const r = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__ABORT__", cwd: "/", transport: "http", runId: "nostate63" })));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no recorded run state/);
  });
});

describe("issue #63: private per-run bundle staging over SSH", () => {
  it("the stage layout lives under the private state dir, not /tmp (FLEET_STATE_DIR honored)", () => {
    expect(bundleStageLayout("1759400000000")).toEqual({ dirName: "bundle-1759400000000", fileName: "stage.bundle" });
    const underEnv = join(fleetStateDir({ FLEET_STATE_DIR: "/x/y" }), bundleStageLayout("1759400000000").dirName);
    expect(underEnv).toBe("/x/y/bundle-1759400000000");
    expect(join(fleetStateDir({}), bundleStageLayout("1759400000000").dirName)).toContain(".openclaw");
    expect(() => bundleStageLayout("../escape")).toThrow(/transferId/);
  });

  it("the mkdir command creates a 0700 per-run dir under the node's state dir (real shell)", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet63s-"));
    try {
      const cmd = stageBundleDirCommand("1759400000000");
      expect(cmd).toContain("FLEET_STATE_DIR");
      expect(cmd).toContain("$HOME/.openclaw/fleet/state");
      expect(cmd).toContain("mkdir -p");
      expect(cmd).toContain("chmod 700");
      expect(cmd).toContain("bundle-1759400000000");
      expect(cmd).not.toContain("/tmp");
      const { stdout } = await execFileP("/bin/bash", ["-c", cmd], { env: { ...process.env, FLEET_STATE_DIR: base } });
      // The resolved dir is handed back and re-checked against the layout.
      const resolved = resolveStageDir("1759400000000", stdout);
      expect(resolved).toBe(join(base, "bundle-1759400000000"));
      expect((await stat(resolved)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("resolveStageDir refuses anything that is not exactly this run's dir", () => {
    expect(() => resolveStageDir("1759400000000", "/tmp/other\n")).toThrow(/unexpected bundle stage dir/);
    expect(() => resolveStageDir("1759400000000", "")).toThrow(/unexpected bundle stage dir/);
    expect(() => resolveStageDir("1759400000000", "/etc\n")).toThrow(/unexpected bundle stage dir/);
  });

  it("cleanup removes ONLY this run's stage dir — a sibling run's dir survives (real shell)", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet63c-"));
    try {
      const mine = join(base, "bundle-1759400000000");
      const otherRun = join(base, "bundle-999999999999");
      await mkdir(mine, { recursive: true });
      await mkdir(otherRun, { recursive: true });
      await writePrivate(join(mine, "stage.bundle"), "bundle-bytes");
      const cleanup = cleanBundleStageCommand("1759400000000", mine);
      expect(cleanup).toBe(`rm -rf '${mine}'`);
      await execFileP("/bin/bash", ["-c", cleanup]);
      expect(existsSync(mine)).toBe(false);
      // The other run's stage dir was NOT touched.
      expect(existsSync(otherRun)).toBe(true);
      // A tampered/mismatched resolution is refused, never widened into rm -rf.
      const refused = cleanBundleStageCommand("1759400000000", "/etc");
      expect(refused.startsWith("rm -rf")).toBe(false);
      expect(refused).toMatch(/refusing to clean/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fleet_cleanup sweeps only stale private stage dirs — the /tmp glob is gone from provision.ts", () => {
    const sweep = bundleStageSweepCommand();
    expect(sweep).toContain("FLEET_STATE_DIR");
    expect(sweep).toContain("$HOME/.openclaw/fleet/state");
    expect(sweep).toContain("-name 'bundle-*'");
    expect(sweep).toContain("-mtime");
    expect(sweep).not.toContain("/tmp");
    const src = readFileSync(join(here, "provision.ts"), "utf8");
    expect(src).not.toContain("/tmp/fleet-");
    expect(src).not.toContain("rm -f /tmp/fleet-*.bundle");
    expect(src).toContain("stageBundleDirCommand(transferId)");
    expect(src).toContain("stageBundleDirCommand(stageId)");
  });

  it("fleet_abort surfaces a clear tool error instead of a sessionId-only abort", () => {
    const src = readFileSync(join(here, "index.ts"), "utf8");
    expect(src).toContain('required: ["node", "runId"]');
    expect(src).toMatch(/runId required: fleet_abort terminates a specific recorded run/);
  });
});