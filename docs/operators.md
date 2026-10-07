# Operator guide

For the person who owns the fleet: what a node needs before it can join, every
config key the plugin accepts (generated against the manifest so it cannot
drift), the recommended posture for unattended runs, a troubleshooting table
keyed by the error strings the code actually emits, packaging, and the security
posture — what is on by default versus what each opt-in buys.

Prerequisite reading: `docs/quickstart.md` for the first setup, `docs/DEPLOY.md`
for applying new builds, `docs/STAGING.md` for checkout ownership problems.

## Node prerequisites checklist

A node joins the fleet when **all** of these hold. The list is ordered: each
item is checked at the point a fleet operation first needs it.

1. **OpenClaw installed and running on the node**, registered with the gateway.
   `fleet_status` lists it with `connected: true`.
2. **OpenCode installed AND authenticated on the node itself.** Model
   credentials live on the worker, never GitHub and never the manager — the
   manager relays only the task prompt and workspace path, and nodes never hold
   PATs (repos arrive as git bundles). Verify right on the node:
   `opencode --version` prints a version, and a trivial
   `opencode run "say ok"` completes without a credential error. A node that
   cannot reach its model provider will accept dispatches and fail every run.
3. **Node >= 22.22.3** on nodes (and the manager host); the plugin's
   `engines` field is `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`
   (`package.json`). The gateway must also run an OpenClaw version satisfying
   `peerDependencies.openclaw` (>= 2026.5.17) for the plugin API.
4. **git on the node** (bundling, provisioning, sync and the isolation support
   all shell out to git; the `clone` isolation level additionally needs a
   working `git clone` — `fleet_capabilities` probes and reports it as
   `isolationLevels`).
5. **SSH from the manager** — provisioning and sync use `ssh`/`scp` from the
   gateway host to the node unless the node is declared `ssh: false`:
   - Use an **unprivileged login user** (`nodes[].user`), not root; deploy needs
     a narrow sudoers entry for that user (see the example in `README.md`,
     "SSH access"). `fleet_deploy` warns when it manages a node as root.
   - Host keys: the default `ssh.strictHostKeyChecking: "accept-new"` trusts a
     key on first contact and refuses changes. For a production fleet, pin keys
     with `ssh-keyscan` at provision time and set `"yes"` (see `src/ssh.ts`).
   - **What `ssh: false` (the node-channel path) does and does not provide** —
     `src/tools/provision.ts` `fleet_provision`/`fleet_sync` channel fallback,
     `src/provision.ts`:
     - **Provides:** provisioning via the authenticated node channel (chunked,
       checksummed base64 bundle transfer) and sync the same way — the node
       bundles its work, the manager pulls it and pushes with manager
       credentials. Checksums are mandatory: a bundle without a valid sha256 is
       refused, never reassembled on faith.
     - **Does NOT provide:** everything that is SSH-based today — the SSH cwd
       probe before dispatch, `fleet_deploy`'s node-side install/service
       restart/install-record verification (nodes run `ssh: false` cannot be
       deployed to; install/upgrade them by hand), `fleet_activity`'s SSH
       process listing (no channel fallback for it beyond the invoke it already
       carries), and the deploy-time sha256 install check. Worker git identity
       provisioning (`workerGitIdentity`) is SSH-provisioned nodes only. Note
       the asymmetry within provisioning itself: the bundle transfer walks the
       channel, but anything the manager must actively reach out and measure on
       the node still assumes SSH.
