/**
 * Node-side input guards (issue #31).
 *
 * The gateway policy only checks that `prompt`/`cwd` are non-empty, so the node
 * handler must not trust what arrives. These helpers validate identifiers that
 * are interpolated into filesystem paths and confine `cwd` to the fleet's
 * workspace roots before anything destructive (`rm -rf`, `git clone`) runs.
 *
 * Pure where possible so they are unit-testable without a node.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FLEET_ROOT } from "./cwd.js";

/** Allowed shape for runId / transferId: safe as a path segment and as a shell word. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type IdCheck = { ok: true; id: string } | { ok: false; error: string };

/** Validate an identifier that is used to build a file path. */
export function validateId(kind: string, value: unknown): IdCheck {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    return { ok: false, error: `invalid ${kind}: must match ${ID_RE}` };
  }
  return { ok: true, id: value };
}

/**
 * Workspace roots the node will operate in. Override with a path-delimited
 * `FLEET_ALLOWED_ROOTS` env var on the node. The default is the shared fleet
 * root plus the service user's home (existing deployments dispatch under it).
 */
export function allowedRoots(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  const raw = env.FLEET_ALLOWED_ROOTS?.trim();
  const roots = raw ? raw.split(/[:;]/).map((s) => s.trim()).filter(Boolean) : [FLEET_ROOT, home];
  return roots.filter((r) => isAbsolute(r)).map((r) => resolve(r));
}

export type CwdCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Confine `cwd` to a strict descendant of an allowed root. The root itself is
 * refused (a destructive op on it would wipe the whole workspace), as is `/`.
 * `resolved` should already have symlinks resolved (see `resolveReal`).
 */
export function checkCwd(cwd: unknown, roots: string[], resolved?: string): CwdCheck {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    return { ok: false, error: "invalid cwd" };
  }
  if (!isAbsolute(cwd)) {
    return { ok: false, error: `cwd must be an absolute path: ${cwd}` };
  }
  const target = resolve(resolved ?? cwd);
  // Refuse a target equal to ANY allowed root. The roots can nest (e.g.
  // FLEET_ROOT=/home/u/fleet is a descendant of home=/home/u), so a plain
  // strict-descendant test would ADMIT the workspace root as a child of home.
  // A destructive op (rm -rf) on a root would wipe the whole workspace.
  for (const root of roots) {
    if (resolve(root) === target) {
      return { ok: false, error: `cwd ${cwd} is a workspace root itself; refusing a destructive op on a root` };
    }
  }
  for (const root of roots) {
    const rel = relative(root, target);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return { ok: true, path: target };
    }
  }
  return {
    ok: false,
    error: `cwd ${cwd} is outside the allowed workspace roots (${roots.join(", ") || "none"}) or is a root itself`,
  };
}

/**
 * Resolve symlinks for `p`, tolerating a path that does not exist yet by
 * resolving its nearest existing ancestor and re-appending the remainder.
 */
export async function resolveReal(p: string): Promise<string> {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
      cur = parent;
    }
  }
}

/** Full cwd validation: shape, symlink resolution, then root confinement. */
export async function guardCwd(
  cwd: unknown,
  roots: string[] = allowedRoots(),
): Promise<CwdCheck> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return checkCwd(cwd, roots);
  const rootsReal = await Promise.all(roots.map((r) => resolveReal(r)));
  return checkCwd(cwd, rootsReal, await resolveReal(cwd));
}

/** Control messages that do not operate on `cwd` (the gateway sends "/" or the run's cwd as filler). */
const CWD_FREE_OPS = new Set([
  "__ABORT__",
  "__DIFF__",
  "__MODELS__",
  "__ACTIVITY__",
  "__RECEIVE__",
  "__RECEIVE_CLEAN__",
  "__SEND_CHUNK__",
  "__RUN_STATUS__",
  "__RUN_RESULT__",
]);

/** Whether the node will actually use `cwd` for this message (and so must confine it). */
export function taskUsesCwd(prompt: string): boolean {
  return !CWD_FREE_OPS.has(prompt);
}

/** Control messages that address a run and therefore require a valid runId. */
const RUN_OPS = new Set(["__RUN_START__", "__RUN_STATUS__", "__RUN_RESULT__"]);

/**
 * Validate runId/transferId; returns an error string or undefined. Absent
 * (undefined/null) ids are allowed except runId on run-addressed messages;
 * an empty string is never valid.
 */
export function validateTaskIds(task: { prompt?: string; runId?: unknown; transferId?: unknown }): string | undefined {
  if (task.prompt && RUN_OPS.has(task.prompt) && (task.runId === undefined || task.runId === null)) {
    return "runId required";
  }
  for (const [kind, v] of [["runId", task.runId], ["transferId", task.transferId]] as const) {
    if (v === undefined || v === null) continue;
    const c = validateId(kind, v);
    if (!c.ok) return c.error;
  }
  return undefined;
}
