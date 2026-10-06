/**
 * Fleet deploy — one-command build, pack, install, and restart for the
 * opencode-fleet plugin across the gateway + all worker nodes.
 *
 * Collapses the manual cycle:
 *   build → pack → install gateway → copy to nodes → install nodes →
 *   restart node services → restart gateway → verify
 *
 * The gateway restart is intentionally NOT done here (it kills the session
 * running this tool). The tool returns a "restart required" signal and the
 * caller performs the final gateway restart.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { SSH_ARGS, scpPrefix, scpRemote, sshPrefix } from "./ssh.js";
import {
  inspectRemoteInstallRecord,
  repairRemoteInstallRecord,
  needsRepair,
} from "./install-record.js";
import { runSelfCheck } from "./selfcheck.js";

const execFileP = promisify(execFile);

export interface DeployRequest {
  /** Plugin repo root (where package.json lives). */
  pluginDir: string;
  /** Node hosts to deploy to (SSH names). */
  nodes: string[];
  /**
   * Principal each node's OpenClaw service runs as, keyed by host. Issue #18:
   * the install must land in THIS principal's plugin root, not the SSH login
   * user's. When absent for a host, the install runs as the SSH default and
   * the result is reported as an unverified assumption.
   */
  nodeUsers?: Record<string, string>;
  /** SSH login user per host, when it differs from the SSH default. */
  nodeLoginUsers?: Record<string, string>;
  /** Whether to restart node services after install. */
  restartNodes?: boolean;
  /**
   * Issue #24: after install+restart, run a known-trivial dispatch on each node
   * and fail the deploy if the token does not come back. Default true — the
   * whole point is that "hash matches" is not "works".
   */
  selfCheck?: boolean;
}

/**
 * What a caller needs to know to APPLY the build (issue #191). A `plugins reload` of the active
 * fleet plugin did not settle in the field and left the gateway draining until an owner restart.
 */
export const DEPLOY_NOTES: string[] = [
  "Apply with an owner gateway RESTART issued from outside an agent turn, not `plugins reload opencode-fleet`: a reload of the active plugin has been seen to never settle and leave the gateway draining (issue #191; see docs/DEPLOY.md).",
  "Sessions started before the restart keep their old tool list and cannot call tools added since: start a new session.",
];

export interface DeployResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  gatewayRestartRequired: boolean;
  /** How to apply the new build safely (issue #191). Present on a successful deploy. */
  notes?: string[];
  error?: string;
}

/** Quote a string for safe use as a single POSIX shell argument. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Hash the built dist/index.js so we can prove the installed copy matches. */
async function builtIndexHash(pluginDir: string): Promise<string> {
  const { stdout } = await execFileP("sha256sum", [join(pluginDir, "dist", "index.js")], { timeout: 30_000 });
  return stdout.trim().split(/\s+/)[0];
}

/**
 * Run the full deploy cycle except the gateway restart.
 */
/**
 * Issue #238: the build/pack steps run npm with cwd = pluginDir. For an INSTALLED plugin the
 * derived default is the gateway's extensions root, which has no package.json — npm dies with a
 * bare ENOENT ("build failed") and no operator guidance. Validate BEFORE any npm call and name
 * the remedy: point the tool's `pluginDir` param (or the `deploy.pluginDir` config) at the repo
 * checkout that actually has package.json.
 */
export function validatePluginDir(dir: string): { ok: true } | { ok: false; error: string } {
  if (!existsSync(join(dir, "package.json"))) {
    return {
      ok: false,
      error: `no package.json at pluginDir '${dir}': this is not a plugin repo checkout — pass pluginDir (the repo where package.json lives) or set deploy.pluginDir in the plugin config`,
    };
  }
  return { ok: true };
}

