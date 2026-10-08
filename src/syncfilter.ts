/**
 * fleet_sync untracked-path staging filter (issue #331) + empty-staging
 * guard (issue #333).
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
 * staging line from `syncAddCommand()` (with the empty-staging guard from
 * `syncCommitCommand()`), so the filter is testable in isolation and both
 * paths share one implementation; the path predicates (`isRuntimePath` /
 * `filterSyncPaths`) are the tested filter helpers underneath it.
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
 *   git add -A -- ':(exclude).opencode-fleet' ...
 *
 * Magic pathspecs are ignored by old git (<2.0); every supported engine
 * carries a modern git, so exclusion can never silently become inclusion.
 */
export function syncAddCommand(): string {
  return `git add -A -- ':(exclude)${RUNTIME_DIR}'`;
}

/**
 * The auto-commit chain both sync paths run (issue #333): stage via
 * `syncAddCommand()`, then commit ONLY if something is actually staged.
 * With the exclusion pathspec, a tree whose dirt is solely under
 * `.opencode-fleet/` stages nothing — the old `add && commit` chain then
 * failed (`git commit` exits 1, "nothing added to commit but untracked
 * files present") and aborted the whole sync. `git diff --cached --quiet`
 * succeeds (exit 0) exactly when the index matches HEAD, so the commit is
 * skipped instead of failing; the `cd` arm must fail the whole chain, never
 * fall through into the commit.
 *
 * Returns the shell line; commit identity is supplied by the caller.
 */
export function syncCommitCommand(commitLine: string): string {
  return `${syncAddCommand()} && (git diff --cached --quiet || ${commitLine})`;
}
