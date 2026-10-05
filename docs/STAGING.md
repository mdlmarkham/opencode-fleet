# Staging node checkouts without poisoning them (issue #189)

The manager stages node checkouts over SSH, often as root. Every file git materializes then
becomes **root-owned**, and the credential-free service-user worker (`svcuser`) cannot write
`docs/`, cannot `git add` (root-owned object fan-out dirs), and root-side git then refuses the
svcuser-owned repo ("detected dubious ownership"). The plugin's own provisioning already hands the
checkout back to the worker (`chown -R` as its last step, issue #71); this runbook is for the
**manual** staging and repair a supervisor does around it.

## Procedure

1. Root may run credentialed `git fetch` / `reset` / `clean` on a node checkout. **Run
   `chown -R <svcuser>:<svcuser> <checkout>` as the LAST operation.** Any repair command that runs
   after it (another fetch, a `git gc`, a `git config`) re-poisons ownership, so the chown goes last.
2. One-time per node, so root-side git works on the svcuser-owned repo:
   `git config --global --add safe.directory <checkout>` (as root).
3. Harvest worker commits with a **bundle created by the service user**
   (`su <svcuser> -c 'git bundle create ...'`, which is what `fleet_sync` does), never a root-side
   fetch of the worker's repo.

## Check it

`fleet_cleanup { nodes: [...], cwd: "<checkout>" }` returns, per node, an `ownership` report: how
many worktree and `.git` paths are not owned by the node's service user, with a warning and the
exact `chown` to run. It is **report-only**: the fix is a privileged `chown -R`, which stays an
operator step.

- It needs the node's **`serviceUser`** in the `nodes` config. The login `user` is deliberately
  not used as a fallback: it is the SSH login (often root), not the worker, and measuring against it
  can read a poisoned checkout as clean or propose a `chown` back to root.
- The probe runs **as the service user** (`sudo -n -u <serviceUser>`), the same pattern as the cwd
  and install checks, so a tree under the service user's private home is fully readable. If
  `sudo -n` is not allowed for the login user, the report says it could not read the probe.
- It runs **before** the `git gc` in the same call, and that `gc` now runs as the service user too
  (it used to run as the login user and left root-owned files in `.git`).
- A missing directory, a directory with no `.git`, an unknown service user, or unparseable output
  is an **error**, never a clean checkout.

## Worker git identity (opt-in)

Set `workerGitIdentity` in the plugin config (`{}` for the defaults, or `{name, email}`) and
`fleet_provision` writes a git identity into each provisioned checkout's **local** config, so
commits the worker makes are distinguishable from a person's in review. Defaults: name
`fleet-worker`, email `fleet-worker@<node>.invalid` (the `.invalid` TLD cannot be a real address).

- Each of `user.name` / `user.email` is set **only when the checkout does not already have it**:
  a repo's own configured identity is never overwritten. Global and system git config are never
  touched.
- It is applied before the ownership hand-over, so the config file is worker-owned afterwards.
- Values are validated before they reach a shell.
- SSH-provisioned nodes only: a node provisioned over the node channel (no SSH) is not changed.

## `safe.directory`

`fleet_provision` already sets `safe.directory` for the checkout at `--system` scope when it
provisions (issue #14), so the one-time manual step in item 2 above is only needed for a checkout
that was staged by hand.

## Not done

- An ownership warning at dispatch time. The dispatch cwd check already proves the worker can enter
  the checkout; a full ownership scan on every dispatch would add an ssh round trip each time, so it
  stays a `fleet_cleanup` report.