export async function deployPlugin(req: DeployRequest): Promise<DeployResult> {
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
  const add = (step: string, ok: boolean, detail?: string) => steps.push({ step, ok, detail });

  // Issue #238: refuse BEFORE npm ever runs when pluginDir is not a package dir — the old
  // behavior surfaced as a bare "build failed" (ENOENT reading package.json) when the derived
  // default (the installed plugin's parent dir) was not the repo.
  const dirCheck = validatePluginDir(req.pluginDir);
  if (!dirCheck.ok) {
    add("resolve-plugin-dir", false, dirCheck.error);
    return { ok: false, steps, gatewayRestartRequired: false, error: `no package.json at pluginDir '${req.pluginDir}': pass pluginDir (the plugin repo checkout) or set deploy.pluginDir in the plugin config` };
  }


  try {
    // 1. Build.
    try {
      await execFileP("npm", ["run", "build"], { cwd: req.pluginDir, timeout: 120_000 });
      add("build", true);
    } catch (e) {
      add("build", false, (e as Error).message);
      return { ok: false, steps, gatewayRestartRequired: false, error: "build failed" };
    }

    // 2. Pack.
    let tarball = "";
    try {
      const { stdout } = await execFileP("npm", ["pack", "--json"], { cwd: req.pluginDir, timeout: 60_000 });
      const parsed = JSON.parse(stdout);
      tarball = join(req.pluginDir, parsed[0]?.filename ?? "");
      add("pack", true, tarball);
    } catch (e) {
      add("pack", false, (e as Error).message);
      return { ok: false, steps, gatewayRestartRequired: false, error: "pack failed" };
    }

    // 3. Install on gateway.
    try {
      await execFileP("openclaw", ["plugins", "install", tarball, "--force", "--accept-capabilities"], {
        timeout: 120_000,
      });
      add("install-gateway", true);
    } catch (e) {
      add("install-gateway", false, (e as Error).message);
      return { ok: false, steps, gatewayRestartRequired: false, error: "gateway install failed" };
    }

    // Hash the build we just produced so we can prove the node-installed copy
    // is the same artifact (issue #18, defect 3).
    let builtHash = "";
    try {
      builtHash = await builtIndexHash(req.pluginDir);
      add("hash-build", true, builtHash);
    } catch (e) {
      add("hash-build", false, (e as Error).message);
      return { ok: false, steps, gatewayRestartRequired: false, error: "could not hash built artifact" };
    }

    // 4. Copy + install on each node.
    let anyNodeFailed = false;
    for (const host of req.nodes) {
      const serviceUser = req.nodeUsers?.[host];
      const loginUser = req.nodeLoginUsers?.[host];
      const sshHost = loginUser ? `${loginUser}@${host}` : host;
      if (loginUser === "root") {
        add(
          `ssh-user-${host}`,
          true,
          "WARNING: managing this node over SSH as root. Prefer an unprivileged login user (nodes[].user) with a narrow sudoers entry; see README 'SSH access'.",
        );
      } else if (!loginUser) {
        add(
          `ssh-user-${host}`,
          true,
          "note: no nodes[].user set, so SSH uses its default login user (often root). Set nodes[].user to an unprivileged account; see README 'SSH access'.",
        );
      }
      const tarballName = tarball.split("/").pop() ?? "";
      try {
        // Issue #20: defuse the stale-root-install-record footgun BEFORE
        // installing. A node that once installed as root carries a record
        // whose installPath is under /root, which makes the CLI's retire phase
        // EACCES and exit rc=1 despite a successful install. Detect AS THE
        // SERVICE PRINCIPAL (invisible as root), back up, and repair.
        // Detection failure is surfaced, never guessed as "clean".
        if (serviceUser) {
          // Resolve the service principal's real HOME on the node rather than
          // guessing /home/<user> (breaks for non-standard homes). `sudo -H`
          // also sets HOME for the child, so echo it under the target user.
          let serviceHome = "";
          try {
            const { stdout: homeOut } = await execFileP(
              "ssh",
              [...sshPrefix(sshHost, SSH_ARGS), `sudo -n -u ${shq(serviceUser)} -H bash -c 'printf %s "$HOME"'`],
              { timeout: 30_000 },
            );
            serviceHome = homeOut.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
          } catch {
            serviceHome = "";
          }
          if (!serviceHome || !serviceHome.startsWith("/")) {
            add(`record-check-${host}`, false, `could not resolve ${serviceUser}'s HOME on the node`);
          } else {
            const finding = await inspectRemoteInstallRecord(SSH_ARGS, sshHost, serviceUser, serviceHome);
            if (finding.error) {
              add(`record-check-${host}`, false, finding.error);
            } else if (needsRepair(finding)) {
              const repaired = await repairRemoteInstallRecord(SSH_ARGS, sshHost, serviceUser, serviceHome);
              if (repaired.repaired) {
                const why = [
                  finding.stale ? `stale installPath ${finding.installPath}` : "",
                  finding.nullFields.length ? `null fields [${finding.nullFields.join(",")}]` : "",
                ].filter(Boolean).join("; ");
                add(`record-repair-${host}`, true, `repaired ${why} (backup ${repaired.backup})`);
              } else {
                anyNodeFailed = true;
                add(`record-repair-${host}`, false, repaired.error ?? "repair failed");
              }
            } else {
              add(`record-check-${host}`, true, finding.present ? "install record clean" : "no prior install record");
            }
          }
        } else {
          // No serviceUser: we cannot inspect the record as the service
          // principal, and as root the EACCES is invisible — so we CANNOT
          // claim the node is clean. Emitting nothing here would let a blind
          // spot masquerade as a pass (the very false-negative-as-success
          // shape this issue exists to kill). Report the blind spot as a
          // FAILED step so it is visible in the deploy result.
          anyNodeFailed = true;
          add(
            `record-check-${host}`,
            false,
            "no serviceUser configured — cannot inspect the install record as the service principal (blind as root); set nodes[].serviceUser to enable the stale-record check",
          );
        }

        // Stage the tarball in a fresh directory only we can write (mktemp -d is
        // 0700; 711 lets the service user traverse to the 0644 file but nobody
        // else can replace it between the checksum and the install), then verify
        // its sha256 on the node BEFORE installing anything.
        const tarballSha = createHash("sha256").update(await readFile(tarball)).digest("hex");
        const { stdout: stageOut } = await execFileP(
          "ssh",
          [...sshPrefix(sshHost, SSH_ARGS), `d=$(mktemp -d /tmp/fleet-deploy.XXXXXX) && chmod 711 "$d" && echo "FLEET_STAGE=$d"`],
          { timeout: 30_000 },
        );
        const stage = stageOut.match(/FLEET_STAGE=(\/tmp\/fleet-deploy\.[A-Za-z0-9]+)\s*$/m)?.[1];
        if (!stage) throw new Error(`could not create a private staging directory on the node: ${stageOut.trim().slice(0, 200)}`);
        // Issue #18 defect 1: install as the SERVICE principal, not the SSH
        // login user. When the caller names one, install into that user's
        // environment; otherwise fall back to the login user's environment and
        // mark the step unverified (no silent success).
        // Issue #18 defect 2: the formatter pipe is removed. The install's own
        // exit code must gate the step; we capture output and require an
        // explicit success sentinel.
        const installInner =
          `cd ${shq(stage)} && openclaw plugins install ${shq(tarballName)} --force --accept-capabilities 2>&1; ` +
          `rc=$?; echo "FLEET_INSTALL_RC=$rc"; exit $rc`;
        // Use a NON-login shell (`bash -c`): a login shell (`bash -lc`) sources
        // the user's profile and can print MOTD/banner text on stdout, which
        // would corrupt the rc/hash we parse back. `sudo -H` already sets HOME.
        const installCmd = serviceUser
          ? `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(installInner)}`
          : installInner;
        // Upload, verify and install in one try/finally so the private staging
        // directory is removed on EVERY failure after it was created.
        let installOut: string;
        try {
          await execFileP("scp", [...scpPrefix(), tarball, scpRemote(sshHost, `${stage}/${tarballName}`)], {
            timeout: 120_000,
          });
          const { stdout: remoteShaOut } = await execFileP(
            "ssh",
            [...sshPrefix(sshHost, SSH_ARGS), `chmod 644 -- ${shq(`${stage}/${tarballName}`)} && sha256sum -- ${shq(`${stage}/${tarballName}`)} | cut -d' ' -f1`],
            { timeout: 30_000 },
          );
          const remoteSha = remoteShaOut.trim().split("\n").pop()?.trim() ?? "";
          if (remoteSha !== tarballSha) {
            throw new Error(`tarball checksum mismatch on the node (expected ${tarballSha.slice(0, 12)}, got ${remoteSha.slice(0, 12) || "none"}); refusing to install`);
          }


          ({ stdout: installOut } = await execFileP(
            "ssh",
            [...sshPrefix(sshHost, SSH_ARGS), installCmd],
            { timeout: 120_000 },
          ));
        } finally {
          await execFileP("ssh", [...sshPrefix(sshHost, SSH_ARGS), `rm -rf -- ${shq(stage)}`], { timeout: 30_000 }).catch(() => {});
        }
        const rcMatch = installOut.match(/FLEET_INSTALL_RC=(-?\d+)/);
        const irc = rcMatch ? parseInt(rcMatch[1], 10) : NaN;
        if (!Number.isFinite(irc) || irc !== 0) {
          throw new Error(
            `install exited rc=${Number.isFinite(irc) ? irc : "unknown"} — output: ${installOut.trim().slice(-300)}`,
          );
        }
        add(
          `install-${host}`,
          true,
          serviceUser ? `installed as ${serviceUser}` : "installed as SSH login user (service principal unverified)",
        );

        // Issue #18 defect 3: verify the installed build matches what we made.
        // Compare the sha256 of the *service user's* installed dist/index.js
        // against the hash of the artifact we just built. Fail closed.
        const verifyScript =
          `ROOT="\${HOME}/.openclaw/extensions/opencode-fleet/dist/index.js"; ` +
          `if [ -f "$ROOT" ]; then sha256sum "$ROOT" | awk '{print $1}'; else echo MISSING; fi`;
        // Non-login shell again: banner text on stdout would be misparsed as
        // the hash. `sudo -H` provides the service user's HOME.
        const verifyCmd = serviceUser
          ? `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(verifyScript)}`
          : verifyScript;
        const { stdout: verifyOut } = await execFileP(
          "ssh",
          [...sshPrefix(sshHost, SSH_ARGS), verifyCmd],
          { timeout: 60_000 },
        );
        // Take the last non-empty line, not the first token of the whole
        // output: resilient even if a node prepends anything to stdout.
        const hashCandidates = verifyOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const lastLine = hashCandidates[hashCandidates.length - 1] ?? "";
        const installedHash = /^[0-9a-f]{64}$/i.test(lastLine.split(/\s+/)[0])
          ? lastLine.split(/\s+/)[0]
          : lastLine.includes("MISSING")
            ? "MISSING"
            : "";
        if (installedHash === "MISSING" || !installedHash) {
          anyNodeFailed = true;
          add(`verify-${host}`, false, "installed build not found in the target principal's plugin root");
        } else if (installedHash !== builtHash) {
          anyNodeFailed = true;
          add(
            `verify-${host}`,
            false,
            `installed build hash ${installedHash.slice(0, 12)} != built ${builtHash.slice(0, 12)} — node is running stale code`,
          );
        } else {
          add(`verify-${host}`, true, `hash matches built artifact (${installedHash.slice(0, 12)})`);
        }
      } catch (e) {
        anyNodeFailed = true;
        add(`install-${host}`, false, (e as Error).message);
      }
    }

    // 5. Restart node services.
    if (req.restartNodes) {
      for (const host of req.nodes) {
        const loginUser = req.nodeLoginUsers?.[host];
        const serviceUser = req.nodeUsers?.[host];
        const sshHost = loginUser ? `${loginUser}@${host}` : host;
        try {
          // The live node process is a SYSTEM-scope unit running as the
          // service user (verified on dev2/dev3: `systemctl --user` lists no
          // openclaw-node unit). Restart the system unit; the login principal
          // (root) may need sudo. Do NOT use `systemctl --user` here — it
          // targets a unit that does not exist and silently does nothing.
          const restartCmd = `sudo -n systemctl restart openclaw-node.service`;
          await execFileP("ssh", [...sshPrefix(sshHost, SSH_ARGS), restartCmd], {
            timeout: 60_000,
          });
          // Confirm the unit actually came back, rather than trusting the
          // restart command's exit code (it can succeed while the service
          // fails to start). Fail the step otherwise.
          const checkCmd = `systemctl is-active openclaw-node.service`;
          const { stdout: stateOut } = await execFileP("ssh", [...sshPrefix(sshHost, SSH_ARGS), checkCmd], {
            timeout: 30_000,
          });
          const state = stateOut.trim().split("\n").pop() ?? "";
          if (state !== "active") {
            anyNodeFailed = true;
            add(`restart-${host}`, false, `unit not active after restart (state=${state || "unknown"})`);
          } else {
            add(`restart-${host}`, true, `openclaw-node.service active${serviceUser ? ` (runs as ${serviceUser})` : ""}`);
          }
        } catch (e) {
          anyNodeFailed = true;
          add(`restart-${host}`, false, (e as Error).message);
        }
      }
    }

    // 6. Post-install self-check (issue #24). "Hash matches" is not "works".
    // Every false-success defect in this repo (#12, #13, #18, #22) would have
    // been caught by this single assertion: a real, trivial dispatch that must
    // echo a token. Run it AFTER restart so it exercises the code the node is
    // actually serving now.
    const selfCheckEnabled = req.selfCheck !== false;
    if (selfCheckEnabled && req.restartNodes) {
      for (const host of req.nodes) {
        const loginUser = req.nodeLoginUsers?.[host];
        const serviceUser = req.nodeUsers?.[host];
        const sshHost = loginUser ? `${loginUser}@${host}` : host;
        // Reuse the service HOME resolved earlier if we still have it; the
        // self-check only needs it to prefer a traversable cwd.
        let serviceHome: string | undefined;
        try {
          const { stdout } = await execFileP(
            "ssh",
            [...sshPrefix(sshHost, SSH_ARGS), `sudo -n -u ${shq(serviceUser ?? "root")} -H bash -c 'printf %s "$HOME"'`],
            { timeout: 30_000 },
          );
          const h = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
          if (h.startsWith("/")) serviceHome = h;
        } catch {
          serviceHome = undefined;
        }
        const r = await runSelfCheck(SSH_ARGS, sshHost, serviceUser, serviceHome);
        if (r.ok) {
          add(`selfcheck-${host}`, true, `dispatch works: token echoed in ${r.cwd}`);
        } else {
          anyNodeFailed = true;
          add(`selfcheck-${host}`, false, r.error ?? "self-check failed");
        }
      }
    }

    // Issue #18 defect 4: aggregate. `ok` is false if ANY node failed. A
    // partial deploy that reports success is worse than a failed one.
    const gatewayOk = steps.filter((s) => s.step === "build" || s.step === "pack" || s.step === "install-gateway").every((s) => s.ok);
    const ok = gatewayOk && !anyNodeFailed;
    return {
      ok,
      steps,
      gatewayRestartRequired: true,
      ...(ok ? { notes: DEPLOY_NOTES } : { error: "one or more deploy steps failed — see steps" }),
    };
  } catch (err) {
    return { ok: false, steps, gatewayRestartRequired: false, error: (err as Error).message };
  }
}
