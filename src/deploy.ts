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

const execFileP = promisify(execFile);

export interface DeployRequest {
  /** Plugin repo root (where package.json lives). */
  pluginDir: string;
  /** Node hosts to deploy to (SSH names). */
  nodes: string[];
  /** Whether to restart node services after install. */
  restartNodes?: boolean;
}

export interface DeployResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  gatewayRestartRequired: boolean;
  error?: string;
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

    // 4. Copy + install on each node.
    for (const host of req.nodes) {
      try {
        await execFileP("scp", [...SSH_ARGS, tarball, `${host}:/tmp/`], {
          timeout: 120_000,
        });
        await execFileP(
          "ssh",
          [
            ...SSH_ARGS,
            host,
            `cd /tmp && openclaw plugins install ${tarball.split("/").pop()} --force --accept-capabilities 2>&1 | tail -2`,
          ],
          { timeout: 120_000 },
        );
        add(`install-${host}`, true);
      } catch (e) {
        add(`install-${host}`, false, (e as Error).message);
      }
    }

    // 5. Restart node services.
    if (req.restartNodes) {
      for (const host of req.nodes) {
        try {
          await execFileP(
            "ssh",
            [...SSH_ARGS, host, "systemctl --user restart openclaw-node.service"],
            { timeout: 60_000 },
          );
          add(`restart-${host}`, true);
        } catch (e) {
          add(`restart-${host}`, false, (e as Error).message);
        }
      }
    }

    return { ok: true, steps, gatewayRestartRequired: true };
  } catch (err) {
    return { ok: false, steps, gatewayRestartRequired: false, error: (err as Error).message };
  }
}
