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
import { SSH_ARGS, scpPrefix, scpRemote, sshPrefix } from "./ssh.js";
import { checkSetup } from "./policy.js";
import { evaluateChange, isSafeBranchName, resolveDestination, resolvePolicy, type SyncPolicy } from "./syncpolicy.js";

const execFileP = promisify(execFile);

/**
 * Resolve a caller-supplied repo reference into something `git clone` can use.
 *
 * `git clone` treats a bare `owner/repo` as a LOCAL filesystem path, so a
 * shorthand like `mdlmarkham/OHM_ts_sidecar` fails with `fatal: repository
 * ... does not exist` unless the machine happens to carry a `url.insteadOf`
 * rewrite. Fleet nodes and the manager do not, by default. Normalize the
 * common GitHub shorthand to an HTTPS URL; leave anything that already looks
 * like a URL, an scp-style address, an absolute/local path, or a file:// URL
 * untouched so explicit forms keep working.
 */
export function normalizeRepo(repo: string): string {
    const r = repo.trim();
    if (!r)
        return r;
    // Already a URL or remote scheme (https://, ssh://, git://, file://, git@host:path).
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@[^:]+:)/i.test(r))
        return r;
    // Absolute or explicit relative filesystem path.
    if (r.startsWith("/") || r.startsWith("./") || r.startsWith("../") || r.startsWith("~"))
        return r;
    // Windows drive path.
    if (/^[a-zA-Z]:[\\/]/.test(r))
        return r;
    // GitHub-style shorthand: owner/repo (optionally with a .git suffix).
    if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(r)) {
        const cleaned = r.endsWith(".git") ? r : `${r}.git`;
        return `https://github.com/${cleaned}`;
    }
    // Unknown shape — hand it back unchanged rather than guessing.
    return r;
}

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
  /** Operator opt-in: `setup` may be an arbitrary shell command (issue #34). */
  allowSetupCommands?: boolean;
  /**
   * The node's worker principal (issue #71). The checkout is handed to this
   * user and provisioning FAILS if it cannot be. Defaults to the owner of the
   * target's parent directory.
   */
  serviceUser?: string;
}


const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/**
 * Shell fragment (issue #71) that leaves `cwd` owned by the worker principal
 * and FAILS (exit 68) otherwise, instead of reading as success while the worker
 * cannot write. The SSH principal is often root, so the clone lands root-owned.
 *
 * Expected owner: `serviceUser`, else the owner of cwd's parent directory (a
 * root-owned parent means there is nothing to compare, so no check). When run
 * as root it chowns; when not root it only verifies. If the expected owner is
 * the current user it also proves the directory is writable.
 */
export function ownershipCommand(cwd: string, serviceUser?: string): string {
  if (serviceUser !== undefined && !USER_RE.test(serviceUser)) {
    throw new Error(`invalid serviceUser: ${JSON.stringify(serviceUser)}`);
  }
  const owner = serviceUser
    ? shq(serviceUser)
    : `"$(stat -c %U "$(dirname ${shq(cwd)})" 2>/dev/null || stat -f %Su "$(dirname ${shq(cwd)})")"`;
  const fail = (msg: string) => `{ echo "FLEET_ERROR: ${msg}" >&2; exit 68; }`;
  return [
    "(",
    `__OWN=${owner};`,
    `if [ "$__OWN" != root ]; then`,
    `id -u "$__OWN" >/dev/null 2>&1 || ${fail("worker user $__OWN does not exist on this node")};`,
    `if [ "$(id -u)" = 0 ]; then chown -R "$__OWN": ${shq(cwd)} || ${fail("could not hand the checkout to $__OWN")}; fi;`,
    `[ "$(stat -c %U ${shq(cwd)} 2>/dev/null || stat -f %Su ${shq(cwd)})" = "$__OWN" ] || ${fail("checkout is not owned by the worker user $__OWN")};`,
    `if [ "$(id -un)" = "$__OWN" ]; then touch ${shq(cwd)}/.fleet-write-test && rm -f ${shq(cwd)}/.fleet-write-test || ${fail("checkout is not writable by $__OWN")}; fi;`,
    "fi",
    ")",
  ].join(" ");
}

