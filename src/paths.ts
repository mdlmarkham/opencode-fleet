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
import { ID_RE } from "./guard.js";

/** Override with FLEET_STATE_DIR on the node; default is under the service user's home. */
export function fleetStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.FLEET_STATE_DIR?.trim() || join(homedir(), ".openclaw", "fleet", "state");
}

/**
 * Create (if needed) and verify the state directory: a real directory (not a
 * symlink), owned by the current user, with no group/other access.
 */
export function ensureStateDir(dir: string = fleetStateDir()): string {
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
}

/** All per-run file paths, inside the private state dir. Throws on an unsafe id. */
export function runPaths(runId: string, dir: string = ensureStateDir()): RunPaths {
  const id = seg("runId", runId);
  return {
    state: join(dir, `run-${id}.json`),
    script: join(dir, `run-${id}.sh`),
    log: join(dir, `run-${id}.log`),
    done: join(dir, `done-${id}.json`),
  };
}

/** Per-transfer staging directory and assembled bundle path. */
export function xferPaths(transferId: string, dir: string = ensureStateDir()): { dir: string; bundle: string } {
  const id = seg("transferId", transferId);
  return { dir: join(dir, `xfer-${id}`), bundle: join(dir, `xfer-${id}.bundle`) };
}

/** Write a file privately and atomically (temp + rename within the private dir). */
export async function writePrivate(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode, flag: "w" });
  await rename(tmp, path);
}
