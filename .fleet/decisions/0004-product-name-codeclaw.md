---
schemaVersion: 1
id: "0004"
title: The product is named CodeClaw; the plugin id stays opencode-fleet until a gated migration
status: accepted
date: 2026-10-07
scope: [README.md, docs/, skills/, openclaw.plugin.json, src/index.ts]
---

## Context

The project began as an OpenCode-only dispatcher across remote nodes, and was named for that: `opencode-fleet` named the **mechanism** (a fleet of OpenCode workers on nodes). The product has since outgrown the name:

- The engine seam is already plural — `harness: "opencode" | "pi"`, with `#45` (engine-agnostic architecture) tracking Claude Code, Copilot CLI, Codex and others. A second engine makes "opencode-" a misnomer.
- The centre of gravity has moved from *dispatching runs* to *workshopping a spec, running gated loops against rubrics, and pushing back on under-defined work* (the design gate, the readiness rubric, missions). "Fleet" describes the transport; the product is the **doing**.

The rename has been considered twice before (`2026-10-02`: `ClawFleet` vs `ClawCoder`) and settled neither time. This record settles it: the product is **CodeClaw** — it *does coding*, as a Claw, and the name survives engine and topology changes.

## Decision

**Adopt "CodeClaw" as the product name now; keep the plugin id `opencode-fleet` until a gated migration.**

Two classes of string, deliberately separated:

1. **Display surface** — README, docs, the skill description, the manifest `name`/`description`, how the product is described. **Renamed now.** Cheap, reversible, no runtime effect.
2. **Identity surface** — the plugin `id`, the npm package name, `plugins.entries.opencode-fleet.config`, the install path `~/.openclaw/extensions/opencode-fleet`, the state dir `.opencode-fleet/`, the tarball name, and the tool-schema prefix. **NOT renamed here.** These are config keys and filesystem identity across a mixed-version fleet.

## Alternatives rejected

- **Big-bang rename (id included, now).** The id is a config key, an install path, and fleet-wide identity. Renaming it without a migration means old nodes and new nodes disagree on the id — the silent-downgrade failure class ADR 0003 exists to prevent (a node that does not recognise the id does not error; it simply runs without the plugin's features). It would also break `plugins.entries.opencode-fleet.config` in the operator's `openclaw.json` and every `agents.entries.*.tools.allow` entry naming `fleet_*` tools scoped by plugin.
- **Keep `opencode-fleet`.** The name would increasingly describe neither the engines nor the capability. `#45` in particular would make the top-level name wrong the moment a second engine shipped.
- **`ClawFleet`** (the 2026-10-02 leaning). Emphasises the fleet/orchestration — the mechanism, which is the part we are de-emphasising. `CodeClaw` emphasises the capability.

## Consequences

- The **display rename ships as its own small PR** (docs + manifest `name`/`description` + skill description), with no behavioural change.
- The **id migration is a separate, gated work item**: dual-id acceptance (the plugin loads under both ids for one release), a migration note that rewrites `plugins.entries.opencode-fleet` → `.codeclaw` in the operator config, the install-path and state-dir move, and a node-protocol bump with an older-node test showing a node that does not recognise the new id **refuses rather than silently runs degraded** (ADR 0003's rule, applied to a rename).
- Until the migration lands, **the id is `opencode-fleet` and the product name is CodeClaw**; docs state both so an operator is never surprised by the id in their config.
