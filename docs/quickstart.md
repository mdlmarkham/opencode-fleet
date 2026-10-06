# Quickstart: nothing to a working fleet in ~15 minutes

This is one manager (the OpenClaw gateway) and one node (a remote host running
OpenClaw, here `dev2`). You build the plugin tarball, install it on both sides,
name the node in the gateway config, and run one verified, synced change —
including one deliberately failing run so you see what a **failed verification
gate** looks like (and why process exit 0 alone is not success).

Everything here is real: the commands are the ones the plugin's own packaging
uses (see `src/deploy.ts` and `package.json`), and the result shapes are what
the tools actually return. If a command errors, check `docs/operators.md` — its
troubleshooting table is keyed by the error strings the code emits.

## 0. Know the model (30 seconds)

- The **manager** (gateway + this plugin) holds GitHub credentials and dispatches work.
- **Nodes** (dev2, dev3, …) run the same plugin; they execute the work. They never
  receive GitHub credentials — repos arrive as git bundles, changes go back through
  the manager (`fleet_sync`).
- You drive the fleet through the fleet_* tools from a session on the gateway.

## 1. Prerequisites — checked when you need them

- **Manager host:** Node >= 20/npm, git, and the OpenClaw gateway installed (`openclaw` on PATH).
- **Node host:** OpenClaw installed, **OpenCode installed and authenticated on the
  node itself** — model credentials live on the node where the work runs, never on
  GitHub or the manager. Verify before dispatching (on the node):
  `opencode --version` prints a version and a trivial `opencode run "say ok"` completes.
  Also git (>= 2.30) on the node. Node >= 22.22.3 (see `engines` in `package.json`).
- **A repo the manager can clone** (you clone it in step 4), and a checkout path
  the node can enter (see the cwd note in step 4).

## 2. Build the tarball (manager)

```bash
cd /path/to/opencode-fleet
npm run plugin:build
```

Expected output (the tsc step prints nothing on success):

```
> tsc -p tsconfig.json
[openclaw] Wrote plugin manifest …          # metadata generation; a short notice is fine
```

(If the CLI step reports a metadata error, run `npm run plugin:validate` — it
runs the same build plus validation and points at the offending tool schema.)

Then pack:

```bash
npm pack
```

Expected output:

```
npm notice
npm notice 📦  openclaw-plugin-opencode-fleet@0.1.0
npm notice Tarball details …
npm notice total files: 27
openclaw-plugin-opencode-fleet-0.1.0.tgz
```

Note the `.tgz` filename for the next step.

## 3. Install it on the manager and each node

The plugin is a private package, so you install from the tarball path. `--force`
allows overwriting an existing install (source is not ClawHub); `--accept-capabilities`
accepts the plugin's declared tool capabilities without prompting — both flags are
what `fleet_deploy` itself passes (`src/deploy.ts:113`), so use them here too.

**Manager (gateway host):**

```bash
openclaw plugins install ./openclaw-plugin-opencode-fleet-0.1.0.tgz --force --accept-capabilities
```

