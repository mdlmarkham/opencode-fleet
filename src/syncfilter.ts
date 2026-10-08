/**
 * fleet_sync untracked-path staging filter (issue #331).
 *
 * `fleet_sync` auto-commits a worker's working-tree changes before syncing:
 * `git add -A` stages EVERYTHING, including the plugin's own runtime state
 * (`.opencode-fleet/` — shadow logs, decision records), which then rides the
 * sync into the worker branch (issue #331: a runtime log nearly shipped to
 * master). This filter is defence in depth for every auto-commit path: given
 * the staged path list, it keeps everything EXCEPT paths under the runtime
 * dir, so a path under `.opencode-fleet/` can never be staged.
 *
 * Pure: string in, strings out. The worker-side bundle op (`src/node/handler.ts`)
 * and the manager-side SSH path (`src/provision.ts`) both generate their
 * `git add -A` staging line from `syncAddCommand`, so the filter is testable
 * in isolation and both paths share one implementation.
 */

/** The plugin runtime directory, relative to a checkout root. Its contents are never tracked. */
export const RUNTIME_DIR = ".opencode-fleet";

/** True when `path` (a repo-relative path as `git status --porcelain` reports it) is under the plugin runtime dir. */
export function isRuntimePath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\/|^\/+/, "");
  return p === RUNTIME_DIR || p.startsWith(`${RUNTIME_DIR}/`);
}

/**
 * Filter an untracked/staged path list down to what may be auto-committed:
 * keeps every normal path, drops (never re-adds) anything under the runtime
 * dir. The kept entries are exactly the paths `git add -A` would have staged.
 */
export function filterSyncPaths(paths: string[]): string[] {
  return paths.filter((p) => !isRuntimePath(p));
}

/**
 * The shell line the sync path uses to stage the worker's changes: identical
 * to the old bare `git add -A` for every non-runtime path, but runtime-dir
 * entries only ever DE-SELECT the pathspec — they can never ADD a file:
 *
 *   git add -A -- ':(exclude).opencode-fleet/' ...
 *
 * Magic pathspecs are ignored by old git (<2.0); every supported engine
 * carries a modern git, so exclusion can never silently become inclusion.
 */
export function syncAddCommand(): string {
  return `git add -A -- ':(exclude)${RUNTIME_DIR}'`;
}