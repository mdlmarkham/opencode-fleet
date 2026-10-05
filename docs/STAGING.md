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

## Not done here

- A distinct worker git identity, so worker-authored commits are distinguishable from the
  supervisor's in review (still open on #189).
