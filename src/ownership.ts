/**
 * Checkout ownership probe (issue #189). The manager stages node checkouts over SSH as root, so
 * every file git materializes becomes root-owned and the credential-free service-user worker
 * cannot write or `git add` in it (and root-side git then refuses the svcuser-owned repo as
 * "dubious ownership"). This reports how many paths in a checkout are NOT owned by the service
 * user, split into worktree and `.git`, so a poisoned checkout is visible before a run fails in it.
 *
 * Read-only and report-only on purpose: fixing it is a privileged `chown -R`, which stays an
 * operator step (docs/STAGING.md) rather than something a cleanup call does silently.
 */

import { shq } from "./shell.js";

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const isServiceUserName = (u: unknown): u is string => typeof u === "string" && USER_RE.test(u);

const MARK = "FLEET_OWN";

/** The shell command that counts paths not owned by `svc` under `cwd`, or undefined for an unsafe user name. */
export function ownershipProbeCommand(cwd: string, svc: string): string | undefined {
  if (!isServiceUserName(svc)) return undefined;
  // Worktree excludes .git (pruned); .git is counted separately. `-print` + `wc -l` over a newline-free
  // path is fine for a count; filenames with newlines inflate it by at most one per such name.
  // An unknown user makes `find -user` fail with its error hidden, which would read as a clean 0:
  // check the user exists first and say so.
  return [
    `{ id -u ${svc} >/dev/null 2>&1 || { echo "${MARK}_ERR no-such-user"; exit 0; }; }`,
    `cd ${shq(cwd)}`,
    `WT=$(find . -path ./.git -prune -o ! -user ${svc} -print 2>/dev/null | wc -l)`,
    `GT=$(find ./.git ! -user ${svc} 2>/dev/null | wc -l)`,
    `echo "${MARK} wt=$(echo $WT) git=$(echo $GT)"`,
  ].join(" && ");
}

export interface OwnershipReport {
  ok: boolean;
  serviceUser: string;
  /** Worktree paths not owned by the service user. */
  worktree: number;
  /** `.git` paths not owned by the service user. */
  git: number;
  warning?: string;
  fix?: string;
}

/** Parse the probe output. Anything unparseable is reported as not ok, never as a clean checkout. */
export function parseOwnership(stdout: string, svc: string, cwd: string): OwnershipReport | { ok: false; error: string } {
  if (new RegExp(`${MARK}_ERR no-such-user`).test(stdout)) return { ok: false, error: `service user ${svc} does not exist on the node, so ownership was not checked` };
  const m = new RegExp(`${MARK} wt=(\\d+) git=(\\d+)`).exec(stdout);
  if (!m) return { ok: false, error: "could not read the ownership probe output" };
  const worktree = Number(m[1]);
  const git = Number(m[2]);
  const clean = worktree === 0 && git === 0;
  return {
    ok: clean,
    serviceUser: svc,
    worktree,
    git,
    ...(clean
      ? {}
      : {
          warning: `${worktree} worktree and ${git} .git path(s) are not owned by ${svc}: the worker may be unable to write or commit in this checkout (usually root-side staging; see docs/STAGING.md)`,
          fix: `as root on the node, as the LAST step after any staging: chown -R ${svc}:${svc} ${shq(cwd)}`,
        }),
  };
}
