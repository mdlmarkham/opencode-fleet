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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SSH_ARGS } from "./ssh.js";
import {
  inspectRemoteInstallRecord,
  repairRemoteInstallRecord,
  needsRepair,
} from "./install-record.js";

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
}

export interface DeployResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  gatewayRestartRequired: boolean;
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
export async function deployPlugin(req: DeployRequest): Promise<DeployResult> {
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
  const add = (step: string, ok: boolean, detail?: string) => steps.push({ step, ok, detail });

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
              [...SSH_ARGS, sshHost, `sudo -n -u ${shq(serviceUser)} -H bash -c 'printf %s "$HOME"'`],
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

        await execFileP("scp", [...SSH_ARGS, tarball, `${sshHost}:/tmp/`], {
          timeout: 120_000,
        });

        // Issue #18 defect 1: install as the SERVICE principal, not the SSH
        // login user. When the caller names one, install into that user's
        // environment; otherwise fall back to the login user's environment and
        // mark the step unverified (no silent success).
        // Issue #18 defect 2: the formatter pipe is removed. The install's own
        // exit code must gate the step; we capture output and require an
        // explicit success sentinel.
        const installInner =
          `cd /tmp && openclaw plugins install ${shq(tarballName)} --force --accept-capabilities 2>&1; ` +
          `rc=$?; echo "FLEET_INSTALL_RC=$rc"; exit $rc`;
        // Use a NON-login shell (`bash -c`): a login shell (`bash -lc`) sources
        // the user's profile and can print MOTD/banner text on stdout, which
        // would corrupt the rc/hash we parse back. `sudo -H` already sets HOME.
        const installCmd = serviceUser
          ? `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(installInner)}`
          : installInner;
        const { stdout: installOut } = await execFileP(
          "ssh",
          [...SSH_ARGS, sshHost, installCmd],
          { timeout: 120_000 },
        );
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
          [...SSH_ARGS, sshHost, verifyCmd],
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
          await execFileP("ssh", [...SSH_ARGS, sshHost, restartCmd], {
            timeout: 60_000,
          });
          // Confirm the unit actually came back, rather than trusting the
          // restart command's exit code (it can succeed while the service
          // fails to start). Fail the step otherwise.
          const checkCmd = `systemctl is-active openclaw-node.service`;
          const { stdout: stateOut } = await execFileP("ssh", [...SSH_ARGS, sshHost, checkCmd], {
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

    // Issue #18 defect 4: aggregate. `ok` is false if ANY node failed. A
    // partial deploy that reports success is worse than a failed one.
    const gatewayOk = steps.filter((s) => s.step === "build" || s.step === "pack" || s.step === "install-gateway").every((s) => s.ok);
    const ok = gatewayOk && !anyNodeFailed;
    return {
      ok,
      steps,
      gatewayRestartRequired: true,
      ...(ok ? {} : { error: "one or more deploy steps failed — see steps" }),
    };
  } catch (err) {
    return { ok: false, steps, gatewayRestartRequired: false, error: (err as Error).message };
  }
}
