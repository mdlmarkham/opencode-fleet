# opencode-fleet

Orchestrate **OpenCode** across multiple remote OpenClaw nodes (dev2, dev3, ...) over the authenticated node channel.

The **manager** (Main/Metis) holds GitHub credentials and model routing. **Workers** (dev2/dev3) stay credential-free — they receive repos via git bundles and never touch GitHub or hold PATs.

## Features

- **`fleet_dispatch`** — send an OpenCode coding task to one or more nodes, with per-task model allocation
- **`fleet_status`** — node health + connectivity
- **`fleet_abort`** / **`fleet_diff`** — session control
- **`fleet_models`** — query the Aperture model catalog (pricing/context) so the agent picks the right model per task
- **`fleet_provision`** — provision a repo to workers **without giving them GitHub credentials** (git bundle transport)
- **`fleet_sync`** — pull worker changes back and push to GitHub with manager credentials
- **`fleet_cleanup`** — keep nodes tidy: remove stale bundles, git gc, report disk usage

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

## Key implementation notes

- **Node invoke inactivity timeout**: long-running node commands that produce no output for ~11s get killed. The node host command's `handle` must emit progress chunks via `io.emitChunk()` to keep the invoke alive.
- **`opencode acp` has no `--model` flag** — model selection is config-scoped on the node, not per-prompt.
- **Repo bundles must be full clones** (no `--depth 1`) or the worker can't traverse history.
- **Use light `git gc`** — `--aggressive` is too slow for large repos and leaves stale locks.
