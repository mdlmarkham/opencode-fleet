# Quickstart: from nothing to a verified, synced change

One gateway (the **manager**), one worker node. About 15 minutes if the node already runs OpenClaw.

> **How to read the example output.** The JSON below is shaped from the plugin's code and tests, not
> captured from a live run: field names are real, values are illustrative. Prerequisites and the full
> config reference are in [operators.md](operators.md).

## 0. Before you start

- The worker node is paired with the gateway and runs the OpenClaw node service.
- On the node: `git`, Node >= 22.22.3 (the plugin runs there too), and **OpenCode installed and
  authenticated for model access** (model credentials live on the worker; **GitHub credentials never
  do**).
- The manager can reach the node over SSH, or you use the node-channel path (`ssh: false`, see
  operators.md for what it lacks).

## 1. Install the plugin

Build the tarball and install it on the gateway and the node (operators.md, "Packaging"):

```bash
npm ci && npm run plugin:build          # builds dist/ and runs `openclaw plugins build`
openclaw plugins install opencode-fleet.tgz --force --accept-capabilities
```

Enable it in `openclaw.json` and allow the node command:

```json
{
  "plugins": { "entries": { "opencode-fleet": { "enabled": true,
    "config": { "nodes": { "dev2": { "roles": ["worker"], "serviceUser": "svcuser" } } } } } },
  "gateway": { "nodes": { "commands": { "allow": ["opencode.run"] } } }
}
```

Restart the gateway (a restart, not `plugins reload`; see [DEPLOY.md](DEPLOY.md)).

## 2. See the node

```text
fleet_status
```
Expect your node listed as connected. If it is missing, check the pairing and that
`gateway.nodes.commands.allow` contains `opencode.run`.

```text
fleet_capabilities
```
Expect OpenCode (and git) detected on the node, and the isolation levels it can honour.

## 3. Provision a repo (no credentials reach the node)

```text
fleet_provision(repo: "git@github.com:you/your-repo.git", cwd: "/home/svcuser/fleet/your-repo", nodes: ["dev2"])
```
The manager clones with its own credentials and ships a git bundle; the node unpacks it and hands the
checkout to the service user. Expect `{ok: true, commit: "<sha>"}` per node.

## 4. Dispatch a task that is **expected to fail its gate**

Start with a gate that cannot pass, so you see what a failed verification looks like before you rely on
a passing one.

```text
fleet_dispatch(
  nodes: ["dev2"], cwd: "/home/svcuser/fleet/your-repo",
  spec: {
    goal: "Add a file docs/hello.md containing the word hello",
    acceptance: ["docs/hello.md exists"],
    verify: { files: ["docs/this-file-will-not-exist.md"] },
    scope: { files: ["docs/**"] }
  },
  isolation: "clone")
```
A detached dispatch returns at once with a handle:
```json
{ "dev2": { "runId": "run-…", "detached": true, "pid": 4242, "ackPending": false,
            "note": "Worker launched detached … Wait with fleet_await({runIds:[runId]}) …" } }
```
Not told which node? An unnamed target is refused (list of nodes, free slots): name one with
`nodes: ["dev2"]`, or `pick: "any"`.

## 5. Wait, and read `verified`

```text
fleet_await(runIds: ["run-…"])
```
```json
{ "ok": true, "allTerminal": true, "timedOut": false, "pending": [],
  "runs": { "run-…": { "terminal": true, "state": "failed-verification", "exitCode": 0, "verified": false } } }
```
**The worker exited 0 and still `verified` is `false`.** That is the point of the gate: exit status alone
cannot tell a good run from one that did nothing. Read why:
```text
fleet_run_status(node: "dev2", runId: "run-…")     # verifyDetails shows which file was missing
fleet_run_report(node: "dev2", runId: "run-…")     # files changed, commands the worker ran, usage
```

## 6. Dispatch again with a real gate, then sync

```text
fleet_dispatch(nodes: ["dev2"], cwd: "…/your-repo", isolation: "clone",
  spec: { goal: "Add docs/hello.md containing the word hello",
          acceptance: ["docs/hello.md exists and contains hello"],
          verify: { files: ["docs/hello.md"] }, scope: { files: ["docs/**"] } })
fleet_await(runIds: ["run-…"])        # expect state "completed", verified: true
fleet_diff(node: "dev2", cwd: "<the run's runCwd>")
fleet_sync(node: "dev2", cwd: "<the run's runCwd>", repo: "git@github.com:you/your-repo.git")
```
With `isolation: "clone"` the result carries `runCwd` and `branch` (`fleet/<runId>`): pass `runCwd` to
`fleet_sync`. The manager pushes with its own credentials and **never straight to `main`/`master`**: the
work lands on a `fleet/<name>` branch and the result shows `redirectedFrom`. Open the PR from that branch.

## What to do next

- Make the safe behaviour the default for unattended runs: the recommended profile is in
  [operators.md](operators.md#recommended-profile-for-unattended-runs).
- When something fails, look the message up in the troubleshooting table in operators.md.
- Agents should be pointed at `skills/opencode-fleet/SKILL.md`; it installs with the plugin.
