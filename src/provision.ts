/**
 * Repo provisioning — credential-free worker checkout.
 *
 * The MANAGER (Main/Metis) holds GitHub credentials. Workers (dev2/dev3) get
 * the repo WITHOUT any credentials via a git bundle:
 *
 *   1. Manager clones the repo (using its own gh/git credentials)
 *   2. Manager creates a git bundle (single file, full history, no creds)
 *   3. Manager ships the bundle to the worker (scp over SSH)
 *   4. Worker unpacks the bundle into the target cwd (no creds, offline)
 *   5. Worker runs OpenCode on the local checkout
 *
 * Sync back:
 *   1. Worker creates a bundle of its changes
 *   2. Manager pulls the bundle, applies, and pushes to GitHub with its creds
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shq } from "./shell.js";
import { SSH_ARGS } from "./ssh.js";

const execFileP = promisify(execFile);

export interface ProvisionRequest {
  /** Git URL or repo path the manager can access (e.g. git@github.com:org/repo or https://...). */
  repo: string;
  /** Branch to check out on the worker. */
  branch?: string;
  /** Target directory on the worker. */
  cwd: string;
  /** Optional commit SHA to check out. */
  commit?: string;
  /**
   * Optional repo-declared setup command to run on the node after checkout
   * (issue #19). Configuration over limits: the plugin does not bake in
   * dependency assumptions — the repo declares how to prepare its own
   * environment (e.g. "scripts/setup.sh"). Runs as the node's checkout user.
   */
  setup?: string;
}

export interface ProvisionResult {
  ok: boolean;
  cwd?: string;
  branch?: string;
  commit?: string;
  error?: string;
  /** True when the bundle was shipped via the node channel (SSH unavailable). */
  viaChannel?: boolean;
  /** Result of the optional repo-declared setup step (issue #19). */
  setup?: { ran: boolean; command?: string; ok?: boolean; output?: string; error?: string };
}

/**
 * Manager-side: clone the repo (with manager creds), create a bundle, and
 * return the bundle path + metadata. The caller ships the bundle to the worker.
 */
export async function createRepoBundle(req: ProvisionRequest): Promise<{
  bundlePath: string;
  branch: string;
  commit: string;
  error?: string;
}> {
  const work = await mkdtemp(join(tmpdir(), "fleet-provision-"));
  try {
    const cloneDir = join(work, "repo");
    const branch = req.branch ?? "main";

    // Clone with manager credentials (uses ambient gh/git auth).
    // Full clone (no --depth) so the bundle carries complete history the
    // worker can traverse.
    await execFileP("git", ["clone", "--branch", branch, req.repo, cloneDir], {
      timeout: 300_000,
    });

    // Resolve the commit SHA.
    const { stdout: shaOut } = await execFileP("git", ["-C", cloneDir, "rev-parse", "HEAD"]);
    const commit = shaOut.trim();

    // Create the bundle.
    const bundlePath = join(work, "repo.bundle");
    await execFileP("git", ["-C", cloneDir, "bundle", "create", bundlePath, "--all"], {
      timeout: 120_000,
    });

    return { bundlePath, branch, commit };
  } catch (err) {
    return { bundlePath: "", branch: req.branch ?? "main", commit: "", error: (err as Error).message };
  }
}

/**
 * Manager-side: clean up a bundle file and its staging dir after shipping.
 */
