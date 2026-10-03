/**
 * Dispatch-time cwd validation (issue #26).
 *
 * The worker runs as the node's service principal (e.g. `svcuser`), but
 * callers commonly name a `cwd` under `/root` — which is mode `0700`, so the
 * worker cannot traverse it. Before #22/PR #23 this failed *silently* (a run
 * that did nothing reported success). After PR #23 it fails *loudly* (cd exits
 * 66) — but the caller still only learns that after dispatch, and the fleet's
 * own provisioning default made the unusable path the easy one to pick.
 *
 * This module closes the remaining contract gap: validate the cwd AS THE WORKER
 * PRINCIPAL at dispatch time and refuse with an actionable error.
 *
 * Two pieces:
 *  1. `resolveFleetRoot` / `defaultFleetCwd` — a workspace root both principals
 *     agree on, so provisioning and dispatch stop disagreeing (#26 item 1).
 *  2. `cwdGuardScript` / `evaluateCwdCheck` — run `test -x` as the worker and
 *     report a hard, legible refusal (#26 item 3).
 */

/** Directory name of the shared workspace under a service user's home. */
export const FLEET_DIRNAME = "fleet";

/**
 * The shared fleet workspace root (traversable+writable by the service
 * principal). Nothing is assumed about the deployment: an explicit
 * `fleetRoot` wins; otherwise `/home/<serviceUser>/fleet` when every target
 * node names the SAME service user; otherwise undefined and the caller must
 * pass a `cwd` or configure `fleetRoot`.
 */
export function resolveFleetRoot(
  cfg: { fleetRoot?: string },
  serviceUsers: Array<string | undefined> = [],
): string | undefined {
  if (cfg.fleetRoot?.trim()) return cfg.fleetRoot.trim();
  const users = new Set(serviceUsers);
  const only = users.size === 1 ? [...users][0] : undefined;
  return only && only !== "root" ? `/home/${only}/${FLEET_DIRNAME}` : undefined;
}

/** Quote a string for safe use as a single POSIX shell argument. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The default cwd for a repo when the caller does not name one.
 *
 * Issue #26: previously the default landed under /root (e.g. /root/ohm-fleet/ohm)
 * which the worker principal cannot enter. We now land under the fleet root,
 * which it can.
 *
 * @param repo short repo name (e.g. "ohm") or a path-ish string; sanitized.
 */
export function defaultFleetCwd(repo: string, root: string): string {
  const name = repo
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop() ?? "repo";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${root.replace(/\/+$/, "")}/${safe}`;
}

/**
 * Whether a cwd path is *plausibly* usable by a non-root service principal,
 * from the path alone (no IO). This is a fast pre-check that catches the common
 * /root case with a good error before spending an SSH round trip; the
 * authoritative check is `cwdGuardScript` run on the node.
 */
export function looksWorkerInaccessible(cwd: string, serviceUser: string | undefined): boolean {
  if (!serviceUser || serviceUser === "root") return false;
  // A non-root principal cannot traverse root's home (mode 0700 by default).
  if (cwd === "/root" || cwd.startsWith("/root/")) return true;
  return false;
}

/**
 * Build a shell snippet that verifies the cwd is enterable AS THE WORKER
 * PRINCIPAL. Prints a sentinel so the caller can distinguish the three
 * outcomes: ok, missing, not-traversable.
 *
 * Runs under the worker principal (caller wraps with sudo -u <serviceUser>).
 */
export function cwdGuardScript(cwd: string): string {
  // `test -x` exercises the traverse bit for each path component, which is
  // exactly what `cd` needs; `-d` distinguishes "exists but is a file".
  return [
    `if [ ! -e ${shq(cwd)} ]; then echo "FLEET_CWD=missing"; exit 0; fi`,
    `if [ ! -d ${shq(cwd)} ]; then echo "FLEET_CWD=notdir"; exit 0; fi`,
    `if [ ! -x ${shq(cwd)} ]; then echo "FLEET_CWD=denied"; exit 0; fi`,
    `echo "FLEET_CWD=ok"`,
  ].join("; ");
}

export interface CwdCheckResult {
  ok: boolean;
  /** ok | missing | notdir | denied | unknown */
  status: string;
  error?: string;
}

/**
 * Evaluate the guard output. Pure, so it is unit testable without a node.
 */
export function evaluateCwdCheck(raw: string, cwd: string, serviceUser?: string): CwdCheckResult {
  const m = raw.match(/FLEET_CWD=(ok|missing|notdir|denied)/);
  const status = m ? m[1] : "unknown";
  if (status === "ok") return { ok: true, status };
  const who = serviceUser ? `the worker principal (${serviceUser})` : "the worker principal";
  const remedy =
    status === "denied"
      ? `it is not traversable by ${who} (a /root path is mode 0700 and cannot be entered by a non-root service user)`
      : status === "missing"
        ? `it does not exist on the node`
        : status === "notdir"
          ? `it is not a directory`
          : `its state could not be determined`;
  return {
    ok: false,
    status,
    error:
      `refusing to dispatch: cwd ${cwd} is unusable — ${remedy}. ` +
      `Provision/dispatch under a workspace both principals share${
        resolveFleetRoot({}, [serviceUser]) ? `, e.g. ${defaultFleetCwd("your-repo", resolveFleetRoot({}, [serviceUser])!)}` : " (the fleet root, under the service user's home)"
      }.`,
  };
}

/**
 * Build the full remote command to check a cwd as the worker principal.
 */
export function cwdCheckCommand(cwd: string, serviceUser: string | undefined): string {
  const script = cwdGuardScript(cwd);
  return serviceUser
    ? `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(script)}`
    : script;
}