6. **The service user.** The node's OpenClaw service should run as an
   unprivileged principal (e.g. `svcuser`), and when the SSH login user differs,
   set `nodes[].serviceUser` so install/verify/cwd checks target **that
   principal's** plugin root and homes. System-scope unit (`openclaw-node.service`);
   restarts use `sudo -n systemctl restart openclaw-node.service`, not `--user`.
   A node that once installed the plugin as root keeps a poisoned install
   record — the repair runbook is in `README.md` ("No stale root-owned install
   record") and the ownership rules in `docs/STAGING.md`.
7. **`FLEET_ALLOWED_ROOTS` / `FLEET_STATE_DIR`** — the two node-side environment
   knobs (`src/guard.ts`, `src/paths.ts`):
   - `FLEET_ALLOWED_ROOTS` — path-delimited (`:`/`;`) list of absolute roots
     every dispatch `cwd` must be a strict descendant of (the root itself is
     refused). Default: the service user's *home* and `<home>/fleet`.
     Set it when checkouts should live somewhere else (a dedicated volume), or
     to narrow a permissive default. A `cwd` outside the roots is refused:
     `cwd <path> is outside the allowed workspace roots (…)` from
     `src/guard.ts` `checkCwd()`.
   - `FLEET_STATE_DIR` — where the node keeps its **private** per-run state
     (run scripts, logs, completion records, transfer staging; mode 0700, owned
     by the service user). Default: `~/.openclaw/fleet/state` relative to the
     service user's home. Redirect it when the home is small or volatile. Run
     scripts live inside this dir specifically so other local users cannot
     pre-create or symlink them (issue #32).

## Bootstrapping a clone

Provisioning installs nothing: `fleet_provision` ships a git bundle and hands
over the checkout (`src/provision.ts`) — it never runs `npm ci` or reads
`package.json`. A fresh clone therefore has no `node_modules`, and the first
npm-based verification gate dies at `tsc: not found` (exit 127). Since PR #328
the gate names this for what it is: an exit 126/127 at the gate reads as
`verified: null` with `endedBy: "gate-unavailable"` and `missing:` naming the
tool that could not start — the work is **unverified, not failed** (see
`src/verify.ts`; the same wording backs `fleet_sync`'s refusal when
`sync.requireVerified` is set).

**The pattern: the repo ships `scripts/bootstrap.sh`.** Commit a small script
that does only what the checkout needs — install deps and build, nothing else —
e.g.:

```sh
#!/bin/sh
set -e
npm ci --ignore-scripts
npm run build
```

and pass it to provisioning as `setup: "scripts/bootstrap.sh"`. Policy allows
this today without `allowSetupCommands`: `checkSetup()` (`src/policy.ts`) accepts
any repo-relative script path with plain arguments; bare commands
(`setup.sh`) and shell metacharacters (`&&`, `|`, `$(...)`) are still refused —
those need the operator's `allowSetupCommands: true`. The gap was discoverability,
not capability.

Always use `npm ci --ignore-scripts` (or the equivalent for your package
manager): a plain `npm ci` runs dependency lifecycle scripts as the **worker
principal** in the clone — arbitrary code from the dependency tree executing
before any gate or review sees it. Auto-installing during provisioning was
rejected on purpose; bootstrap only when a dispatch asks for it.

The script runs as the worker principal inside the clone, so keep it to what
that checkout needs (install, build, generated-code steps).

## Config reference — generated from the manifest

Every top-level property of `configSchema` in `openclaw.plugin.json`, with its
meaning and default. This table is checked against the manifest by
`src/docs-config.test.ts`, so a key added to or removed from the manifest
without editing this section fails the build. Config lives at
`plugins.entries.opencode-fleet.config` in the gateway's `openclaw.json`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `deploy` | `{pluginDir?}` | _(none)_ | Issue #238: where the plugin **repo** checkout (the dir containing `package.json`) lives on this host, when the installed plugin location (`~/.openclaw/extensions/...`) is not the repo. `fleet_deploy` uses it as the default `pluginDir` instead of the derived installed-parent default — without it (or an explicit `pluginDir` param) a deploy from an installed plugin refuses precisely instead of failing with a bare npm ENOENT. |
| `defaultTransport` | `"http" \| "acp"` | `http` | Default OpenCode transport. `http` (`opencode run`) supports per-task `--model`; `acp` (`opencode acp`) is the full-featured path (MCP, AGENTS.md rules) with config-scoped model. |
| `nodePrefixes` | `string[]` | `[]` | Legacy fallback: display-name prefixes treated as fleet members when the `nodes` map is not configured. No prefixes by default — membership is explicit (`src/membership.ts`). |
| `defaultTimeoutMs` | `number` | `1800000` (30 min) | Default wall-clock limit for a dispatched run; the run reports `endedBy: "wall-clock"` when it hits it. The idle watchdog (`maxIdleMs` per dispatch, default 120000) is the primary hung-run guard. |
| `nodes` | `map<string, NodeConfig>` | _(none)_ | Explicit fleet membership. Per-node keys: `roles[]`, `ssh` (bool; `false` → node-channel provisioning/sync, see checklist item 5), `platform`, `tags[]`, `user` (SSH login user), `serviceUser` (principal the node service runs as when different), `maxConcurrent` (int 1–64; per-node slot limit overriding `capacity.maxConcurrentPerNode`, issue #39). |
| `workerGitIdentity` | `{name?, email?}` | _(unset; opt-in)_ | Issue #189: `fleet_provision` sets this git identity in each provisioned checkout's **local** config (only keys the checkout lacks; never global) so worker-authored commits are recognisable. Defaults `fleet-worker` / `fleet-worker@<node>.invalid`. SSH-provisioned nodes only. |
| `dispatch` | `{defaultTarget?: "all", piMinVersion?: string}` | _(defaultTarget unset)_ | Issue #168: without a default, a `fleet_dispatch` that names no target is **refused** with the node list and free slots; fan-out is explicit (`nodes: "all"`), `pick: "any"` picks one free node. `defaultTarget: "all"` restores fleet-wide fan-out for an unnamed target. `piMinVersion` (issue #137, e.g. `"0.73.1"`): a `harness: "pi"` dispatch to a node whose `pi --version` is older is refused before launch; an unreadable version (no `pi`, no output) is refused too, never assumed fine. |
| `projection` | `{repo?, tokenEnv?}` | _(unset)_ | Issue #132: one-way projection of mission progress onto a GitHub issue (`fleet_mission_project`): one comment edited in place plus `fleet:*` labels; never edits titles, bodies or others' comments, idempotent, and a GitHub outage returns `pending` without touching the mission. `repo` is `owner/name`; `tokenEnv` is the **name** of the environment variable holding the token (default `GITHUB_TOKEN`). The token stays in OpenClaw's secrets: it is read from that variable on the manager at call time and never written to config, ledger, journal or logs. |
| `capacity` | `{maxConcurrentPerNode?, staleAfterMs?, minFreeDiskGb?}` | both unset (unlimited slots), `staleAfterMs` default `21600000` (6 h) | Issue #39 concurrency slots, counted gateway-side from the run ledger. `maxConcurrentPerNode` (int 1–64) bounds runs per node; `staleAfterMs` (min 60000) releases the slot of a run still `running` without updates past that age (reported `suspectedStale`). `minFreeDiskGb` (issue #105): an isolated (`clone`) run copies the object store, so a node with less free disk than this refuses another with a retryable `no-disk` result (fail closed: a probe that cannot measure space is also a refusal). Unset = no check. |
| `allowAutoApprove` | `boolean` | `true` | Whether `fleet_dispatch` may pass `autoApprove` (`opencode run --auto`, auto-approves every non-denied permission). Set `false` to forbid it fleet-wide. The per-dispatch flag itself still defaults to **false**. |
| `allowSetupCommands` | `boolean` | `false` | Whether `fleet_provision setup` (and the same-shaped `expect.command`) may be an **arbitrary** shell command. Default: repo-relative script path with plain arguments only (the path must contain `/`). See `src/policy.ts` `checkSetup()` — enforced at the gateway policy chokepoint, not only in the tool schema. |
| `env` | `{allowOnly?[], extraDeny?[]}` | _(both unset)_ | Dispatch env policy refinement. Built-in denials (`BASH_ENV`, `NODE_OPTIONS`, `LD_*`, `GIT_SSH*`, `OPENCODE_CONFIG*`, …) always apply and cannot be lifted; `allowOnly` turns injection allowlist-only, `extraDeny` adds names. |
| `isolation` | `"none" \| "clone"` | `none` | Default per-run isolation for `fleet_dispatch` (issue #41). `clone`: each run gets a private git clone (`<parent>/.fleet-runs/<runId>/repo`, branch `fleet/<runId>`, own `.git`, hooks disabled) so concurrent runs cannot clobber each other or execute each other's hooks. Detached runs only; needs a protocol-4 node — an older node is **refused**, never run un-isolated. |
| `project` | `{gate?, maxScopePatterns?, maxAcceptanceItems?, roots?, rules?, requireCharterFields?, allowRepoBlocking?}` | `gate: "advise"`, bounds `20` / `15`, `allowRepoBlocking: false`, others unset | Issue #117 deterministic design gate on spec dispatches (no model call). `advise` attaches non-accept verdicts as `design`; `enforce` refuses dispatch while an unacknowledged blocking objection stands (`acknowledge` params records the override); `off` skips. `roots` bounds where `fleet_project_show` may read a checkout's `.fleet/` record; `rules` are operator rules repos cannot weaken; `requireCharterFields` lists charter fields records must have. |
| `s1` | `{backend?, mode?, timeoutMs?, thresholds?, calibration?, backends?}` | `backend: "local-kev"`, `mode: "shadow"`, `timeoutMs: 10000` | S1 decision layer (issue #79). `shadow` logs decisions and never acts on them; `enforce` blocks; `off` disables. A hosted (non-loopback) backend sends (redacted) data off-machine only when that backend's `allowEgress: true`. A layer failure always leaves the static rules in force. |
| `sync` | `{protectedBranches?, allowDirectPush?, blockOnScopeViolation?, requireReview?, requireReviewSource?, requireVerified?, allowSensitivePaths?, sensitivePaths?}` | protected `["main","master"]`, others `[]`/`false` | `fleet_sync` publish policy. Details below (unattended profile) and in `README.md` "Publishing worker changes". |
| `apertureUrl` | `string` | _(none)_ | Model catalog URL (OpenAI-style `/v1/models`). Until set, `fleet_models` and live model resolution are unavailable (they error, not degrade silently). |
| `fleetRoot` | `string` | `/home/<serviceUser>/fleet` **when every target node has the same serviceUser**; otherwise unset | Default provisioning cwd root on nodes (`src/cwd.ts`). When no default can be derived, pass `cwd` explicitly or set this. |
| `piDefaultModel` | `string` | _(none)_ | Pi model ref (`provider/id`) used when `harness: "pi"` and the dispatch names no `piModel`. There is no built-in default: a Pi dispatch without either is refused. |
| `allowedRoots` | `string[]` | _(unset)_ | Issue #103 group c: config twin of the node's `FLEET_ALLOWED_ROOTS` — workspace roots (absolute paths) every dispatch `cwd` must land under on the node. An explicit `FLEET_ALLOWED_ROOTS` env value on the node still overrides this. Unset: the node default (service home + `<home>/fleet`). |
| `stateDir` | `string` | _(unset)_ | Issue #103 group c: config twin of the node's `FLEET_STATE_DIR` — the node's private per-run state dir (mode 0700, see checklist item 7). An explicit `FLEET_STATE_DIR` env value on the node still overrides this. Unset: `~/.openclaw/fleet/state` under the service user's home. |
| `ssh` | `{strictHostKeyChecking?: "accept-new" \| "yes"}` | `accept-new` | SSH client policy for manager-to-node commands. `accept-new` = TOFU; `"yes"` requires keys pre-pinned in `known_hosts`. |

Plus one key the manifest does not carry because it is validated separately
(`src/budget.ts` `parseBudgetConfig`, wired in `src/index.ts` `register()` — a
malformed block is a load error, never a silently ignored limit):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `budget` | `{dailyCostUsd?, dailyTokens?, perDispatchCostUsd?, perDispatchTokens?}` | _(no limits)_ | Issue #39 spend caps. Daily totals are counted per **UTC day** (of run start) from ledger usage; per-dispatch caps default every run and can be overridden per dispatch (`perDispatchCostUsd`/`perDispatchTokens` params, both stricter and looser). Over-cap dispatches are refused with the retryable `budget-exhausted` result before launch. |

## The recommended unattended-run profile

Every choice below closes a specific unattended-worker failure mode. Together
they make a fleet safe to leave alone: runs are isolated, their access floor is
deny-based, nothing publishes without evidence, and the fleet cannot overrun.

```json
{
  "isolation": "clone",
  "allowAutoApprove": false,
  "capacity": { "maxConcurrentPerNode": 2 },
  "budget": { "dailyCostUsd": 20, "perDispatchTokens": 150000 },
  "dispatch": { "defaultTarget": "all" },
  "sync": { "requireVerified": true, "blockOnScopeViolation": true }
}
```

(Add an opencode config **deny baseline** on each node — next bullet — and keep
`nodes[].serviceUser`/`nodes[].user` set per the checklist.)

- **`isolation: "clone"`** — buys concurrency safety *and* hook/config
  containment: each run works in its own clone with its own `.git` and
  `core.hooksPath=/dev/null`, so one run cannot commit into another's work, a
  hook written by one run executes nohwere else, and the source checkout stays
  untouched. Costs: only committed state is cloned (`isolationNote` warns about
  a dirty source); needs a protocol-4 node (older ones are refused, never run
  un-isolated); a git worktree was deliberately rejected for sharing `.git`,
  which is the asset being protected. `fleet_cleanup` keeps clones holding
  unsynced work (`keptUnsynced`) unless `discardUnsyncedClones: true`.
- **The deny baseline (issue #51)** — the node-side permission **floor** for
  unattended workers: `external_directory` denied wholesale, destructive shell
  patterns (`rm -rf` outside cwd, `git push`, download-to-shell), reads of
  credential paths (`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.config/gcloud`,
  `.netrc`/`.npmrc`), and network egress not needed for coding (curl/wget,
  ssh/scp, socket relays, `webfetch`); package managers and git fetch/clone stay
  allowed on purpose. It is **deny-only and merge-only** (never flips a user
  rule to allow), idempotent data you can paste into the node's opencode config
  (`src/deny-baseline.ts` `BASELINE_DENY` / `mergeDenyBaseline`). It matters
  here because `autoApprove` auto-approves every non-denied permission — with
  unattended runs there is no human to answer an "ask", so safety rests entirely
  on denies, and `fleet_dispatch` with `autoApprove: true` **warns** on a node
  where `fleet_capabilities` reports `denyBaseline: false`. It is not a sandbox:
  oblique variants are not enumerated; depth comes from the other layers.
- **Unattended companion settings (issue #105)** — if you allow `autoApprove`,
  set these together; each covers what the others do not:
  1. `isolation: "clone"` (concurrency and hook/config safety, per run).
  2. The deny baseline installed on every node (`fleet_capabilities` shows
     `denyBaseline`): the permission floor `autoApprove` relies on.
  3. `capacity.maxConcurrentPerNode` and `capacity.minFreeDiskGb`, so a runaway
     fan-out cannot fill the disk with clones.
  4. A `budget` block, and `sync.requireVerified: true` so nothing lands from a
     gateless run.
  A filesystem sandbox (`bwrap`) is **not** available yet; when it lands it will
  give filesystem isolation only, **not** an egress allowlist (that needs a
  network namespace and an allowlisting proxy), so do not treat it as one.
- **`sync.requireVerified: true`** — buys "nothing lands from a gateless run":
  `fleet_sync` refuses work from a node+checkout whose latest run has **no**
  verification result (dispatch with `expect`/`spec.verify`), each with a reason
  naming the run and the escape hatch (`allowUnverified: true`). A run whose
  gate FAILED is always refused regardless; the override never bypasses a
  failed gate (the override names itself "overridden" in the result).
  Why: a detached worker exits 0 and produced nothing is the classic silent
  failure — quickstart step 9 shows it.
- **`sync.blockOnScopeViolation: true`** — buys "publish only what was asked
  for": when a run declared `spec.scope`, sync is refused when files changed
  outside it, when the scope was never checked (`fleet_run_status` on the
  finished run records what the node reported), or when the node could not
  report (`null` is a refusal, not a clean bill). Per-call
  `allowScopeViolations: true` publishes anyway; verification is still checked
  first and never bypassed. Runs without a declared scope are unaffected.
  Optional next step on the same axis: `sync.requireReview` (+ `requireReviewSource:
  "spawned"`) — publish only behind an independent reviewer PASS for the exact
  head sha; see `fleet_review` in `README.md`.
- **`capacity.maxConcurrentPerNode`** — buys a bounded blast radius: a node
  takes at most N concurrent runs; dispatches past the limit get a retryable
  `no-capacity` result instead of queueing invisible load, and `fleet_capacity`
  shows free slots and suspected-stale runs. Set per-node tighter/looser with
  `nodes[].maxConcurrent`. (Without it, a node's limit is "unlimited" — the
  gateway will happily stack runs on one box.)
- **Budget caps** — buys a finite worst-case bill: `budget.dailyCostUsd` /
  `dailyTokens` cap fleet spend per UTC day (day of run start, derived from the
  ledger), `budget.perDispatchCostUsd` / `perDispatchTokens` cap each run; a
  dispatch that would exceed a cap is refused **before launching** with the
  retryable `budget-exhausted` result (same shape as `no-capacity`, naming
  `spent` and the caps). Daily accounting depends on engines reporting usage
  (runs whose manifest carries no usage record nothing — no zero-laundering);
  `fleet_capacity` shows today's spend/remaining.
- **Bonus, on the access side** — `allowAutoApprove: false` in the profile above
  forbids the `--auto` widening fleet-wide; per the table above the sensible
  pairing is deny baseline first, then `autoApprove` per dispatch where you need
  it (the baseline turns "auto-approve everything non-denied" from dangerous to
  merely convenient).

## Troubleshooting — keyed by what the code actually emits

Match the exact string (or the prefix) from a tool result, then look at its row.
Line references are to the emitting module so you can confirm in place.

| You see | What it means | What to do |
|---|---|---|
| `{ "ok": false, "retryable": true, "reason": "no-capacity", "node": "…", "limit": 2, "running": ["…"] }` (`src/capacity.ts` `noCapacity`) | The node is at its concurrency limit — the gateway counted its ledger `running` entries against `nodes[].maxConcurrent`/`capacity.maxConcurrentPerNode`. Nothing was started. | Retry the same dispatch when a run finishes, dispatch to another node, or raise the limit. Slots free when runs reconcile terminal (`fleet_run_status` / `fleet_await`); a run silent past `capacity.staleAfterMs` (default 6 h) stops holding a slot and shows as `suspectedStale` in `fleet_capacity`. |
| `{ "ok": false, "retryable": true, "reason": "budget-exhausted", "error": "budget exhausted: …", "spent": {…}, "caps": {…} }` (`src/budget.ts` `budgetExhausted`) | This dispatch would push spend past a configured cap (`dailyCostUsd`/`dailyTokens` including the declared per-dispatch cap, or a per-dispatch cap the day's remaining budget cannot cover). Nothing was started. | Retry after the 00:00 UTC reset (the error says so), raise the cap in the `budget` block, or lower the need. Same retry discipline as `no-capacity`. |
| `VERIFICATION GATE TIMED OUT` (`verifiedNote`, `gateTimedOut: true`, `endedBy: "gate-timeout"` on the done marker; `verified: null`) (`src/verify.ts`, `src/node/runtime.ts`) | The verify command did not finish within its bound (`verify.timeoutMs`, default 120 s; the shell gate sees `timeout` exit 124, or 137 after the 5 s kill grace). That is a property of the check and the node's load, **not a verdict on the work**: the run stays `completed`, `verified` is null (never a pass), and `fleet_sync` with `sync.requireVerified` refuses it with "TIMED OUT" wording. A genuine failure (non-zero other than 124/137, or a missing file) is still `verified: false`. | Re-run the gate by hand or on a quieter node, or dispatch with a larger `verify.timeoutMs` (a full-suite gate such as `./scripts/verify.sh` needs more than the 2-minute default on a loaded node). Pass `allowUnverified` only once you have run the check yourself. |
| `error: "launch failed: <detail>"` on a detached dispatch (`src/tools/dispatch.ts`, `src/node/handler.ts` `launch failed (no LAUNCHED_PID)`); ledger entry lands `state: "failed"`, summary `launch failed: …` | The node explicitly rejected the launch, or the launcher produced no pid. No run state exists — returning a handle would fabricate a receipt, so the gateway records `failed` **and frees the slot immediately**. | Read the embedded detail. Common causes: the node's engine binary missing/not authenticated (prerequisite 2 — `opencode run "say ok"` on the node), a bad `cwd`, a refused request named in the detail. It is safe to re-dispatch after fixing the cause (the node said no, so the probe verdict is `absent`). |
| `commit: "policy-refused"` (sync), with `error` naming the policy (`src/provision.ts` `applyPolicy`, `src/syncpolicy.ts`) | `fleet_sync`'s publish policy refused: changes touching CI/CODEOWNERS paths without `sync.allowSensitivePaths`; credential-shaped text in added lines (or in intermediate commits — the net diff hides those); an unsafe branch name. Nothing was pushed. | Fix the named class: move CI changes out or set `sync.allowSensitivePaths`, remove the secret from the worker's history (the credential scanner names nothing on purpose — the secret is never echoed), or pick a safe branch name. |
| `error: "run <runId> failed its verification gate …; refusing to publish unverified work."` (sync, `src/ledger.ts` `syncGate`) with `verified: false` | The latest run on that node+checkout FAILED its verify gate; sync refuses by default. | Fix the work (see `fleet_run_status verifyDetails` for which check failed), or pass `allowUnverified: true` to publish anyway — that is an operator decision, and the result says it was overridden. |
| `error: "sync.requireVerified is set and … no verification result"` (sync, `src/ledger.ts` `verifyGate`) | `sync.requireVerified: true` is on and the latest run on the node+checkout ran gateless (no `expect`/`spec.verify`), so there is nothing verified to trust. | Re-dispatch with a verify gate, or pass `allowUnverified: true` (also covers the no-run-recorded case). |
| `error: "sync.blockOnScopeViolation is set and run <runId> changed N file(s) outside its declared scope: …"` (sync, `src/ledger.ts` `syncGate`) | Scope policy: the run declared `spec.scope` and touched files outside it — or its scope was never checked / the node could not report (`null` is a refusal, not clean). | Review the out-of-scope changes; narrow or correct the work; call `fleet_run_status` on the finished run first if the scope was never checked; or pass `allowScopeViolations: true` to publish anyway (does not bypass a failed gate). |
| **exit 66** (worker): `FLEET_ERROR: cannot enter cwd <cwd> as <user> (uid N): $?` (`src/opencode.ts` cd guard, observed as `exit 66` in run output; parse treats `FLEET_ERROR:…` at line start as failure per issue #63) | The worker process could not `cd` into the run cwd on the node: a missing dir, a non-dir, no traverse permission, or a path outside `FLEET_ALLOWED_ROOTS` (that one is refused earlier, by `guardCwd`, as `refused: cwd … is outside the allowed workspace roots …`). | Check the path exists and is owned/traversable by the **service user** (`chown -R` per `docs/STAGING.md` after root-side staging), keep cwd under `FLEET_ALLOWED_ROOTS`, and confirm provisioning succeeded (`commit` field). The run is `state: "failed"`, `ok: false` — no gate reclassification involved. |
| **exit 67** (worker): `FLEET_ERROR: this node's pi does not support <flag>; refusing to run unrestricted` (`src/opencode.ts` Pi restriction guard) — for `piTools`/`piTools: []` (`--tools`/`--no-tools`) and `piOffline` (`--offline`) dispatches | **Fails closed:** the dispatch requested a mandatory Pi restriction the node's `pi` binary does not support; instead of running Pi unrestricted, the run exits 67 before starting. (Dispatches also refuse at the gateway for nodes below protocol 5 — restrictions need protocol 5.) | Upgrade `pi` on the node until `pi --help` lists the flag, drop the restriction from the dispatch, or check `piHardeningGaps` in older Pi results: an older Pi runs with fewer baseline hardening flags (`--no-session`, `--no-approve`, `--no-extensions`, `--no-skills`) unsupported there (pi 0.73.1 has no `--no-approve`). Verify what the node's Pi actually supports with `docs/PI-VERIFY.md`. |
| (provision, non-Pi variant) `FLEET_ERROR: <msg>` with **exit 67** during a provisioned `setup` step, or **exit 68** when setup itself fails (`src/provision.ts` `fail()` marks a failed setup exit 68 so a broken bootstrap never reads as success; `safe.directory` setup failures exit 67) | The setup step ran and failed (68), or the provisioning shell could not make the checkout usable (67) — "provisioned" then does not mean "can run the tests". | Read `FLEET_ERROR: <msg>` and fix the named step or run `fleet_provision` again after repairing; the result carries `setup: { ran, ok, error }`. |
| `node speaks protocol <N> (< M) and cannot honor <feature>; upgrade opencode-fleet on the node first` (gateway policy, `src/gateway-policy.ts:133`); also, for a **stale protocol**: `request needs protocol X, newer than this node's protocol Y; upgrade the node plugin` (`src/protocol.ts` on the node) | Protocol refusals. Features have minimum node protocol versions (`src/protocol.ts` `FEATURE_MIN_PROTOCOL`: verification gate `expect` = 2, isolation `clone` = 4, Pi restrictions = 5), and a node that predates a feature would **silently ignore** it (run the wrong engine, skip the gate). The gateway probes the node (cached 5 min) and refuses instead. | Upgrade the plugin on the node: `openclaw plugins install <tgz> --force --accept-capabilities` (see packaging below) and restart the node service. The probe is harmless (`run.status` on an id that cannot exist); for non-default harnesses the probe itself is the protection. |
| `isolation "clone" needs a detached run (transport http, async not false): the clone is made by the node when the run starts` (`src/tools/dispatch.ts`) / `refused: cannot isolate the run: <git error>` (node, `src/node/handler.ts`) / `invalid isolation …(expected none\|clone)` | Structural isolation refusals: `clone` requested with a non-detached run, the node's git clone failed (dirty source the node could not clone, hooks/permissions), or an unknown level. | Dispatch detached (`async` unset/true, transport `http` — the defaults), commit the source checkout first (only committed state is cloned), and fix the git error named in the detail. `fleet_capabilities` lists `isolationLevels` per node; `clone` needs `gitClone` there. |
| `refused: <cwd> has uncommitted changes; commit or sync them before dispatching with a ref` (`src/node/handler.ts`) | A dispatch with an explicit `ref: {branch, commit}` requires a clean checkout — the node refuses to move refs under uncommitted work. | Commit/sync the current state first, then dispatch with the ref. |
| `refusing to dispatch: cwd <cwd> is unusable — it is not traversable by the worker principal (<svcUser>) (a /root path is mode 0700 …)` (`src/tools/dispatch.ts`, pre-dispatch cwd check) | The dispatch cwd is invisible to the worker principal — the classic "provision into /root" mistake, caught before a run is recorded. | Provision into a path both principals can enter (e.g. `<fleetRoot>/<repo>`; the error names an example). See `docs/STAGING.md` for the ownership hand-over rules. |
| `refused: cwd <cwd> is outside the allowed workspace roots (…)` (`src/guard.ts` `checkCwd`, node-side) | The requested cwd is not a strict descendant of any root in the node's `FLEET_ALLOWED_ROOTS` (or *is* an allowed root — those are refused too, a destructive op on a root would wipe the workspace). | Put the checkout under an allowed root, or add the intended root to `FLEET_ALLOWED_ROOTS` on the node and restart its service. |

## A new tool is not landed until agents can call it

The host filters each agent's tools through `agents.entries.<id>.tools.allow` in `openclaw.json`. An allow array written before a tool existed silently hides that tool from the agent: the plugin registers it, the manifest lists it, and no session ever sees it (ten mission/project tools were invisible this way until the arrays were updated). After every `fleet_deploy` or upgrade, run:

```
npm run tools:check-allow -- /path/to/openclaw.json
```

It exits 0 when every agent that allows any `fleet_*` tool can call every tool in the manifest's `contracts.tools`, 1 on drift (it lists, per agent, the tools it cannot call and any `fleet_*` entries naming a tool that no longer exists), and 2 on unreadable input. Agents that allow no `fleet_*` tool are not fleet agents and are left alone; a `*` or `fleet_*` entry covers everything. The check is read-only and never edits the config: adding the names is an operator action. `fleet_deploy` also runs it and attaches the result as `toolAllow` (`{checked:false, reason}` when `~/.openclaw/openclaw.json`, or `$OPENCLAW_CONFIG_PATH`, cannot be read); drift never fails the deploy.

## Packaging

- **Build:** `npm run plugin:build` = `tsc -p tsconfig.json` +
  `openclaw plugins build --entry ./dist/index.js` (generates/updates the plugin
  manifest from the entry; `npm run plugin:validate` runs the same build plus
  validation). Then `npm pack` produces `openclaw-plugin-opencode-fleet-<version>.tgz`
  containing `dist/`, `openclaw.plugin.json`, `README.md`, and `skills/`
  (the `files` whitelist; the bundled skill installs itself with the plugin).
  Install on the gateway and every node with
  `openclaw plugins install <tgz> --force --accept-capabilities`
  (`--force`: non-ClawHub source + overwrite an existing install;
  `--accept-capabilities`: accept the declared tool capabilities without
  prompting), as the **service user** on nodes — see checklist item 6 for the
  principal rules. Or one command, `fleet_deploy`: build → pack → install on
  gateway + nodes (staged in a private `mktemp -d`, sha256-verified before
  install) → restart node services → returns `gatewayRestartRequired: true`.
  Per `docs/DEPLOY.md`: apply it with an owner gateway **restart issued from
  outside an agent turn** — do not `plugins reload` the active plugin (a reload
  was seen to never settle), and sessions started before the restart keep their
  old tool list.
- **Version/compat policy:** the plugin declares **`peerDependencies.openclaw:
  ">=2026.5.17"`** — the minimum OpenClaw plugin API it requires (also mirrored
  as the `openclaw.compat.pluginApi` manifest field; `build.openclawVersion`
  records the dev version the build was produced with). Runtime dev is pinned
  in `devDependencies` (`"openclaw": "2026.8.2"`) so builds and tests are
  reproducible, while the peer range installs against newer gateways; keep the
  pin recent (bump it when you test against a newer gateway) and raise the peer
  floor only when a new API call makes it unavoidable — the compatibility
  contract is "works with gateways from the peer floor, built/tested on the pin."
  Node protocol versions are a second axis (see the protocol-refusal row above);
  a plugin upgrade on the gateway must be rolled out to nodes promptly or
  feature dispatches will be refused once they need a newer protocol.
- **The private-package decision (issue #45):** this package is
  **`"private": true` in `package.json` and stays that way** — no npm
  registry publication. Reasons: the fleet is an internal deployment tool whose
  versioning is meaningless outside its gateway/node contract; the tarball
  channel (`npm pack` + `openclaw plugins install <tgz>`) is already the
  mechanism `fleet_deploy` automates and gives exact-artifact installs with
  sha256 verification; and publishing would put a dependency-shaped API surface
  (the `openclaw` peer) under semver pressure it does not currently carry.
  If #45 ever revisits it (e.g. a marketplace entry), the change is additive: a
  published package is just another install source, and the tarball path keeps
  working unchanged.

## Security posture: ON by default vs opt-in

The plugin's defaults are chosen so an unconfigured install is **usable but
conservative at the boundaries that matter**, with the dangerous powers opt-in.
Per boundary:

**On by default (needs no configuration, and its absence is the safe side):**

- **Credential-free workers** — nodes never receive GitHub credentials; repos
  travel as manager-minted git bundles, publishes go through `fleet_sync` with
  manager credentials. This is not a setting; it is the architecture.
- **Node-side cwd confinement** (`FLEET_ALLOWED_ROOTS`, strict descendants only,
  roots themselves refused) and per-run private state (0700, owned, ID-validated)
  before anything destructive runs (`src/guard.ts`, `src/paths.ts`).
- **Protocol validation on the node channel** — ops are explicit, echoed back,
  sentinel ambiguity refused (`src/protocol.ts`); unknown/older nodes are
  probed and refused at the gateway rather than trusted.
- **Env denylist** on dispatch `env` (execution/config-hijacking names always
  refused; operators can only narrow further with `env.allowOnly`/`extraDeny`).
- **Sync publish policy even when unconfigured**: protected branches
  (`main`/`master`) are always redirected to `fleet/<name>`, CI/CODEOWNERS paths
  and credential-shaped text are refused unless explicitly allowed. No config =
  still protected.
- **`allowAutoApprove: true` (manifest default) + per-dispatch `autoApprove:
  false`** — the *capability* to auto-approve is on, but a dispatch still has to
  ask for it. The guard rails are the gateway-level kill switch
  (`allowAutoApprove: false` forbids it fleet-wide) and the `autoApproveGate`
  (`src/deny-baseline.ts`): a node that cannot verifiably support `--auto` is
  refused (never an unparseable flag), a node **without the deny baseline** gets
  a warning naming it. Treat `autoApprove` + no baseline as an escalation, not a
  default.
- **Shadow S1** (`s1.mode` default `"shadow"`) — decisions are logged, never
  acted on; a layer failure or `off` leaves the static rules in force. Egress to
  a hosted backend needs `allowEgress: true` (default false) and sends
  redacted data only.
- **Verification gate is structured, never implied** — a gateless run reports
  `verification: {gate: "none"}`; `verified` is `null`, recorded separately from
  `ok`, and a failed gate reclassifies `state` to `failed-verification` (exit 0
  can therefore never launder itself into `completed`).
- **The design gate advises by default** (`project.gate: "advise"` — verdicts
  attached, dispatch not refused).

**Opt-in, and what each buys:**

- **`isolation: "clone"`** (or per-dispatch) — concurrency safety + hook/config
  containment (see the unattended profile; requires protocol 4).
- **The deny baseline installed on nodes** — the permission floor that makes
  `autoApprove` sane (issue #51). Without it, auto-approve rests on whatever the
  node's own opencode config has.
- **`allowSetupCommands: true`** — arbitrary shell for provision `setup` and
  `expect.command/commands`. Buys convenience (say `test -s file` gates);
  costs: the command runs on the node outside the engine's permission system,
  so this widens what repo text can make the node execute. Default stays off.
- **`sync.requireVerified`** — refuse publishing gateless work; 
- **`sync.blockOnScopeViolation`** — refuse publishing out-of-scope changes;
- **`sync.requireReview` (+ `requireReviewSource`)`** — refuse publishing
  without an independent reviewer PASS bound to the exact head sha. These three
  are the publish-side hardening set; see the unattended profile for the
  recommended combination.
- **`sync.allowSensitivePaths`** — permit CI/CODEOWNERS path changes. Buys the
  ability to publish workflow edits from a worker; costs the CI injection
  surface — prefer manager-side edits or narrow `sensitivePaths`.
- **`s1.mode: "enforce"`** — act on S1 decisions (block) instead of logging;
  needs `calibration` recorded, and a runtime model mismatch downgrades to
  shadow until re-calibrated.
- **`dispatch.defaultTarget: "all"`** — restores fleet-wide fan-out for
  unnamed dispatches. Buys convenience; costs a typo becoming a fleet-wide job.
- **Per-dispatch trust widenings** — `autoApprove: true` (within the gate),
  arbitrary `env` names within the allowlist, `allowUnverified` /
  `allowScopeViolations` on a specific sync. Opt-in per call, recorded in the
  result/reason.

**Rule of thumb:** defaults protect the *boundaries* (credentials, paths,
protocol, publish policy); settings protect the *workers and spend* (isolation,
deny baseline, sync hardening, capacity, budget). The defaults are safe to
operate a one-node fleet on; the unattended profile above is what "leave it
alone for a day" requires.