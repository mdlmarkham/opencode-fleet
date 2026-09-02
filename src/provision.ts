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
}

export interface ProvisionResult {
  ok: boolean;
  cwd?: string;
  branch?: string;
  commit?: string;
  error?: string;
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
      cwd ? `cd "${cwd}" && git gc --prune=now 2>/dev/null` : "",
      // Report disk usage of the checkout.
      cwd ? `du -sh "${cwd}" 2>/dev/null` : "",
    ]
      .filter(Boolean)
      .join(" && ");
    const { stdout } = await execFileP("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, cmds], {
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
export async function provisionToNode(
  nodeHost: string,
  bundlePath: string,
  req: ProvisionRequest,
): Promise<ProvisionResult> {
  const remoteBundle = `/tmp/fleet-${Date.now()}.bundle`;
  try {
    // Ship the bundle to the worker.
    await execFileP("scp", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", bundlePath, `${nodeHost}:${remoteBundle}`], {
      timeout: 120_000,
    });

    // Unpack on the worker (no credentials needed). Light GC only —
    // aggressive GC is too slow for large repos and belongs in fleet_cleanup.
    const unpackCmd = [
      `rm -rf "${req.cwd}"`,
      `mkdir -p "${req.cwd}"`,
      `git clone -q "${remoteBundle}" "${req.cwd}"`,
      req.commit ? `cd "${req.cwd}" && git checkout -q ${req.commit}` : "",
      `cd "${req.cwd}" && git gc --prune=now 2>/dev/null`,
      `cd "${req.cwd}" && git rev-parse HEAD`,
    ]
      .filter(Boolean)
      .join(" && ");

    const { stdout } = await execFileP("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, unpackCmd], {
      timeout: 120_000,
    });

    return {
      ok: true,
      cwd: req.cwd,
      branch: req.branch ?? "main",
      commit: stdout.trim(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    // Always remove the remote bundle, even on failure, to avoid bloat.
    try {
      await execFileP("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, `rm -f "${remoteBundle}"`], {
        timeout: 30_000,
      });
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
): Promise<ProvisionResult> {
  const work = await mkdtemp(join(tmpdir(), "fleet-sync-"));
  try {
    // Worker creates a bundle of its current state.
    const remoteBundle = `/tmp/fleet-sync-${Date.now()}.bundle`;
    const workerCmd = `cd "${cwd}" && git bundle create "${remoteBundle}" --all 2>/dev/null; echo "BUNDLE_READY"`;
    await execFileP("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, workerCmd], {
      timeout: 120_000,
    });

    // Pull the bundle back to the manager.
    const localBundle = join(work, "worker.bundle");
    await execFileP("scp", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", `${nodeHost}:${remoteBundle}`, localBundle], {
      timeout: 120_000,
    });

    // Apply the bundle to a fresh clone and push with manager creds.
    const cloneDir = join(work, "repo");
    await execFileP("git", ["clone", "--branch", branch, repo, cloneDir], { timeout: 120_000 });
    await execFileP("git", ["-C", cloneDir, "pull", localBundle, branch], { timeout: 120_000 });
    await execFileP("git", ["-C", cloneDir, "push", "origin", branch], { timeout: 120_000 });

    // Clean up the remote bundle.
    await execFileP("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, `rm -f "${remoteBundle}"`], {
      timeout: 30_000,
    });

    return { ok: true, cwd, branch, commit: "pushed" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