export interface ProvisionResult {
  ok: boolean;
  cwd?: string;
  branch?: string;
  /** The worker's checked-out branch that carried the synced work, when it
   * differed from the destination branch. */
  workerBranch?: string;
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
    if (!isSafeBranchName(branch)) throw new Error(`unsafe branch name: ${JSON.stringify(branch)}`);

    // Clone with manager credentials (uses ambient gh/git auth).
    // Full clone (no --depth) so the bundle carries complete history the
    // worker can traverse.
    await execFileP("git", ["clone", "--branch", branch, "--", normalizeRepo(req.repo), cloneDir], {
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
    const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), cmds], {
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
  let bundleSha256: string | undefined;
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
      await execFileP("scp", [...scpPrefix(), bundlePath, scpRemote(nodeHost, remoteBundle)], {
        timeout: 120_000,
      });
    } catch (sshErr) {
      shippedViaChannel = true;
      if (!channelInvoke) throw new Error("channel invoke required for SSH-free provisioning");
      const { chunkBuffer } = await import("./ledger.js");
      const fs = await import("node:fs/promises");
      const bundleBytes = await fs.readFile(bundlePath);
      bundleSha256 = (await import("node:crypto")).createHash("sha256").update(bundleBytes).digest("hex");
      const chunks = chunkBuffer(bundleBytes);
      // One invoke per chunk keeps each message small; the node accumulates.
      for (let i = 0; i < chunks.length; i++) {
        // The node accepts each index once (a retry of an accepted chunk is a
        // no-op), so one retry on a transport error cannot double-append.
        let lastErr = "";
        let accepted = false;
        for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
          try {
            const res = (await channelInvoke(
              { prompt: "__RECEIVE__", cwd: "/", transport: "http", transferId, chunkIndex: i, chunks: [chunks[i]] },
              60_000,
            )) as { payload?: unknown };
            const pl = typeof res?.payload === "string" ? JSON.parse(res.payload) : (res?.payload ?? {});
            if ((pl as { ok?: boolean }).ok) accepted = true;
            else lastErr = String((pl as { error?: string }).error ?? "chunk rejected");
          } catch (e) {
            lastErr = (e as Error).message;
          }
        }
        if (!accepted) throw new Error(`bundle transfer failed at chunk ${i}/${chunks.length}: ${lastErr}`);
      }
    }

    // Issue #14: the manager lands as the SSH principal (root by default),
    // but the checkout is owned by the node's service user. Git then refuses
    // every operation on the repo with "dubious ownership" (rc=128), which
    // surfaced later as an opaque `git status failed` in fleet_sync. Establish
    // the precondition HERE, at provision time, at --system scope so it covers
    // whichever account the sync path uses and cannot recur for a different
    // user. Must run as a principal that can write the system git config —
    // root, i.e. the same principal the manager lands as.
    const safeDirCmd = [
      `git config --system --get-all safe.directory 2>/dev/null | grep -qxF ${shq(req.cwd)}`,
      `|| git config --system --add safe.directory ${shq(req.cwd)}`,
      `;`,
      `git config --system --get-all safe.directory 2>/dev/null | grep -qxF ${shq(req.cwd)}`,
      `|| { echo "FLEET_ERROR: could not set safe.directory for ${shq(req.cwd)}" >&2; exit 67; }`,
      `;`,
      `echo "---FLEET_SAFEDIR=ok"`,
      `;`,
      `true`,
    ].join(" ");

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
      // Issue #71: hand the checkout to the worker principal and verify it.
      ownershipCommand(req.cwd, req.serviceUser),
      // Issue #14: set safe.directory for the landing principal right after
      // the clone, before any later operation can trip over dubious ownership.
      safeDirCmd,
      `cd ${shq(req.cwd)} && git rev-parse HEAD`,
    ].filter(Boolean).join(" && ");

    let unpackOut = "";
    if (shippedViaChannel && channelInvoke) {
      const res = (await channelInvoke(
        { prompt: "__UNPACK__", cwd: req.cwd, transport: "http", transferId, commit: req.commit, sha256: bundleSha256 },
        180_000,
      )) as { payload?: unknown };
      const pl = typeof res?.payload === "string" ? JSON.parse(res.payload) : (res?.payload ?? {});
      if (!pl.ok) throw new Error(pl.error ?? "channel unpack failed");
      unpackOut = String(pl.commit ?? "");
    } else {
      const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), unpackCmd], {
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
      const setupPolicy = checkSetup(req.setup, req.allowSetupCommands === true);
      if (!setupPolicy.ok) {
        return { ok: false, cwd: req.cwd, error: setupPolicy.error, setup: { ran: false, command: req.setup, ok: false, error: setupPolicy.error } };
      }
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
          const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), setupCmd], {
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
        await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), `rm -f "${remoteBundle}"`], {
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
  prebuilt?: { mode: "from-base64"; base64: string; branch?: string; base?: string; workerBranch?: string; destBranch?: string },
  destBranchPinned?: string,
  syncPolicy?: Partial<SyncPolicy>,
): Promise<ProvisionResult & { synced?: boolean; uncommittedFiles?: number; detail?: string; redirectedFrom?: string }> {
  const policy = resolvePolicy(syncPolicy);
  for (const [kind, v] of [["branch", branch], ["destination branch", destBranchPinned]] as const) {
    if (v !== undefined && !isSafeBranchName(v)) {
      return { ok: false, cwd, branch, commit: "refused", synced: false, error: `unsafe ${kind} name: ${JSON.stringify(v)}` };
    }
  }
  // Issue #33: protected destinations are redirected, CI/secret changes refused.
  // Returns a refusal result, or the destination actually used.
  const applyPolicy = async (
    cloneDir: string,
    workerBranch: string,
    requested: string,
    bundleRef: string,
    base: string,
  ): Promise<{ refused: ProvisionResult & { synced: boolean; detail?: string } } | { dest: string; redirectedFrom?: string }> => {
    if (!isSafeBranchName(workerBranch)) {
      return { refused: { ok: false, cwd, branch: requested, commit: "refused", synced: false, error: `unsafe worker branch name: ${JSON.stringify(workerBranch)}` } };
    }
    const d = resolveDestination(requested, workerBranch, `sync-${Date.now()}`, policy);
    const range = `origin/${base}...${bundleRef}`;
    const { stdout: names } = await execFileP("git", ["-C", cloneDir, "diff", "--no-ext-diff", "--name-only", range], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const { stdout: diff } = await execFileP("git", ["-C", cloneDir, "diff", "--text", "--no-textconv", "--no-ext-diff", "--unified=0", range], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const check = evaluateChange(names.split("\n").filter(Boolean), diff, policy);
    if (!check.ok) {
      return { refused: { ok: false, cwd, branch: d.branch, workerBranch, commit: "policy-refused", synced: false, error: check.error, detail: check.detail } };
    }
    return { dest: d.branch, redirectedFrom: d.redirectedFrom };
  };

  // Destination-branch resolution (issue #13, layer 3).
  //
  // `branch` is the CLONE BASE: the branch that exists on origin and that we
  // check out to apply the worker's bundle. It is NOT necessarily where the
  // worker's work should land. Conflating the two is the layer-3 defect:
  //   - the from-base64 path collapsed `destBranch` to `prebuilt.branch ?? branch`,
  //     so a feature-branch worker was always pushed at `main`;
  //   - the SSH path inferred the destination from `workerBranch !== branch`,
  //     which is always TRUE when the caller passes a defaulted `main`, so it
  //     silently took the feature-branch arm (and could not express "pin main").
  //
  // A destination is PINNED only when the caller explicitly names one. Otherwise
  // we auto-select: publish the worker's own branch when it differs from the
  // clone base (feature-branch work stays reviewable), else the clone base.
  const chooseDest = (workerBranch: string, pinnedDest?: string): string =>
    pinnedDest ?? (workerBranch && workerBranch !== branch ? workerBranch : branch);

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
      // Clone a branch that EXISTS on origin (the clone base). The worker's own
      // branch usually does NOT exist remotely yet — creating it is the entire
      // purpose of sync — so `--branch <worker-branch>` would fail with "Remote
      // branch ... not found in upstream origin". Clone the base, then fetch
      // the worker's refs from the bundle, and push to the RESOLVED destination.
      await execFileP("git", ["clone", "--branch", branch, "--", normalizeRepo(repo), cloneDir], { timeout: 120_000 });
      const workerBranch = prebuilt.workerBranch ?? branch;
      let destBranch = chooseDest(workerBranch, prebuilt.destBranch);
      let redirectedFrom: string | undefined;
      // Fetch every bundle ref under refs/remotes/bundler/* so we can push the
      // worker's actual branch even when it is not the destination branch.
      await execFileP("git", ["-C", cloneDir, "fetch", localBundle,
          "refs/heads/*:refs/remotes/bundler/*"], { timeout: 120_000 });
      const bundleRef = `refs/remotes/bundler/${workerBranch}`;
      try {
        await execFileP("git", ["-C", cloneDir, "rev-parse", "--verify", "--quiet", bundleRef], { timeout: 30_000 });
      }
      catch {
        return {
          ok: false,
          cwd,
          branch: destBranch,
          commit: "detection-failed",
          error: `worker bundle did not contain branch "${workerBranch}"`,
          detail: "refusing to report success when the worker branch is absent from the bundle (fail-closed)",
        };
      }
      {
        const applied = await applyPolicy(cloneDir, workerBranch, destBranch, bundleRef, branch);
        if ("refused" in applied) return { ...applied.refused, viaChannel: true };
        destBranch = applied.dest;
        redirectedFrom = applied.redirectedFrom;
      }
      // Record the destination's current head BEFORE pushing, so we can tell a
      // real push from a no-op. A destination branch that does not exist yet is
      // NOT an error — creating it remotely is the whole point of sync — so a
      // missing ref resolves to an empty prior head rather than throwing.
      const priorHead = await (async () => {
        try {
          const { stdout } = await execFileP("git", ["-C", cloneDir, "rev-parse", `refs/remotes/origin/${destBranch}`], { timeout: 30_000 });
          return stdout.trim();
        }
        catch {
          return "";
        }
      })();
      try {
        await execFileP("git", ["-C", cloneDir, "push", "origin", `${bundleRef}:refs/heads/${destBranch}`], { timeout: 120_000 });
      }
      catch (pushErr) {
        const msg = (pushErr as Error).message;
        if (/non-fast-forward|\[rejected\]|fetch first/i.test(msg)) {
          return {
            ok: false,
            cwd,
            branch: destBranch,
            workerBranch,
            commit: "push-rejected",
            synced: false,
            viaChannel: true,
            error: `push to origin/${destBranch} rejected (non-fast-forward)`,
            detail: `origin/${destBranch} has advanced past the worker's base; the worker's commits are in the bundle but were NOT published. Rebasing the worker branch onto origin/${destBranch} is required.`,
          };
        }
        throw pushErr;
      }
      // Confirm the push actually published NEW work. Two checks, because a
      // destination branch may or may not have pre-existed:
      //   1. if it existed, the remote ref must have MOVED (priorHead differs);
      //   2. if it did not exist (a freshly created branch), the worker's ref
      //      must at least differ from the clone base tip — otherwise we just
      //      created a branch identical to its base and there is nothing new.
      // Without (2), a worker with zero new commits reports "pushed".
      await execFileP("git", ["-C", cloneDir, "fetch", "origin", `refs/heads/${destBranch}:refs/remotes/origin/${destBranch}`], { timeout: 60_000 });
      const { stdout: postHead } = await execFileP("git", ["-C", cloneDir, "rev-parse", `refs/remotes/origin/${destBranch}`], { timeout: 30_000 });
      const { stdout: bundleTip } = await execFileP("git", ["-C", cloneDir, "rev-parse", bundleRef], { timeout: 30_000 });
      const { stdout: baseTip } = await execFileP("git", ["-C", cloneDir, "rev-parse", `origin/${branch}`], { timeout: 30_000 });
      const movedRemote = priorHead !== "" && priorHead !== postHead.trim();
      const hasNewWork = bundleTip.trim() !== baseTip.trim();
      if (!movedRemote && !hasNewWork) {
        return {
          ok: true,
          cwd,
          branch: destBranch,
          workerBranch,
          commit: "no-changes",
          synced: false,
          viaChannel: true,
          detail: `worker branch "${workerBranch}" carried no commits new to origin/${branch} — nothing pushed`,
        };
      }
      return {
        ok: true,
        cwd,
        branch: destBranch,
        workerBranch,
        commit: "pushed",
        synced: true,
        ...(redirectedFrom ? { redirectedFrom } : {}),
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
      const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), statusCmd], {
        timeout: 30_000,
      });
      const m = stdout.match(/---FLEET_STATUS_RC=(-?\d+)/);
      const rc = m ? parseInt(m[1], 10) : NaN;
      if (!Number.isFinite(rc) || rc !== 0) {
        // Issue #14: make the reason legible. A bare rc=128 sent the operator
        // hunting; git's dubious-ownership refusal is the common cause and is
        // directly actionable, so name it (and the fix) when we see it.
        const out = stdout.toLowerCase();
        let reason = `git status failed on ${nodeHost} (rc=${Number.isFinite(rc) ? rc : "unknown"}) — cannot determine tree state`;
        if (out.includes("dubious ownership") || out.includes("safe.directory")) {
          reason = `git status refused on ${nodeHost} (rc=${Number.isFinite(rc) ? rc : "unknown"}) — dubious ownership of ${cwd}: the checkout is owned by a different principal than the one the manager lands as. Run fleet_provision to set safe.directory for the landing principal, or set it manually: git config --system --add safe.directory ${cwd}`;
        } else {
          const tail = stdout.split("---FLEET_STATUS_RC=")[0].trim().split("\n").slice(-3).join(" | ");
          if (tail) reason += ` — git said: ${tail}`;
        }
        dirtyErr = reason;
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
      await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), commitCmd], {
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
      [...sshPrefix(nodeHost, SSH_ARGS), resolveBaseCmd],
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
    await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), workerCmd], {
      timeout: 120_000,
    });

    // Step 4: pull the bundle back to the manager.
    const localBundle = join(work, "worker.bundle");
    await execFileP("scp", [...scpPrefix(), scpRemote(nodeHost, remoteBundle), localBundle], {
      timeout: 120_000,
    });

    // Apply the bundle to a fresh clone and push with manager creds.
    const cloneDir = join(work, "repo");
    // Clone a branch that EXISTS on origin (the destination branch). The
    // worker's own branch usually does NOT exist remotely yet — creating it is
    // the purpose of sync — so `--branch <worker-branch>` fails. Clone the
    // destination branch, then fetch the worker's refs from the bundle.
    await execFileP("git", ["clone", "--branch", branch, "--", normalizeRepo(repo), cloneDir], { timeout: 120_000 });
    // Detect the worker's checked-out branch (its work often lives on a feature
    // branch, not `main`); fall back to the destination branch when HEAD is
    // detached or unavailable.
    let workerBranch = branch;
    try {
      const { stdout: curOut } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS),
          `cd ${shq(cwd)} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`], { timeout: 30_000 });
      const cur = curOut.trim();
      if (cur && cur !== "HEAD") workerBranch = cur;
    }
    catch {
      // Keep the destination branch fallback.
    }
    await execFileP("git", ["-C", cloneDir, "fetch", localBundle,
        "refs/heads/*:refs/remotes/bundler/*"], { timeout: 120_000 });
    const bundleRef = `refs/remotes/bundler/${workerBranch}`;
    try {
      await execFileP("git", ["-C", cloneDir, "rev-parse", "--verify", "--quiet", bundleRef], { timeout: 30_000 });
    }
    catch {
      // Clean up the remote bundle before failing closed.
      await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), `rm -f ${shq(remoteBundle)}`], { timeout: 30_000 });
      return {
        ok: false,
        cwd,
        branch,
        commit: "detection-failed",
        error: `worker bundle did not contain branch "${workerBranch}"`,
        detail: "refusing to report success when the worker branch is absent from the bundle (fail-closed)",
      };
    }
    // Resolve the destination branch (issue #13, layer 3). Prefer an explicitly
    // pinned destination when the caller provided one; otherwise publish the
    // worker's own branch when it differs from the clone base, so feature-branch
    // work stays reviewable rather than being forced onto `main`.
    let destBranch = chooseDest(workerBranch, destBranchPinned);
    let redirectedFrom: string | undefined;
    {
      const applied = await applyPolicy(cloneDir, workerBranch, destBranch, bundleRef, branch);
      if ("refused" in applied) {
        await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), `rm -f ${shq(remoteBundle)}`], { timeout: 30_000 }).catch(() => {});
        return applied.refused;
      }
      destBranch = applied.dest;
      redirectedFrom = applied.redirectedFrom;
    }
    // Record the destination's current head BEFORE pushing, so we can tell a
    // real push from a no-op. A destination branch that does not exist yet is
    // NOT an error — creating it remotely is the whole point of sync — so a
    // missing ref resolves to an empty prior head rather than throwing.
    const priorHead = await (async () => {
      try {
        const { stdout } = await execFileP("git", ["-C", cloneDir, "rev-parse", `refs/remotes/origin/${destBranch}`], { timeout: 30_000 });
        return stdout.trim();
      }
      catch {
        return "";
      }
    })();
    // Push the worker's commits to a destination branch that mirrors the work.
    // Pushing a feature branch straight onto `main` is both semantically wrong
    // (it bypasses review) and frequently NON-fast-forward, since origin/main
    // may have advanced past the worker's base. When the caller did not pin an
    // explicit destination and the worker is on a feature branch, publish the
    // SAME branch name remotely (creating it if absent) so the work can be
    // reviewed/PR'd. Then report the real destination in the result.
    let pushOutcome = "pushed";
    try {
      await execFileP("git", ["-C", cloneDir, "push", "origin", `${bundleRef}:refs/heads/${destBranch}`], { timeout: 120_000 });
    }
    catch (pushErr) {
      const msg = (pushErr as Error).message;
      // Non-fast-forward: origin/<destBranch> advanced past the worker's base.
      // Do NOT fabricate success. Report the real rejection so the operator can
      // rebase/merge; silently dropping the worker's work is the bug class we
      // are eliminating.
      if (/non-fast-forward|\[rejected\]|fetch first/i.test(msg)) {
        return {
          ok: false,
          cwd,
          branch,
          workerBranch,
          commit: "push-rejected",
          synced: false,
          uncommittedFiles: uncommitted,
          error: `push to origin/${destBranch} rejected (non-fast-forward)`,
          detail: `origin/${destBranch} has advanced past the worker's base; the worker's commits are in the bundle but were NOT published. Rebasing the worker branch onto origin/${destBranch} is required.`,
        };
      }
      throw pushErr;
    }
    // Confirm the push actually published NEW work. Two checks, because a
    // destination branch may or may not have pre-existed:
    //   1. if it existed, the remote ref must have MOVED (priorHead differs);
    //   2. if it did not exist (a freshly created branch), the worker's ref
    //      must at least differ from the clone base tip — otherwise we just
    //      created a branch identical to its base and there is nothing new.
    // Without (2), a worker with zero new commits reports "pushed".
    await execFileP("git", ["-C", cloneDir, "fetch", "origin", `refs/heads/${destBranch}:refs/remotes/origin/${destBranch}`], { timeout: 60_000 });
    const { stdout: postHead } = await execFileP("git", ["-C", cloneDir, "rev-parse", `refs/remotes/origin/${destBranch}`], { timeout: 30_000 });
    const { stdout: bundleTip } = await execFileP("git", ["-C", cloneDir, "rev-parse", bundleRef], { timeout: 30_000 });
    const { stdout: baseTip } = await execFileP("git", ["-C", cloneDir, "rev-parse", `origin/${branch}`], { timeout: 30_000 });
    const movedRemote = priorHead !== "" && priorHead !== postHead.trim();
    const hasNewWork = bundleTip.trim() !== baseTip.trim();

    // Clean up the remote bundle.
    await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), `rm -f ${shq(remoteBundle)}`], {
      timeout: 30_000,
    });

    if (!movedRemote && !hasNewWork) {
      return {
        ok: true,
        cwd,
        branch,
        workerBranch,
        commit: "no-changes",
        synced: false,
        uncommittedFiles: uncommitted,
        detail: `worker branch "${workerBranch}" carried no commits new to origin/${destBranch} — nothing pushed`,
      };
    }
    return {
      ok: true,
      cwd,
      branch: destBranch,
      workerBranch,
      commit: "pushed",
      synced: true,
      ...(redirectedFrom ? { redirectedFrom } : {}),
      uncommittedFiles: uncommitted,
      detail: uncommitted > 0
          ? `committed ${uncommitted} uncommitted file(s) on node, then pushed worker branch "${destBranch}"`
          : `pushed worker branch "${destBranch}"`,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