export async function cleanupBundle(bundlePath: string): Promise<void> {
  try {
    await rm(bundlePath, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Manager-side: run git GC on a node checkout and remove stale bundles to
 * keep the worker tidy and avoid bloat.
 */
export async function cleanupNode(nodeHost: string, cwd?: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  try {
    const cmds = [
      // Remove any leftover fleet bundles.
      `rm -f /tmp/fleet-*.bundle`,
      // GC the checkout if provided (light GC; aggressive is too slow).
      cwd ? `cd ${shq(cwd)} && git gc --prune=now 2>/dev/null` : "",
      // Report disk usage of the checkout.
      cwd ? `du -sh ${shq(cwd)} 2>/dev/null` : "",
    ]
      .filter(Boolean)
      .join(" && ");
    const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, cmds], {
      timeout: 300_000,
    });
    return { ok: true, detail: stdout.trim() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Manager-side: ship a bundle to a worker via scp, then invoke the node command
 * to unpack it. Returns the checkout path.
 */
/**
 * Invoke params for one opencode.run node-command call (used by the SSH-free
 * fallback so provision.ts stays decoupled from the plugin runtime).
 */
export type NodeInvokeFn = (
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export async function provisionToNode(
  nodeHost: string,
  bundlePath: string,
  req: ProvisionRequest,
  channelInvoke?: NodeInvokeFn,
  opts?: { sshAvailable?: boolean },
): Promise<ProvisionResult> {
  const transferId = `${Date.now()}`;
  const remoteBundle = `/tmp/fleet-${transferId}.bundle`;
  let shippedViaChannel = false;
  try {
    // Ship the bundle via SSH when available; fall back to the node channel
    // (chunked base64 through opencode.run) when SSH is not reachable.
    try {
      if (opts?.sshAvailable === false) {
        // Membership config says SSH is unavailable — go straight to the
        // node channel instead of burning an scp timeout.
        if (!channelInvoke) throw new Error("ssh unavailable and no channel invoke provided");
        throw new Error("use-channel"); // routed below via catch
      }
      await execFileP("scp", [...SSH_ARGS, bundlePath, `${nodeHost}:${remoteBundle}`], {
        timeout: 120_000,
      });
    } catch (sshErr) {
      shippedViaChannel = true;
      if (!channelInvoke) throw new Error("channel invoke required for SSH-free provisioning");
      const { chunkBuffer } = await import("./ledger.js");
      const fs = await import("node:fs/promises");
      const chunks = chunkBuffer(await fs.readFile(bundlePath));
      // One invoke per chunk keeps each message small; the node accumulates.
      for (let i = 0; i < chunks.length; i++) {
        await channelInvoke(
          { prompt: "__RECEIVE__", cwd: "/", transport: "http", transferId, chunkIndex: i, chunks: [chunks[i]] },
          60_000,
        );
      }
    }

    // Unpack on the worker (no credentials needed). Light GC only —
    // aggressive GC is too slow for large repos and belongs in fleet_cleanup.
    // Uses the node channel when the bundle arrived via channel (SSH-free
    // nodes, e.g. Windows) or when SSH unpack fails.
    const unpackCmd = [
      `rm -rf ${shq(req.cwd)}`,
      `mkdir -p ${shq(req.cwd)}`,
      `git clone -q ${shq(remoteBundle)} ${shq(req.cwd)}`,
      req.commit ? `cd ${shq(req.cwd)} && git checkout -q ${shq(req.commit)}` : "",
      `cd ${shq(req.cwd)} && git gc --prune=now 2>/dev/null`,
      `cd ${shq(req.cwd)} && git rev-parse HEAD`,
    ]
      .filter(Boolean)
      .join(" && ");

    let unpackOut = "";
    if (shippedViaChannel && channelInvoke) {
      const res = (await channelInvoke(
        { prompt: "__UNPACK__", cwd: req.cwd, transport: "http", transferId, commit: req.commit },
        180_000,
      )) as { payload?: unknown };
      const pl = typeof res?.payload === "string" ? JSON.parse(res.payload) : (res?.payload ?? {});
      if (!pl.ok) throw new Error(pl.error ?? "channel unpack failed");
      unpackOut = String(pl.commit ?? "");
    } else {
      const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, unpackCmd], {
        timeout: 120_000,
      });
      unpackOut = stdout.trim();
    }

    // Optional repo-declared setup step (issue #19): run the repo's own
    // environment bootstrap after checkout, so "provisioned" means "can run
    // the tests", not merely "has the files". Configurable per repo via the
    // `setup` param (e.g. "scripts/setup.sh" or a full command); never
    // hardcoded. Failures are reported, not swallowed.
    let setupResult: ProvisionResult["setup"];
    if (req.setup && req.setup.trim()) {
      const setupCmd = `cd ${shq(req.cwd)} && (${req.setup}) && echo "---FLEET_SETUP_RC=$?"`;
      try {
        let out = "";
        if (shippedViaChannel && channelInvoke) {
          const res = (await channelInvoke(
            { prompt: setupCmd, cwd: req.cwd, transport: "http" },
            300_000,
          )) as { payload?: unknown };
          const pl = typeof res?.payload === "string" ? JSON.parse(res.payload) : (res?.payload ?? {});
          out = String(pl.output ?? pl.stdout ?? "");
          const rcMatch = out.match(/---FLEET_SETUP_RC=(-?\d+)/);
          const rc = rcMatch ? parseInt(rcMatch[1], 10) : (pl.ok === false ? 1 : 0);
          setupResult = { ran: true, command: req.setup, ok: rc === 0, output: out.slice(-2000) };
        } else {
          const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, setupCmd], {
            timeout: 300_000,
          });
          out = stdout.trim();
          const rcMatch = out.match(/---FLEET_SETUP_RC=(-?\d+)/);
          const rc = rcMatch ? parseInt(rcMatch[1], 10) : 0;
          setupResult = { ran: true, command: req.setup, ok: rc === 0, output: out.slice(-2000) };
        }
      } catch (setupErr) {
        setupResult = { ran: true, command: req.setup, ok: false, error: (setupErr as Error).message };
      }
    }

    return {
      ok: true,
      cwd: req.cwd,
      branch: req.branch ?? "main",
      commit: unpackOut,
      ...(shippedViaChannel ? { viaChannel: true } : {}),
      ...(setupResult ? { setup: setupResult } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    // Always remove the remote bundle, even on failure, to avoid bloat.
    try {
      if (shippedViaChannel && channelInvoke) {
        await channelInvoke(
          { prompt: "__RECEIVE_CLEAN__", cwd: "/", transport: "http", transferId },
          30_000,
        );
      } else {
        await execFileP("ssh", [...SSH_ARGS, nodeHost, `rm -f "${remoteBundle}"`], {
          timeout: 30_000,
        });
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Manager-side: pull worker changes back and push to GitHub with manager creds.
 * The worker creates a bundle of its changes; the manager applies and pushes.
 */
export async function syncFromNode(
  nodeHost: string,
  cwd: string,
  repo: string,
  branch: string,
  prebuilt?: { mode: "from-base64"; base64: string; branch?: string; base?: string },
): Promise<ProvisionResult & { synced?: boolean; uncommittedFiles?: number; detail?: string }> {
  const work = await mkdtemp(join(tmpdir(), "fleet-sync-"));
  try {
    if (prebuilt?.mode === "from-base64") {
      // SSH-free path: the manager already holds the worker's bundle as base64.
      // Guard: an empty/whitespace payload means the worker's __BUNDLE__ step
      // staged nothing — fail closed rather than reporting a false "pushed".
      if (!prebuilt.base64 || prebuilt.base64.trim().length === 0) {
        return {
          ok: false,
          cwd,
          branch: prebuilt.branch ?? branch,
          commit: "detection-failed",
          error: "worker returned an empty bundle — nothing was staged",
          detail: "refusing to report success on an empty worker bundle (fail-closed)",
        };
      }
      const localBundle = join(work, "worker.bundle");
      await (await import("node:fs/promises")).writeFile(localBundle, Buffer.from(prebuilt.base64, "base64"));
      const cloneDir = join(work, "repo");
      await execFileP("git", ["clone", "--branch", prebuilt.branch ?? branch, repo, cloneDir], { timeout: 120_000 });
      await execFileP("git", ["-C", cloneDir, "pull", localBundle, prebuilt.branch ?? branch], { timeout: 120_000 });
      // Verify the pull actually advanced HEAD; otherwise this is a no-op that
      // must not be reported as a successful push.
      const { stdout: localHead } = await execFileP("git", ["-C", cloneDir, "rev-parse", "HEAD"], { timeout: 30_000 });
      const { stdout: remoteHead } = await execFileP("git", ["-C", cloneDir, "rev-parse", `origin/${prebuilt.branch ?? branch}`], { timeout: 30_000 });
      if (localHead.trim() === remoteHead.trim()) {
        return {
          ok: true,
          cwd,
          branch: prebuilt.branch ?? branch,
          commit: "no-changes",
          synced: false,
          viaChannel: true,
          detail: "worker bundle carried no new commits — nothing to sync",
        };
      }
      await execFileP("git", ["-C", cloneDir, "push", "origin", prebuilt.branch ?? branch], { timeout: 120_000 });
      return {
        ok: true,
        cwd,
        branch: prebuilt.branch ?? branch,
        commit: "pushed",
        synced: true,
        viaChannel: true,
        detail: "synced via node channel",
      };
    }
    // Step 1: detect uncommitted working-tree changes on the node, INCLUDING
    // untracked files (issue #18: untracked paths were silently missed).
    //
    // CRITICAL: never mask the detector's own failure. The previous form
    // (`git status --porcelain 2>/dev/null | wc -l`) turned any error (bad cwd,
    // bad permissions, git missing) into a confident 0 = "clean tree", which
    // reads as a successful no-op and silently drops the worker's work. We now
    // capture git's exit status explicitly and fail CLOSED: if we cannot
    // measure, we say so instead of reporting "no-changes".
    const statusCmd = [
      `cd ${shq(cwd)}`,
      `git status --porcelain --untracked-files=all`,
      `echo "---FLEET_STATUS_RC=$?"`,
    ].join("; ");
    let uncommitted = 0;
    let dirtyErr: string | undefined;
    {
      const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, statusCmd], {
        timeout: 30_000,
      });
      const m = stdout.match(/---FLEET_STATUS_RC=(-?\d+)/);
      const rc = m ? parseInt(m[1], 10) : NaN;
      if (!Number.isFinite(rc) || rc !== 0) {
        dirtyErr = `git status failed on ${nodeHost} (rc=${Number.isFinite(rc) ? rc : "unknown"}) — cannot determine tree state`;
      } else {
        const body = stdout.split("---FLEET_STATUS_RC=")[0];
        uncommitted = body.split("\n").filter((l) => l.trim().length > 0).length;
      }
    }
    if (dirtyErr) {
      // Fail closed: distinguish "detection failed" from a genuine clean tree.
      return {
        ok: false,
        cwd,
        branch,
        commit: "detection-failed",
        error: dirtyErr,
        detail: `could not evaluate working tree on ${nodeHost}; refusing to report no-changes (fail-closed)`.replace("${nodeHost}", nodeHost),
      };
    }

    // Step 2: commit uncommitted changes on the node before bundling, so the
    // sync actually carries the worker's work (issue #1: silent data loss).
    if (uncommitted > 0) {
      const commitCmd = [
        `cd ${shq(cwd)}`,
        `git add -A`,
        `git -c user.email=fleet-worker@${nodeHost} -c user.name="fleet-worker (${nodeHost})" commit -m "fleet_sync: auto-commit worker working-tree changes before sync"`,
      ].join(" && ");
      await execFileP("ssh", [...SSH_ARGS, nodeHost, commitCmd], {
        timeout: 60_000,
      });
    }

    // Step 2b: check whether there are any commits to sync. Do NOT trust a
    // bare `origin/${branch}` ref: bundle-provisioned workers have either no
    // usable `origin` remote or a stale one pointing at a deleted bundle, so
    // `origin/main..HEAD` resolves to nothing and reports 0 ahead forever
    // (issue #18). Resolve a *real* comparison base instead, in order:
    //   1. an explicit base (the provision commit) recorded by the caller
    //   2. origin/<branch> if it actually resolves
    //   3. the remote-tracking base of a bundle-backed checkout
    //   4. otherwise: any commit not reachable from the branch tip's upstream
    const resolveBaseCmd = [
      `cd ${shq(cwd)}`,
      `BASE=""`,
      prebuilt?.base ? `git rev-parse --verify --quiet ${shq(prebuilt.base)} >/dev/null && BASE=${shq(prebuilt.base)}` : `true`,
      `[ -z "$BASE" ] && git rev-parse --verify --quiet ${shq(`origin/${branch}`)} >/dev/null && BASE=${shq(`origin/${branch}`)}`,
      `[ -z "$BASE" ] && git rev-parse --verify --quiet ${shq(`refs/remotes/origin/${branch}`)} >/dev/null && BASE=${shq(`refs/remotes/origin/${branch}`)}`,
      `[ -z "$BASE" ] && BASE=$(git rev-list --max-parents=0 HEAD | tail -1)`,
      `echo "---FLEET_BASE=$BASE"`,
      `if [ -n "$BASE" ]; then git rev-list --count "$BASE..HEAD"; else echo "ERR"; fi`,
    ].join("; ");
    const { stdout: aheadOut } = await execFileP(
      "ssh",
      [...SSH_ARGS, nodeHost, resolveBaseCmd],
      { timeout: 30_000 },
    );
    const baseMatch = aheadOut.match(/---FLEET_BASE=(\S+)/);
    const resolvedBase = baseMatch?.[1] ?? "";
    const aheadStr = aheadOut.split("---FLEET_BASE=")[1]?.split("\n")[1]?.trim() ?? "";
    if (!resolvedBase || resolvedBase === "ERR" || !/^\d+$/.test(aheadStr)) {
      return {
        ok: false,
        cwd,
        branch,
        commit: "detection-failed",
        error: `could not resolve a comparison base for ${nodeHost}:${cwd}`,
        detail: "could not evaluate commits ahead; refusing to report no-changes (fail-closed)",
      };
    }
    const ahead = parseInt(aheadStr, 10);

    if (uncommitted === 0 && ahead === 0) {
      return { ok: true, cwd, branch, commit: "no-changes", detail: "no uncommitted changes and no commits ahead — nothing to sync" };
    }

    // Step 3: worker creates a bundle of its current state.
    const remoteBundle = `/tmp/fleet-sync-${Date.now()}.bundle`;
    const workerCmd = `cd ${shq(cwd)} && git bundle create ${shq(remoteBundle)} --all 2>/dev/null; echo "BUNDLE_READY"`;
    await execFileP("ssh", [...SSH_ARGS, nodeHost, workerCmd], {
      timeout: 120_000,
    });

    // Step 4: pull the bundle back to the manager.
    const localBundle = join(work, "worker.bundle");
    await execFileP("scp", [...SSH_ARGS, `${nodeHost}:${remoteBundle}`, localBundle], {
      timeout: 120_000,
    });

    // Apply the bundle to a fresh clone and push with manager creds.
    const cloneDir = join(work, "repo");
    await execFileP("git", ["clone", "--branch", branch, repo, cloneDir], { timeout: 120_000 });
    await execFileP("git", ["-C", cloneDir, "pull", localBundle, branch], { timeout: 120_000 });
    await execFileP("git", ["-C", cloneDir, "push", "origin", branch], { timeout: 120_000 });

    // Clean up the remote bundle.
    await execFileP("ssh", [...SSH_ARGS, nodeHost, `rm -f ${shq(remoteBundle)}`], {
      timeout: 30_000,
    });

    return {
      ok: true,
      cwd,
      branch,
      commit: "pushed",
      synced: true,
      uncommittedFiles: uncommitted,
      detail: uncommitted > 0 ? `committed ${uncommitted} uncommitted file(s) on node before sync` : "pushed worker commits",
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
