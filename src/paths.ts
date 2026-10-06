/**
 * Node-side private state directory (issue #32).
 *
 * Run scripts, logs, state and completion records used to live in the shared
 * `os.tmpdir()` under predictable names. The `.sh` file is executed with bash,
 * so any local user who could pre-create or symlink those paths could run code
 * as the service user. Everything now lives in a per-user directory that is
 * `0700` and owned by the current user, with IDs validated before they become
 * path segments.
 */

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ID_RE, getDefaultNodeEnvConfig, type NodeEnvConfig } from "./guard.js";

/**
 * Node private state directory. Precedence (issue #103 group c): an explicit
 * `FLEET_STATE_DIR` env value first, then the plugin config's `stateDir`
 * (captured via setNodeEnvConfig when not passed here), then the default under
 * the service user's home. Behavior is unchanged when neither is set.
 */
export function fleetStateDir(
  env: Record<string, string | undefined> = process.env,
  config?: NodeEnvConfig,
): string {
  const fromEnv = env.FLEET_STATE_DIR?.trim();
  const fromConfig = (config ?? getDefaultNodeEnvConfig())?.stateDir?.trim();
  return fromEnv || fromConfig || join(homedir(), ".openclaw", "fleet", "state");
}

/**
 * Create (if needed) and verify the state directory: a real directory (not a
 * symlink), owned by the current user, with no group/other access.
 */
export function ensureStateDir(dir: string = fleetStateDir(process.env, getDefaultNodeEnvConfig())): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`fleet state dir ${dir} is not a plain directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`fleet state dir ${dir} is not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

function seg(kind: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`invalid ${kind}: ${JSON.stringify(id)}`);
  return id;
}

export interface RunPaths {
  state: string;
  script: string;
  log: string;
  done: string;
  /** Raw git capture taken when the run finishes (issue #42): end HEAD, name-status, stat. */
  changes: string;
  /** Audit manifest, composed once the run has finished (issue #42). */
  manifest: string;
}

/** All per-run file paths, inside the private state dir. Throws on an unsafe id. */
export function runPaths(runId: string, dir: string = ensureStateDir()): RunPaths {
  const id = seg("runId", runId);
  return {
    state: join(dir, `run-${id}.json`),
    script: join(dir, `run-${id}.sh`),
    log: join(dir, `run-${id}.log`),
    done: join(dir, `done-${id}.json`),
    changes: join(dir, `run-${id}.changes`),
    manifest: join(dir, `manifest-${id}.json`),
  };
}

/** Per-transfer staging directory and assembled bundle path. */
export function xferPaths(transferId: string, dir: string = ensureStateDir()): { dir: string; bundle: string } {
  const id = seg("transferId", transferId);
  return { dir: join(dir, `xfer-${id}`), bundle: join(dir, `xfer-${id}.bundle`) };
}

/**
 * Issue #63: per-run PRIVATE staging for the SSH provisioning/sync path.
 * The manager ships/creates node-side git bundles over ssh and used to park
 * them in PUBLIC /tmp under predictable names. This gives the same layout as
 * the channel path (same `xfer-<id>` naming under the same per-user private
 * state dir), but the bundle lives INSIDE the per-run dir so cleanup removes
 * exactly one run's directory and cannot touch other runs' (or other users')
 * files. provision.ts mirrors this layout in the node-side shell command
 * (remoteStageDirCmd); ids are validated like transferIds.
 */
export function stagePaths(id: string, dir: string = fleetStateDir(process.env, getDefaultNodeEnvConfig())): { dir: string; bundle: string } {
  const safe = seg("transferId", id);
  const staging = join(dir, `xfer-${safe}`);
  return { dir: staging, bundle: join(staging, "bundle") };
}

/** Write a file privately and atomically (temp + rename within the private dir). */
export async function writePrivate(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode, flag: "w" });
  await rename(tmp, path);
}
