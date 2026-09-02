# opencode-fleet

Orchestrate **OpenCode** across multiple remote OpenClaw nodes (dev2, dev3, ...) over the authenticated node channel.

The **manager** (Main/Metis) holds GitHub credentials and model routing. **Workers** (dev2/dev3) stay credential-free — they receive repos via git bundles and never touch GitHub or hold PATs.

## Features

### Dispatch & monitoring
- **`fleet_dispatch`** — send an OpenCode coding task to one or more nodes, with per-task model allocation and capability-constraint routing (`requires: {gpu, minDiskGb, minMemGb, tools, models}`)
- **`fleet_watch`** — dispatch + live monitoring: streams progress to the agent, polls node activity, returns the final result when done
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
- **`fleet_cleanup`** — keep nodes tidy: remove stale bundles, git gc, report disk usage

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
| `nodePrefixes` | `["dev"]` | Node display-name prefixes treated as fleet members |
| `defaultTimeoutMs` | `300000` | Default timeout for OpenCode runs |
| `apertureUrl` | `https://ai.tailf9480.ts.net/v1/models` | Aperture model catalog URL |

## Development

```bash
npm run build        # tsc
npm pack             # create tarball
# install tarball on gateway + nodes, restart node services + gateway
```

Or use the built-in deploy: `fleet_deploy` (or the `deployPlugin` module) does build → pack → install on gateway + nodes → restart node services, and reports `gatewayRestartRequired` for the final gateway restart.

## Key implementation notes

- **Node invoke inactivity timeout**: long-running node commands that produce no output for ~11s get killed. The node host command's `handle` must emit progress chunks via `io.emitChunk()` to keep the invoke alive.
- **`opencode acp` has no `--model` flag** — model selection is config-scoped on the node, not per-prompt.
- **Repo bundles must be full clones** (no `--depth 1`) or the worker can't traverse history.
- **Use light `git gc`** — `--aggressive` is too slow for large repos and leaves stale locks.
- **Gateway restart kills the session** running the deploy — `fleet_deploy` does everything except the final gateway restart and reports it.
