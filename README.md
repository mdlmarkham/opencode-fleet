# opencode-fleet

Orchestrate **OpenCode** across multiple remote OpenClaw nodes (dev2, dev3, ...) over the authenticated node channel.

The **manager** (Main/Metis) holds GitHub credentials and model routing. **Workers** (dev2/dev3) stay credential-free — they receive repos via git bundles and never touch GitHub or hold PATs.

## Features

### Dispatch & monitoring
- **`fleet_dispatch`** — send an OpenCode coding task to one or more nodes, with per-task model allocation and capability-constraint routing (`requires: {gpu, minDiskGb, minMemGb, tools, models}`). **Defaults (issue #168):** you must name the target: `node: "dev2"`, `nodes: [..]`, `nodes: "all"` (explicit fan-out) or `pick: "any"` (one node with a free slot, most free first; a retryable `no-capacity` when none). An unnamed target in a multi-node fleet is **refused** with the nodes and their free slots (a one-node fleet needs none); operators who relied on the old fan-out set `dispatch.defaultTarget: "all"`. The default wall-clock limit is **30 minutes** (`defaultTimeoutMs`, was 5), the idle watchdog (`maxIdleMs`) being the hung-run guard; a run ended by a limit reports `endedBy: "wall-clock" | "idle-watchdog"`, and a `timeoutMs` under 10 minutes on a spec with 2+ acceptance criteria adds a `warnings` entry. A dispatch with no verify gate returns `verification: {gate: "none"}` (the exit code is the only success signal) under `project.gate: advise` (default), nothing under `off`, and is **refused** under `enforce`.
- **`fleet_watch`** — dispatch + live monitoring: streams progress to the agent, polls node activity, returns the final result when done. It is a blocking call and its `timeoutMs` (default **10 minutes**, was 5) is the run's only wall-clock limit. A run it ends reports `endedBy` (`wall-clock`, with `timeoutMs` and a hint, and an error that names fleet_watch's own timeout; `idle-watchdog`; or `watch-relay` when the relay failed before the node reported, with `mayStillBeRunning`). For long tasks use `fleet_dispatch` (detached, 30-minute default) plus `fleet_await`.
- **`fleet_status`** — node health + connectivity
- **`fleet_capabilities`** — CPU/RAM/disk/GPU/tools/models per node (live detection)
- **`fleet_activity`** — running OpenCode processes per node (pid/elapsed/cpu/command)
- **`fleet_abort`** / **`fleet_diff`** — session control (real: kills processes / shows git diff)

### Worker collaboration
- **`fleet_answer`** — answer a worker's hand-raised clarifying question and re-dispatch with the answer
- **`fleet_iterate`** — auto-iterate on failures with **no-progress escalation** (stops instead of burning tokens in a blind retry loop)

### Provisioning
- **`fleet_provision`** — provision a repo to workers **without giving them GitHub credentials** (git bundle transport)
- **`fleet_provision_config`** — ship OpenCode agent definitions, global rules (AGENTS.md), skills, and opencode.json to workers
- **`fleet_sync`** — pull worker changes back and push to GitHub with manager credentials
- **`fleet_cleanup`** — keep nodes tidy: git gc, report disk usage, and prune finished runs' scripts/logs/state (older than `pruneOlderThanDays`, default 7; live runs are never touched; needs a protocol-3 node)

### Isolation
- **`fleet_dispatch { isolation: "clone" }`** (or config `isolation: "clone"`) — the node makes a private git clone of `cwd` at `<parent>/.fleet-runs/<runId>/repo` (0700, own `.git`, `core.hooksPath=/dev/null`) on branch `fleet/<runId>`, and the worker, verify gate, scope check and audit manifest all use it. Concurrent runs cannot clobber each other, and a hook or config written by one run cannot execute in another's or in the source checkout. The dispatch result returns `runCwd` and `branch`: pass `runCwd` to `fleet_sync`. Only **committed** state is cloned (`isolationNote` warns when the source has uncommitted changes). Detached runs only. Needs a protocol-4 node: an older one is **refused**, never silently run un-isolated. `fleet_cleanup` removes finished runs' clones after `pruneOlderThanDays`, but **keeps (and lists under `keptUnsynced`) any clone holding work beyond its start commit** unless `discardUnsyncedClones: true`. A `git worktree` was deliberately not used: worktrees share `.git` (hooks, config), which is the thing being protected. A sandbox level (`bwrap`/container with an egress allowlist) is not implemented yet.

