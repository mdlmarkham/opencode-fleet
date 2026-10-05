# Operator guide

For the person who installs and configures the plugin. A first run end to end is in
[quickstart.md](quickstart.md); agent-facing guidance is in `skills/opencode-fleet/SKILL.md`.

## Node prerequisites checklist

On every worker node:

- [ ] The OpenClaw node service runs and the node is **paired** with the gateway.
- [ ] `git` is installed.
- [ ] **Node.js >= 22.22.3** (`package.json` `engines`: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`); the plugin's node handler runs on it.
- [ ] **OpenCode is installed and authenticated for model access** on the node (and Pi, if you use `harness: "pi"`). Model credentials live on the worker. **GitHub credentials never do**: the manager does all GitHub I/O.
- [ ] The service user exists (`nodes.<name>.serviceUser`, when it differs from the SSH login user). Provisioning hands each checkout to it and fails if it cannot.
- [ ] The manager can reach the node over **SSH**, or the node is configured `ssh: false` (the node-channel path: provisioning and sync go through chunked `opencode.run` control messages; no SSH-only features such as the ownership report, capability probe over SSH, or worker git identity).
- [ ] Node-side environment (optional): `FLEET_ALLOWED_ROOTS` (directories workers may run in; default the shared fleet root) and `FLEET_STATE_DIR` (run state; default `~/.openclaw/fleet/state` of the service user).
- [ ] On the gateway: `gateway.nodes.commands.allow` contains `opencode.run`.

## Packaging

```bash
npm ci
npm run plugin:build      # npm run build, then `openclaw plugins build --entry ./dist/index.js`
npm run plugin:validate   # build + `openclaw plugins validate`
openclaw plugins install <the built tarball> --force --accept-capabilities
```
`fleet_deploy` does the build, pack, install on the gateway and every node, and restarts the node
services; it returns `gatewayRestartRequired`. **Apply with a gateway restart, not `plugins reload`**
([DEPLOY.md](DEPLOY.md)).

Compatibility: `peerDependencies.openclaw` is `>=2026.5.17`; the dev dependency pins the version the
tests run against. The wire protocol between gateway and node is versioned (`PROTOCOL_VERSION`); a node
below the protocol a feature needs is **refused**, never silently run without it, so upgrade nodes with the
gateway. `package.json` is `private: true` and the plugin id is `opencode-fleet`; publishing and a final
name are open (#45).

## Config reference

Set under `plugins.entries.opencode-fleet.config`. Every key below is checked against
`openclaw.plugin.json` by a test, so this table cannot drift from the manifest.

| Key | Default | What it does |
|---|---|---|
| `nodes` | | Map of node name to `{roles, ssh, platform, tags, user, serviceUser, maxConcurrent}`. `user` is the SSH login (often root); `serviceUser` is the worker principal; `maxConcurrent` is the per-node slot limit. |
| `nodePrefixes` | `[]` | Fallback: node display-name prefixes treated as fleet members when `nodes` does not list them. |
| `defaultTransport` | `http` | `http` (`opencode run`, detached) or `acp`. |
| `defaultTimeoutMs` | `1800000` | Wall-clock limit for a dispatched run (30 min). The idle watchdog (`maxIdleMs`, default 120000) is the hung-run guard. |
| `dispatch` | | `{defaultTarget: "all"}` restores fan-out for an unnamed `fleet_dispatch`. Off by default: an unnamed target is refused. |
| `capacity` | | `{maxConcurrentPerNode, staleAfterMs}`: slots per node, counted from the run ledger; a run `running` past `staleAfterMs` (6h) stops holding a slot. |
| `isolation` | `none` | `clone` gives every run its own git clone on `fleet/<runId>`. Recommended. |
| `allowAutoApprove` | `true` | Whether a dispatch may pass `autoApprove` (`opencode run --auto`, approves every non-denied permission). Set `false` to forbid it. |
| `allowSetupCommands` | `false` | Whether `setup` / `expect.command` may be arbitrary shell instead of a repo-relative script path. |
| `env` | | `{allowOnly, extraDeny}` refines the dispatch env policy; built-in denials (`BASH_ENV`, `NODE_OPTIONS`, `LD_*`, ...) always apply. |
| `project` | | Design gate and project record: `gate` (`off` / `advise` default / `enforce`), `maxScopePatterns`, `maxAcceptanceItems`, `roots`, `rules`, `requireCharterFields`, `allowRepoBlocking`. |
| `s1` | off | S1 decision layer (shadow-first): `backend`, `mode`, `timeoutMs`, `thresholds`, `calibration`, `backends`. |
| `sync` | | `fleet_sync` policy: `protectedBranches` (`main`, `master`), `allowDirectPush`, `blockOnScopeViolation`, `requireReview`, `requireReviewSource`, `requireVerified`, `allowSensitivePaths`, `sensitivePaths`. |
| `workerGitIdentity` | off | `{name, email}`: a distinct git identity written into each provisioned checkout's local config. |
| `ssh` | | `{strictHostKeyChecking: "accept-new" (default) \| "yes"}`; use `yes` once host keys are pinned. |
| `apertureUrl` | | Model catalog URL (OpenAI-style `/v1/models`); `fleet_models` needs it. |
| `fleetRoot` | derived | Shared workspace root on nodes (default provisioning cwd). |
| `piDefaultModel` | | Pi model ref (`provider/id`) used when a Pi dispatch names none. No built-in default. |

## What is on by default

| Default | Effect | To change |
|---|---|---|
| `allowAutoApprove: true` | A dispatch may run OpenCode with `--auto` (approve every non-denied permission). | `false` |
| S1 off / shadow | No model-based gating unless `s1` is configured; shadow records, never acts. | `s1.mode` |
| No deny baseline | Workers run with whatever permissions the node's OpenCode has, unless `fleet_provision_config { installDenyBaseline }` was run. | install the baseline |
| `isolation: none` | Concurrent runs share a checkout. | `isolation: clone` |
| `project.gate: advise` | A spec's design objections are reported, not enforced; an ungated dispatch is flagged. | `enforce` |
| `sync.*` all off | `fleet_sync` publishes without requiring a gate result, scope check or review (protected branches are still redirected). | the `sync` keys below |

## Recommended profile for unattended runs

```json
{
  "isolation": "clone",
  "allowAutoApprove": false,
  "capacity": { "maxConcurrentPerNode": 2 },
  "project": { "gate": "enforce" },
  "sync": { "requireVerified": true, "blockOnScopeViolation": true, "requireReview": true },
  "ssh": { "strictHostKeyChecking": "yes" }
}
```
Also install the deny-rule baseline on each node (`fleet_provision_config { installDenyBaseline: true }`),
set each node's `serviceUser`, and consider `workerGitIdentity: {}` so worker commits are recognisable.
Each choice buys something specific: `clone` stops runs clobbering each other; `enforce` refuses a
dispatch with no verify gate; `requireVerified` and `blockOnScopeViolation` stop unverified or
out-of-scope work being published; `requireReview` (with `requireReviewSource: "spawned"` for a
plugin-collected review) requires a PASS for the exact head.

## Troubleshooting

Keyed by what the code actually says.

| You see | Meaning | Do |
|---|---|---|
| `no target node given. Name one with node: ...` | Unnamed target in a multi-node fleet. | `nodes: [...]`, `nodes: "all"` or `pick: "any"` (or `dispatch.defaultTarget: "all"`). |
| `reason: "no-capacity"` (`retryable: true`) | The node is at its slot limit (or `pick: "any"` found none free). | Wait (`fleet_await`) and retry; check `fleet_capacity` for stale runs. |
| `launch failed: ...` (ledger summary) | The node refused or never acknowledged the launch. | Read the message; `fleet_run_status`; do not re-dispatch a run that is live. |
| `commit: "policy-refused"` (`fleet_sync`) | The change touches CI/CODEOWNERS paths or adds credential-shaped lines. | Do not work around it; ask the operator. |
| `commit: "head-mismatch"` | With `sync.requireReview`, the bundle's tip is not the reviewed head. | Re-review the new head. |
| `commit: "detection-failed"` | The worker branch is absent from the bundle, or the tree could not be measured. | Check the run's branch and `fleet_diff`. |
| `sync.requireVerified is set ...` / `sync.blockOnScopeViolation is set ...` | The sync policy blocked the publish. | Fix the run; `allowUnverified` / `allowScopeViolations` only deliberately. |
| `node speaks protocol N (< M) and cannot honor ...; upgrade opencode-fleet on the node first` | The node is older than the feature needs. | `fleet_deploy` / reinstall on the node. |
| exit **66** `FLEET_ERROR: cannot enter cwd ...` | The worker user cannot enter the cwd. | Provision into a path under the shared fleet root; check ownership. |
| exit **67** `this node's pi does not support --tools/--offline` | A requested Pi restriction is unsupported; refused rather than run unrestricted. | Update Pi, or drop the restriction. |
| exit **68** `FLEET_ERROR: ... not owned by the worker user` | Provisioning could not hand the checkout to the service user. | Check `serviceUser` and the node's sudo/root access. |
| exit **124** / `timed out at the wall-clock limit` | The run hit `timeoutMs`. `endedBy: "wall-clock"`. | Raise `timeoutMs`; for `fleet_watch` pass one explicitly. |
| `killed by watchdog: [stuck: ...]` | No output for `maxIdleMs`. `endedBy: "idle-watchdog"`. | Look at the run's output; raise `maxIdleMs` if legitimate. |
| `dubious ownership` | Root-side git on a worker-owned checkout. | See [STAGING.md](STAGING.md). |
| A tool the notes mention is "unknown" in a long-lived session | The session predates a plugin update. | Start a new session ([DEPLOY.md](DEPLOY.md)). |
