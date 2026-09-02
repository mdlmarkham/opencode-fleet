---
name: opencode-fleet
description: Orchestrate OpenCode across remote OpenClaw worker nodes (dev2, dev3, ...) as a credential-free fleet. Use for large refactors, parallel coding work, testing on real infra, or any task needing a clean repo checkout on a worker. The manager (main) holds GitHub credentials; workers get repos via git bundles and never touch GitHub.
metadata:
  openclaw:
    requires:
      config: ["plugins.entries.opencode-fleet.enabled"]
---

# OpenCode Fleet

Orchestrate OpenCode across remote OpenClaw worker nodes (dev2, dev3, ...) over the authenticated node channel.

**The model:** the **manager** (main) holds GitHub credentials and model routing. **Workers** (dev2/dev3) stay credential-free — they receive repos via git bundles and never touch GitHub or hold PATs.

## When to use

Use the fleet for:
- **Large refactors** or multi-file changes that benefit from a clean checkout
- **Parallel work** — dispatch independent tasks to multiple nodes concurrently
- **Testing on real infra** — run code on dev2/dev3, not just locally
- **Anything needing a clean repo** — provision a fresh checkout, work, sync back

Do **NOT** use the fleet for:
- Simple edits or read-only lookups that fit in a single agent turn
- Work that must stay on the manager (secrets, credentials, private state)
- Anything inside `~/.openclaw` or active OpenClaw state dirs

## Fleet vs. local coding-agent skill

There are two ways to delegate coding work. Pick deliberately:

| | `opencode-fleet` (this skill) | `coding-agent` skill |
|---|---|---|
| Where the worker runs | Remote nodes (dev2/dev3) | Local gateway host |
| Repo access | Credential-free via git bundle | Local checkout/worktree |
| Best for | Multi-node, parallel, real-infra testing | Single local worker, PR review |
| Model routing | Aperture catalog, per-task | Local provider config |

Use **fleet** when the work benefits from remote/parallel execution or a clean
provisioned checkout. Use **coding-agent** for a single local background worker.
Do not use the legacy `opencode-management` / `opencode-parallel` skills — they
are archived and superseded by this plugin.

## The workflow

Follow this order. The manager (main) does provisioning and syncing (it has the credentials); worker agents dispatch.

### 1. Provision the repo (manager)
```text
fleet_provision(repo: "<git-url>", cwd: "<target-dir>", nodes: ["dev2", ...])
```
The manager clones the repo (with its own credentials), ships a git bundle to the node, and the node unpacks it — **no worker credentials needed**.

### 2. Provision config (manager, optional)
```text
fleet_provision_config(nodes: ["dev2", ...])
```
Ships OpenCode agent definitions, global rules (AGENTS.md), skills, and opencode.json so workers work consistently with the manager.

### 3. Dispatch the task (worker agent)
```text
fleet_dispatch(prompt: "<task>", cwd: "<provisioned-dir>", nodes: ["dev2"], model: "<model-ref>", requires: {...})
```
- `model` — allocate a specific LLM (e.g. `aperture-anthropic/deepseek-v4-flash:cloud`). HTTP transport supports per-task `--model`; ACP is config-scoped.
- `requires` — filter nodes by capability (gpu, minDiskGb, minMemGb, tools, models) so work routes to nodes that can handle it.

### 4. Monitor
```text
fleet_status        # node health + connectivity
fleet_capabilities  # CPU/RAM/disk/GPU/tools/models per node
fleet_models        # available models + pricing
```

### 5. Sync back (manager)
```text
fleet_sync(node: "dev2", cwd: "<dir>", repo: "<git-url>", branch: "main")
```
The worker bundles its changes; the manager pulls and pushes to GitHub with its own credentials.

### 6. Cleanup (periodic)
```text
fleet_cleanup(nodes: ["dev2", "dev3"], cwd: "<dir>")
```
Removes stale bundles, runs git gc, reports disk usage. Run periodically to keep nodes tidy.

## Hard rules

- **Always provision before dispatch** — never dispatch to a node that doesn't have the repo.
- **Always sync back** after worker changes — the manager owns the GitHub push.
- **Never put credentials on workers** — the manager does all GitHub I/O.
- **Use capability routing** when nodes diverge (GPU, disk, models).
- **Run cleanup periodically** — workers accumulate bundles and git bloat.
- **Model refs must exist on the node** — check `fleet_models` first.

## Transports

| Transport | When | Model |
|---|---|---|
| **HTTP** (`opencode run`) | Fire-and-forget batch dispatch | Per-task `--model` |
| **ACP** (`opencode acp`) | Full-featured path (MCP, AGENTS.md rules, terminal) | Config-scoped on node |

## Tools

`fleet_dispatch`, `fleet_status`, `fleet_capabilities`, `fleet_abort`, `fleet_diff`, `fleet_models`, `fleet_provision`, `fleet_provision_config`, `fleet_sync`, `fleet_cleanup`