### Audit
- **`fleet_run_report`** — the audit manifest of a finished run: files changed against the start commit, `git diff --stat`, commands the engine ran (opencode reports them; Pi's plain transcript does not, so `commandsRecorded: false`), exit code, duration, token/cost usage, verification and scope results, event-log size, plus the dispatch spec. Raw evidence stays on the node (private state dir); secrets are redacted when it is returned. Fields that could not be captured are `null`, never an implied empty list. Needs a node with the audit trail; an older node is reported as such.
- **Pi live verification** (issue #137): `scripts/pi-capture.mjs` (run on a node with `pi`) captures Pi's `--help`, version and two tiny JSON-mode runs; `npm run pi:verify -- pi-capture.json` checks every flag and event name the plugin relies on and says what breaks while each is unconfirmed. See `docs/PI-VERIFY.md`.
- **`fleet_cleanup` ownership report** (issue #189): with `cwd`, each node's result carries `ownership` — how many worktree and `.git` paths are not owned by the node's service user, plus the `chown` to run. Report-only. Root-side staging poisons ownership; the corrected procedure is in `docs/STAGING.md`.
- **Pi runs** (issue #137): `harness: "pi"` runs Pi with `--mode json` **by default** (when the node's Pi lists `--mode`), so the result carries `toolCalls`, `usage` and `stopReason` and the audit manifest records commands and usage (without it a Pi run's manifest was empty: Pi prints only the final answer). `piJson: false` opts out. The result also reports `piVersion` and `piHardeningGaps`: the baseline hardening flags (`--no-session`, `--no-approve`, `--no-extensions`, `--no-skills`) this node's Pi does **not** support and so were not applied. Live-verified on pi 0.73.1, which has no `--no-approve`, so that hardening is absent there until Pi adds it.
- **Deploying** (issue #191): apply a `fleet_deploy` build with an owner gateway **restart** issued from outside an agent turn, not `plugins reload` (a reload of the active plugin was seen to never settle). Sessions started before the restart keep their old tool list. See `docs/DEPLOY.md`.
- **`fleet_capacity`** — concurrency slots per node. A node's limit is its `maxConcurrent` (in the `nodes` config), else `capacity.maxConcurrentPerNode`, else unlimited. A `fleet_dispatch` to a node at its limit starts nothing and returns a retryable `{ok:false, retryable:true, reason:"no-capacity", limit, running:[runIds]}` for that node (other nodes in a fan-out still run). Slots are counted from the gateway's run ledger, and the count and the new entry are one atomic step, so concurrent dispatches cannot both take the last slot. A run still `running` after `capacity.staleAfterMs` (default 6h) without an update stops holding a slot and is listed as `suspectedStale`; a launch the node definitively refused is recorded `failed` and frees its slot at once. This is gateway-side counting, so it assumes one gateway dispatches to a node. Spend and token caps are not part of this slice.
- **`fleet_await`** — wait for a set of detached runs in ONE call (issue #180) instead of polling `fleet_run_status`. `{runIds:[...] (max 25), node?, timeoutMs? (default 120s, max 600s), pollMs?, until? "all"|"any"}`. The plugin polls internally with backoff (2s growing to 15s), one run per node at a time, and runs each read through the same code as `fleet_run_status`, so the ledger, `verified` and `scopeViolations` are reconciled identically. It returns `{allTerminal, timedOut, runs:{<id>:{terminal,state,exitCode,verified,...}}, pending:[...]}`; on timeout it returns the finished runs and the pending ids (not an error) and you call it again. An unknown run id or an unreadable run settles with an error rather than hanging the set. Waits longer than the cap belong in a scheduled automation. There is no node-to-gateway push: the OpenClaw SDK lets a node emit events but exposes no plugin hook to receive them or to wake a parent agent (spike on issue #180), so waiting stays a plugin-side poll. `until: "any"` returns as soon as one run is terminal.
- **`fleet_review`** — the review gate as data (issues #177, #178). `action: "record"` stores a structured verdict (`PASS | FAIL | BLOCKED`) bound to one full 40-hex `headSha`. A PASS must carry evidence (at least one executed command with `exitCode: 0` and its output tail, and no recorded command may have failed: a failed run cannot sit next to a passing one) and no open blocking/major finding; a reviewer that could not run its tools records `BLOCKED`, never PASS. Reviewer and author must differ. `action: "check"` says whether a head has a PASS; the latest record for the sha decides, and a PASS for an older sha is `STALE`. With `sync.requireReview: true`, `fleet_sync` needs `head`, refuses unless that exact sha has a PASS, and refuses to publish a worker bundle whose branch tip is any other sha (`head-mismatch`), so commits added after the review are never published. Reviewer text is redacted and bounded. **Limit:** this does not spawn or authenticate the reviewer (that needs the OpenClaw session API, #176): a record is asserted by the caller and marked `source: "recorded"`.
- **`fleet_design_check`** — dry-run of the deterministic design gate on a task spec, with no model call and no dispatch. It returns a verdict (`accept`, `accept-with-nudges`, `decompose`, `reject-with-reason`) and objections, each with a severity, a message, **cited evidence** (a run id, a count, a missing field) and a suggestion. v1 checks: missing acceptance/verify/scope, a spec too large for one task, and overlap with runs already in flight on the same checkout (pass `node` and `cwd`). `fleet_dispatch` runs the same gate on a structured `spec` according to the `project.gate` setting (`off`, `advise` by default, `enforce`): in `advise` the verdict is attached as `design` unless it is a plain accept; in `enforce` a dispatch is refused while an unacknowledged blocking objection stands. To proceed anyway pass `acknowledge: [{objectionId, reason}]`; the reasons are recorded on the ledger entry (`gateAcknowledged`). A prompt-only dispatch is not design-gated, but under `project.gate` it is told it has no verify gate (`verification: {gate: "none"}`; refused under `enforce`, #168). Checks that need the `.fleet/` project record (risky surfaces, recorded decisions, baseline failures, "if you touch X also do Y" rules) arrive with that record (#114, #115).
- **`fleet_project_show`** — what a project believes: the validated `.fleet/` record of a checkout on the gateway host, or the precise validation errors (file, field, message). Read-only, and only under the operator's `project.roots`. See "The `.fleet/` project record" below.

### Model selection & learning
- **`fleet_models`** — query the Aperture model catalog (pricing/context) so the agent picks the right model per task
- **`fleet_recipe_recommend`** — recommend the best (model, thinking, agent, transport) combo for a task + codebase, learned from past outcomes
- **`fleet_recipe_record`** — record an outcome (combo, tokens, cost, success, churn, rating) so the store learns what works
- **`fleet_recipe_list`** — list learned recipes with stats

### Operations
- **`fleet_deploy`** — one-command deploy: build, pack, install on gateway + nodes, restart node services

## Transports

Both OpenCode transports are supported:

| Transport | Command | Use case |
|---|---|---|
| **HTTP** | `opencode run` | Fire-and-forget batch dispatch; supports per-task `--model` |
| **ACP** | `opencode acp` (via `@agentclientprotocol/sdk` client) | Full-featured path (MCP, AGENTS.md rules, terminal); model is config-scoped |

## Architecture

Two-sided plugin:

- **Gateway side** — `registerNodeInvokePolicy` for `opencode.run` (permission boundary) + the fleet tools
- **Node side** — `nodeHostCommands` declares `opencode.run`, which runs OpenCode on the node's shell

Credentials stay on the node for model routing; the Gateway relays only the task prompt and workspace path.

## The recipe store (learning loop)

Agents record outcomes after each dispatch ("used X for Y, got Z, rating N"). The store derives:

- **`indicatedFor`** — task types this combo is good at (success ≥ 80%, rating ≥ 4)
- **`contraindicatedFor`** — task types this combo is bad at (success < 50% or rating < 2.5)

Recommendations use **model capability classes** (fast/mid/heavy/review) rather than specific model IDs, so they survive the 4-6 week LLM churn cycle — a recipe says "use a fast model for simple-fix", and the resolver maps that to whatever fast model is currently available.

## Hand-raise

Workers can "raise their hand" when they hit high uncertainty: they emit `HAND_RAISE: <question>` and stop. The plugin detects it and returns `{handRaised: true, question}`. The calling agent answers via `fleet_answer`, which re-dispatches with the answer + prior context.

## Stuck-loop protection

- **Watchdog** — `fleet_dispatch` accepts `maxIdleMs` (kill if no output) and `maxDurationMs` (kill if too long)
- **No-progress escalation** — `fleet_iterate` fingerprints each iteration's output; identical consecutive output triggers escalation (heavier model / change approach / human handoff) instead of a token-burning retry loop

## Verification gate (optional)

A worker that exits 0 but produced nothing is not a success — but an exit code alone can't tell. `fleet_dispatch` accepts an optional `expect` gate:

```jsonc
{
  "prompt": "build the docs",
  "cwd": "...",
  "expect": { "files": ["docs/api.md"], "command": "test -s docs/api.md" }
}
```

After the worker exits, the node evaluates the gate in the run's cwd and records it on the run result:

- every path in `expect.files` must exist **inside the run directory** (relative paths only; absolute paths and `..` are refused, and a symlink that resolves outside the directory does not count)
- `expect.command`, when given, is run via `bash -c` in cwd (bounded to 120s, whole process group killed on timeout) and must exit 0. It runs on the node **outside the engine's permission system**, so it follows the same rule as provision `setup`: a repo-relative script path with plain arguments (e.g. `./scripts/check.sh --fast`) unless the operator sets `allowSetupCommands`

The outcome is recorded as `verified: boolean` with per-check `verifyDetails`, and is surfaced by `fleet_run_status`. **`verified` is separate from `ok`** (`ok` remains the raw process exit status): `ok: true, verified: false` means the worker exited cleanly but the expected artifacts were not produced — treat the run as unverified, not successful. Omitting `expect` changes nothing (`verified: null`).

The gate needs a node speaking protocol 2: the gateway refuses to send `expect` to an older node (which would silently ignore it and look like an ungated run) and tells you to upgrade it. The relay timeout for a gated run is the worker's `timeoutMs` plus the gate's bound plus a grace period, so a worker that uses its whole budget still reports `verified`.

## Task spec (structured dispatch)

`fleet_dispatch` also accepts a structured task spec as the dispatch unit (issue #65):

```jsonc
{
  "cwd": "...",
  "spec": {
    "goal": "Implement the config loader",
    "acceptance": ["loads YAML", "fails loudly on bad input"],
    "verify": { "files": ["dist/index.js"], "command": "npm test -- --silent" }
  }
}
```

- When `spec` is given, the engine prompt is **rendered** from it: the goal on the
  first line, then an `Acceptance criteria:` bullet list (`spec.ts/renderSpec`).
  The flat `prompt` is optional then and ignored.
- `spec.verify` maps onto the **same verification gate** as the flat `expect`
  param above — same parser, same node-side evaluator, same `verified`/`verifyDetails`
  recording and ledger shape. A spec without `verify` runs gateless (nothing extra).
- A prompt-only dispatch behaves exactly as before (`renderSpec({goal: prompt})`
  returns the prompt byte-identically), and the spec is recorded on the run's
  ledger entry.
- A call with neither `prompt` nor `spec` is refused.

## Install

```bash
# Gateway + each node
openclaw plugins install opencode-fleet.tgz --force --accept-capabilities
```

Enable in `openclaw.json`:

```json
{
  "plugins": { "entries": { "opencode-fleet": { "enabled": true } } },
  "gateway": { "nodes": { "commands": { "allow": ["opencode.run"] } } }
}
```

The plugin bundles a **skill** (`skills/opencode-fleet/SKILL.md`) that teaches agents when/how to use the fleet — it installs automatically with the plugin.

## Config

| Key | Default | Description |
|---|---|---|
| `defaultTransport` | `http` | Default OpenCode transport |
| `nodePrefixes` | _(none)_ | Optional fallback: node display-name prefixes treated as fleet members when `nodes` does not list them. No default. |
| `defaultTimeoutMs` | `1800000` | Default wall-clock timeout for a dispatched run (30 min; was 5 min). A run ended by it reports `endedBy: "wall-clock"` |
| `dispatch.defaultTarget` | _unset_ | `"all"` restores the old default of fanning an unnamed `fleet_dispatch` out to every node. Unset: an unnamed target is refused |
| `apertureUrl` | _(none)_ | Model catalog URL (OpenAI-style `/v1/models`). `fleet_models` and live model resolution need it. |
| `fleetRoot` | _(derived)_ | Shared workspace root on nodes, the default provisioning cwd. Derived as `/home/<serviceUser>/fleet` when every target node has the same `serviceUser`; otherwise pass `cwd` or set this. |
| `piDefaultModel` | _(none)_ | Pi model ref (`provider/id`) for `harness: "pi"` when the dispatch names no `piModel`. There is no built-in default; without either, a Pi dispatch is refused. |
| `allowAutoApprove` | `true` | Whether `fleet_dispatch` may pass `autoApprove` (`opencode run --auto`, auto-approves every non-denied permission). Set `false` to forbid it fleet-wide. |
| `allowSetupCommands` | `false` | Whether `fleet_provision`'s `setup` may be an arbitrary shell command. By default it must be a repo-relative script path with plain arguments (e.g. `scripts/setup.sh`). |
| `ssh` | `{strictHostKeyChecking: "accept-new"}` | SSH client policy; set `"yes"` once host keys are pinned. See "SSH access". |
| `sync` | see below | `fleet_sync` publish policy: `protectedBranches` (default `["main","master"]`), `allowDirectPush` (default `[]`), `allowSensitivePaths` (default `false`), `sensitivePaths` (extra path globs, e.g. `ci/**`, added to the built-in list). |
| `nodes[].user` | _(unset)_ | SSH login user for a node (defaults to SSH config default, usually `root`) |
| `nodes[].serviceUser` | _(unset)_ | Principal the node's OpenClaw service runs as, when it differs from the login user. Install/verify target this principal's plugin root. |

## Trust boundaries for agent-supplied input

Text an agent passes to `fleet_dispatch`/`fleet_provision` can originate from content the agent read, so these channels are restricted:

- **`env`** — names that execute code or redirect configuration are refused (the dispatch fails and names them; they are never silently dropped): `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `LD_*`, `GIT_SSH*`, `GIT_CONFIG*`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG*`, `OPENCODE_PERMISSION`, and similar. Ordinary variables (`CI`, API keys, proxies) pass.
- **`setup`** — a repo-relative script path (it must contain a `/`, e.g. `scripts/setup.sh` or `./setup.sh`, so bare names like `sh -c id` are refused) with plain arguments only, unless the operator sets `allowSetupCommands`. Operators can narrow `env` further with `env.allowOnly` / `env.extraDeny`.
- **`autoApprove`** — opt-in per dispatch, and forbiddable with `allowAutoApprove: false`. It widens what a detached worker may do without asking; pair it with deny rules on the node.
- **`cwd`** — confined to the node's allowed roots (`FLEET_ALLOWED_ROOTS`, default: the fleet workspace root and the service home).

## Publishing worker changes (`fleet_sync`)

Worker work is pushed with the manager's credentials, so `fleet_sync` applies a policy before pushing:

- **Protected branches** (default `main`, `master`) are never pushed directly. The work goes to `fleet/<worker-branch or sync-id>` and the result reports `redirectedFrom`; open a PR from it. List a branch in `sync.allowDirectPush` to allow direct pushes to it.
- **CI/CODEOWNERS paths** (`.github/workflows/**`, `.github/actions/**`, `CODEOWNERS`, `.gitlab-ci.yml`, `.circleci/**`, `Jenkinsfile`, …) in the worker's changes are refused unless `sync.allowSensitivePaths` is set; add your own with `sync.sensitivePaths`.
- **Credential-shaped text** in added lines (tokens, keys, private keys, password assignments) is refused; nothing is pushed and the secret is never echoed.
- **Scope policy** (opt in with `sync.blockOnScopeViolation: true`): a run that declared `spec.scope` and changed files outside it, or whose scope was never checked (call `fleet_run_status` on the finished run, which records what the node reported), is refused. Pass `allowScopeViolations: true` to publish anyway; that never bypasses a failed verification gate. Runs without a declared scope are not affected. Off by default, where scope violations stay advisory.
- Branch names that could be read as git options (leading `-`, `..`, …) are refused, and the repo argument is passed after `--`.

## Node protocol

`opencode.run` requests carry an explicit `op` (`run`, `run.start`, `run.status`, `xfer.receive`, `bundle`, ...) and a `protocol` version; every node reply echoes `protocol`. The old `__SENTINEL__` prompts remain as a compatibility encoding: with no `op` the prompt decides, and when both are present they must agree, so a task prompt can never be promoted to a control message nor a control message passed off as a task. `fleet_dispatch` also rejects a task prompt that equals a sentinel.

**Pi restrictions.** Every Pi run is started with `--no-session --no-approve --no-extensions --no-skills`, each only if this node's `pi --help` lists it (an older Pi still runs, unhardened). A dispatch may add `piTools` (an allowlist passed as `--tools`; `[]` means `--no-tools`) and `piOffline` (`--offline`). These are mandatory once requested: if the node's Pi lacks the flag the run exits 67 instead of running unrestricted, and a node below protocol 5 refuses the dispatch. Pi has no permission system of its own, so this allowlist is the only tool-level control. See #137.

Nodes that predate the protocol report none (protocol 0). They ignore `harness`/`piModel`, so a dispatch with a non-default harness first probes the node (a harmless `run.status` for an id that cannot exist) and is refused with "upgrade opencode-fleet on the node" instead of silently running the wrong engine. The probe result is cached for five minutes.

## SSH access

The manager reaches nodes with `ssh`/`scp` (provisioning, sync, deploy). Every call passes `--` before the host and validates the host string, so a node record cannot smuggle in an ssh option.

- **Use an unprivileged login user** (`nodes[].user`), not root, with a narrow sudoers entry for the two things deploy needs. Example for login user `fleetmgr`, service user `svcuser`:
  ```
  fleetmgr ALL=(svcuser) NOPASSWD: ALL
  fleetmgr ALL=(root) NOPASSWD: /usr/bin/systemctl restart openclaw-node.service, /usr/bin/systemctl is-active openclaw-node.service
  ```
  (`fleet_deploy` warns when it manages a node as root. `sudo -u svcuser` is only needed for deploy/install-record work; day-to-day sync needs no sudo.)
- **Host keys:** the default `ssh.strictHostKeyChecking: "accept-new"` trusts a key on first contact and refuses changes. For production fleets pin keys when you provision nodes (`ssh-keyscan` into the manager's `known_hosts`) and set `"yes"`.
- **Deploy** stages the tarball in a private `mktemp -d` directory on the node and verifies its sha256 before `openclaw plugins install`.

## Development

```bash
npm run build        # tsc
npm pack             # create tarball
# install tarball on gateway + nodes, restart node services + gateway
```

Or use the built-in deploy: `fleet_deploy` (or the `deployPlugin` module) does build → pack → install on gateway + nodes → restart node services, and reports `gatewayRestartRequired` for the final gateway restart.

## Deploy prerequisites (fleet nodes)

`fleet_deploy` installs the plugin into the **service user's** plugin root and verifies the
installed `dist/index.js` sha256 matches the built artifact. Two node-state facts must hold:

1. **Correct principal.** If the node's OpenClaw service runs as a non-root user (e.g.
   `svcuser`), set `nodes[].serviceUser` so install/verify target that user's
   `~/.openclaw/extensions/`. The live node process is a **system-scope** unit
   (`openclaw-node.service`) — restart it via `sudo -n systemctl restart openclaw-node.service`,
   not `systemctl --user`.

2. **No stale root-owned install record.** A node that once installed the plugin *as root*
   keeps a managed install record in the service user's state DB, in the
   `config_machine_state` row `state_key='plugins.installedIndex'`, whose `installPath` points
   at `/root/.openclaw/extensions/opencode-fleet`. On later non-root installs the CLI's retire
   phase calls `realpathSync('/root/.openclaw')` → **EACCES** and exits `rc=1` — even though the
   install itself succeeded. The node ends up with correct code but a failed report.

   **Repair** (back up the state DB first): correct that record's `installPath` to the service
   user's path (and ensure no field is JSON `null` where the schema wants an *absent* key,
   e.g. `sourcePath`), or delete only that row and run `openclaw doctor --fix` to rebuild it.
   Backups: `~/.openclaw/state/openclaw.sqlite.bak-installrecord-<ts>`.

## Key implementation notes

- **Node invoke inactivity timeout**: long-running node commands that produce no output for ~11s get killed. The node host command's `handle` must emit progress chunks via `io.emitChunk()` to keep the invoke alive.
- **`opencode acp` has no `--model` flag** — model selection is config-scoped on the node, not per-prompt.
- **Repo bundles must be full clones** (no `--depth 1`) or the worker can't traverse history.
- **Use light `git gc`** — `--aggressive` is too slow for large repos and leaves stale locks.
- **Gateway restart kills the session** running the deploy — `fleet_deploy` does everything except the final gateway restart and reports it.
- **Use a non-login shell (`bash -c`) for node install/verify** — a login shell (`bash -lc`) sources the profile and can print MOTD/banner text to stdout, corrupting the parsed rc/hash. Parse the last well-formed 64-hex line as the hash.
- **`[sqlite/transaction] slow SQLite transaction hold` is a transient warning**, not a failure — a clean re-run exits `rc=0`.
- **Verify the running process, not just "service active"**: check process uptime (confirms restart) and the running code hash (confirms the new build is loaded).

## The `.fleet/` project record

A repo can carry its own context and rules in `.fleet/` (this repository does; use it as the worked example):

```
.fleet/
  charter.md                  frontmatter (schemaVersion, name) + sections: Goal, Users, Constraints,
                              Non-goals, Success criteria, Riskiest assumptions
  rules.yml                   schemaVersion + rules: [{id, severity, match{paths|keywords}, message, evidence?, requires?}]
  decisions/NNNN-<slug>.md    frontmatter (schemaVersion, id, title, status, date, scope?, supersededBy?)
                              + sections: Context, Decision, Alternatives rejected, Consequences
  roles/ skills/              reserved for #110
```

Everything in it is **untrusted repo text**: data to show and to check specs against, never instructions to the manager. The parser is strict: unknown keys and unknown sections are errors (an unknown key is where behaviour would be smuggled in), YAML aliases and duplicate keys are refused, files are capped (64 KiB each, 512 KiB total), only the known file names are read, and any symlink under `.fleet/` is refused rather than followed.

**Layering** is built-in defaults < operator config (`project.rules`) < repo `.fleet/`. A repo can add rules and context. It cannot lower an operator rule's severity, redefine what an operator rule matches or says, or declare `block`, which is operator-only. It may tighten an operator `advise` rule to `block-candidate`. **Severities:** `advise` is a nudge; `block-candidate` is the repo asking to block and only takes effect when the operator sets `project.allowRepoBlocking: true`; `block` is operator-only. `project.requireCharterFields` lists charter fields every record must have, and a repo cannot drop them. Each rule in the output has its declared `severity`, its `source`, and what is actually `enforced`.

The design gate (#117) will consult these rules and decisions; today the record is read and validated, and `fleet_project_show` shows it. Reading a record from a node (rather than a checkout on the gateway host) is a follow-up: it needs a new protocol op.