**Each node** (copy the tarball over first — the gateway needs SSH access to
nodes for provisioning and sync; set that up now if you haven't):

```bash
scp openclaw-plugin-opencode-fleet-0.1.0.tgz dev2:/tmp/
ssh dev2 -- openclaw plugins install /tmp/openclaw-plugin-opencode-fleet-0.1.0.tgz --force --accept-capabilities
```

Expected output on each side:

```
Installed plugin opencode-fleet@0.1.0 into ~/.openclaw/extensions/opencode-fleet
```

(Exact wording varies by OpenClaw version; the plugin id and version are what matters.)

Enable the plugin in the **gateway's** `openclaw.json`, and allow the node command:

```json
{
  "plugins": { "entries": { "opencode-fleet": { "enabled": true } } },
  "gateway": { "nodes": { "commands": { "allow": ["opencode.run"] } } }
}
```

`opencode.run` is the one node host command this plugin declares (it is how tasks
reach the node's shell); without it in `gateway.nodes.commands.allow` the node
refuses every dispatch.

Restart the gateway **from outside an agent session** (a plain
`openclaw plugins reload` of the active plugin has been seen to hang; see
`docs/DEPLOY.md`). Sessions started before the restart keep their old tool list —
start a fresh session afterwards.

## 4. Minimal gateway config: name your node

Still in the gateway's `openclaw.json`, add the plugin config under
`plugins.entries.opencode-fleet.config`:

```json
{
  "nodes": {
    "dev2": { "roles": ["worker"], "ssh": true }
  }
}
```

- The `nodes` map is **explicit fleet membership** — a node not listed here or
  matching `nodePrefixes` is not a fleet member (`src/membership.ts`).
- `nodes[].user` (SSH login user) and `nodes[].serviceUser` (the principal the
  node's OpenClaw service runs as) are optional; set `serviceUser` when the
  service runs as a different, non-root user so installs and cwd checks target
  that principal's plugin root.
- The node's `cwd` confinement on dispatch is its `FLEET_ALLOWED_ROOTS`
  (default: `<serviceHome>/fleet` and the service home itself). Keep your
  provisioned repos under the service user's `fleet/` directory, e.g.
  `/home/svcuser/fleet/your-repo` — see `src/guard.ts` `allowedRoots()`.

Restart the gateway again to pick up the plugin config.

## 5. See the node listed — `fleet_status`

From a session on the gateway:

```text
fleet_status
```

Expected shape (one node, connected):

```json
[
  {
    "node": "dev2",
    "id": "dev2-<hash>",
    "connected": true,
    "platform": "linux",
    "commands": ["opencode.run"],
    "invocable": ["opencode.run"]
  }
]
```

`connected: true` is what matters. If the node is listed but not connected, the
node service is down or the gateway allow-list above is missing. `opencode.run`
must appear in `invocable` — that is the permission boundary saying this session
may reach it.

## 6. Provision a repo — `fleet_provision`

```text
fleet_provision({
  repo: "git@github.com:your-org/your-repo.git",
  cwd: "/home/svcuser/fleet/your-repo",
  nodes: ["dev2"]
})
```

What happens: the manager clones with its own credentials, ships a **git bundle**
over SSH, and the node unpacks it into `cwd` — the node stays credential-free
(`src/provision.ts` `provisionToNode`). Expected result:

```json
{
  "ok": true,
  "cwd": "/home/svcuser/fleet/your-repo",
  "branch": "main",
  "commit": "<40-hex sha of the checked-out commit>",
  "stableOrigin": "git@github.com:your-org/your-repo.git"
}
```

Prerequisites, right here: the node's service user must be able to **create and
enter** `cwd` (it sits under the service home or `FLEET_ALLOWED_ROOTS`, and the
path must be writable by that principal — provisioning chowns the checkout to the
service user as its last step), and the manager needs a working SSH path to the
node (a login user, not necessarily root; see `docs/operators.md`). A private
checkout location the service user cannot traverse is refused with
`refusing to dispatch: cwd … is not traversable by the worker principal`.

Note `commit`: the run you dispatch next works against this exact commit. With
`isolation: "clone"` (recommended, step 7 of `docs/operators.md`) only **committed**
state is cloned — keep the checkout clean.

## 7. Dispatch one task — `fleet_dispatch`

```text
fleet_dispatch({
  cwd: "/home/svcuser/fleet/your-repo",
  spec: {
    goal: "Document the public API",
    acceptance: ["docs/api.md exists and lists every exported symbol"],
    verify: { files: ["docs/api.md"], command: "test -s docs/api.md" }
  }
})
```

A structured `spec` renders into the engine prompt (goal first line, acceptance
criteria as a bullet list — `src/spec.ts` `renderSpec`) and `spec.verify` maps
onto the post-run verification gate: every listed file must exist relative to the
run cwd, and the command must exit 0. **The gate is the only thing that tells a
worker that "exited 0 but produced nothing" from a real success.**

`fleet_dispatch` runs **detached by default** (`async: true`): the result is a run
handle, not the final output:

```json
{
  "runId": "fleet-<node>-<epoch>",
  "detached": true,
  "ok": true,
  "pid": 12345
}
```

Prerequisite check at this point (why: `expect.command` runs on the node
**outside** the engine's permission system): a `verify.command` must be a
repo-relative script path with plain arguments (must contain a `/`) unless the
operator set `allowSetupCommands: true`. `test -s docs/api.md` is refused in the
default posture — the accepted forms are things like `./scripts/check.sh` or
`scripts/build.sh --fast`. In this quickstart either (a) add
`scripts/check.sh` to your repo and verify with `command: "./scripts/check.sh"`,
or (b) verify by file existence only (`files: ["docs/api.md"]`, no `command`).
Arbitrary shell (`npm test && echo ok`) and bare names are refused by design.
If you control the fleet and accept the trade-off, set `allowSetupCommands: true`
in the plugin config and `test -s …` works.

## 8. Read the run report — `fleet_run_status` and `fleet_run_report`

Wait for the run (one blocking call; do not poll in a loop):

```text
fleet_await({ runIds: ["fleet-dev2-<epoch>"] })
```

Expected shape (success — note the three separate signals):

```json
{
  "allTerminal": true,
  "timedOut": false,
  "runs": {
    "fleet-dev2-<epoch>": {
      "runId": "fleet-dev2-<epoch>",
      "terminal": true,
      "state": "completed",
      "exitCode": 0,
      "verified": true
    }
  }
}
```

`exitCode` is the process status, `state` is the ledger's reconciliation
(`completed` / `failed` / `failed-verification`), `verified` is the gate's verdict
(`null` = no gate was configured). **Trust `verified`, not `exitCode`.**

The audit manifest (what the worker actually did — files changed, diff stat,
commands, usage):

```text
fleet_run_report({ node: "dev2", runId: "fleet-dev2-<epoch>" })
```

Expected (abridged; secrets redacted, uncaptured fields are `null` — never an
implied empty list):

```json
{
  "ok": true,
  "runId": "fleet-dev2-<epoch>",
  "manifest": {
    "startCommit": "<40-hex>",
    "filesChanged": ["docs/api.md"],
    "diffStat": " docs/api.md | 42 ++++++",
    "commands": [{ "command": "…", "exitCode": 0 }],
    "usage": { "tokens": 15230 },
    "verified": true
  }
}
```

`commandsRecorded: false` is normal with the Pi engine without JSON mode; with
OpenCode it records what the engine ran.

## 9. Do it wrong on purpose: a FAILING verify gate

Dispatch again, expecting an artifact that won't be produced:

```text
fleet_dispatch({
  cwd: "/home/svcuser/fleet/your-repo",
  spec: {
    goal: "Document the public API",
    acceptance: ["docs/api.md exists"],
    verify: { files: ["docs/api.mdx"] }
  }
})
```

Then:

```text
fleet_await({ runIds: ["<runId>"] })
```

Expected — this is the important part:

```json
{
  "allTerminal": true,
  "runs": {
    "<runId>": {
      "runId": "<runId>",
      "terminal": true,
      "state": "failed-verification",
      "exitCode": 0,
      "verified": false
    }
  }
}
```

Read it carefully:

- `ok`/`exitCode` say **0** — the worker process exited cleanly.
- `state: "failed-verification"` and `verified: false` say the run is **not a
  success**: the gate (the node, after the worker exits) could not satisfy the
  expectation, so the run was reclassified. `fleet_run_status` adds
  `verifiedNote: "VERIFICATION GATE FAILED …"`, and `fleet_run_report` shows it too.
- Process exit 0 alone is never your success signal. The verify gate exists so an
  unattended run that produced nothing cannot be laundered into a green checkmark.

A gateless dispatch (no `expect`/`spec.verify`) reports
`verification: { gate: "none" }` by default (`project.gate: advise`) exactly
because the exit code would be the only signal; under `project.gate: "enforce"`
it is refused outright. `fleet_sync` can additionally refuse to publish
unverified work (`sync.requireVerified: true`) — see `docs/operators.md`.

## 10. Sync — `fleet_sync`

```text
fleet_sync({ node: "dev2", cwd: "/home/svcuser/fleet/your-repo", repo: "git@github.com:your-org/your-repo.git" })
```

Expected (abridged):

```json
{
  "ok": true,
  "cwd": "/home/svcuser/fleet/your-repo",
  "branch": "fleet/<sync-id>",
  "commit": "pushed",
  "synced": true,
  "redirectedFrom": "main"
}
```

What happens: the node bundles its uncommitted changes (that is why step 9's
failing run stayed unsynced — its tree changed nothing, but a run with a failed
gate would be refused with
`run <runId> failed its verification gate …; refusing to publish unverified work`).
The manager applies the bundle with its own credentials and pushes.

- **Protected branches are never pushed directly.** `main`/`master` (the
  `sync.protectedBranches` default) are redirected to `fleet/<name>` and the
  result says `redirectedFrom` — open a PR from that branch. You did not need to
  pass a destination; `branch` in the parameters is the **clone base**, not the
  destination.
- Changes touching CI/CODEOWNERS paths, or credential-shaped text in added lines,
  are refused (`policy-refused`) unless `sync.allowSensitivePaths` is set —
  nothing is pushed in that case, and the secret is never echoed.
- Open a PR from `fleet/<…>` to finish the loop.

You are done: a repo provisioned credential-free, one task dispatched and
verified, one failing gate seen and understood, and the verified change published
to a PR-able branch.