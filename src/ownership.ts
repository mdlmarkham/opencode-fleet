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

// Same shape the provisioning code accepts for a service user (src/provision.ts), so this does not
// silently narrow an existing config value. The class has no shell metacharacter, which is what makes
// the bare `-user ${svc}` below safe (cwd is the only value that needs shq()).
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const isServiceUserName = (u: unknown): u is string => typeof u === "string" && USER_RE.test(u);

const MARK = "FLEET_OWN";

/**
 * The probe script, to run AS the service user: counts paths not owned by `svc` under `cwd`.
 * Undefined for an unsafe user name. Every way it can fail to measure prints an error marker or
 * nothing at all, never a count of 0 (which would read as a clean checkout).
 */
export function ownershipProbeScript(cwd: string, svc: string): string | undefined {
  if (!isServiceUserName(svc)) return undefined;
  // Worktree excludes .git (pruned); .git is counted separately. `-print` + `wc -l` over a newline-free
  // path is fine for a count; filenames with newlines inflate it by at most one per such name.
  return [
    // An unknown user makes `find -user` fail with its error hidden (a false 0): check it exists first.
    `{ id -u ${svc} >/dev/null 2>&1 || { echo "${MARK}_ERR no-such-user"; exit 0; }; }`,
    `{ cd ${shq(cwd)} 2>/dev/null || { echo "${MARK}_ERR no-such-dir"; exit 0; }; }`,
    // A directory with no .git is not a checkout: an empty `find` there would read as clean.
    `{ [ -e .git ] || { echo "${MARK}_ERR not-a-checkout"; exit 0; }; }`,
    `WT=$(find . -path ./.git -prune -o ! -user ${svc} -print 2>/dev/null | wc -l)`,
    `GT=$(find ./.git ! -user ${svc} 2>/dev/null | wc -l)`,
    `echo "${MARK} wt=$(echo $WT) git=$(echo $GT)"`,
  ].join("; ");
}

/**
 * The full remote command: the probe run AS the service principal (`sudo -n -u`, the same pattern as the
 * cwd and install checks), so a tree under the service user's private home is readable and a failed
 * sudo is an error rather than an undercount.
 */
export function ownershipProbeCommand(cwd: string, svc: string): string | undefined {
  const script = ownershipProbeScript(cwd, svc);
  return script === undefined ? undefined : `sudo -n -u ${shq(svc)} -H bash -c ${shq(script)}`;
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
  if (new RegExp(`${MARK}_ERR no-such-dir`).test(stdout)) return { ok: false, error: `${cwd} does not exist (or the service user cannot enter it), so ownership was not checked` };
  if (new RegExp(`${MARK}_ERR not-a-checkout`).test(stdout)) return { ok: false, error: `${cwd} has no .git: it is not a checkout, so ownership was not checked` };
  const m = new RegExp(`${MARK} wt=(\\d+) git=(\\d+)`).exec(stdout);
  if (!m) return { ok: false, error: "could not read the ownership probe output (is `sudo -n -u <service user>` allowed for the SSH login user on this node?)" };
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
