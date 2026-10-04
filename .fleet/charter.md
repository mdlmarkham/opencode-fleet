---
schemaVersion: 1
name: opencode-fleet
---

## Goal

An OpenClaw plugin that lets agents run a distributed fleet of coding agents (OpenCode, Pi, later others) on remote nodes with minimal supervision, and trust the results.

## Users

- OpenClaw agents that dispatch and supervise work.
- The operator who owns the gateway, the nodes and their policy.

## Constraints

- Workers are credential-free; secrets never leave a node or reach an agent unredacted.
- Nodes run mixed plugin versions; a new request feature an older node would silently ignore needs a protocol gate.
- Fail closed: unknown state is never success.
- S1 (Jev/Kev) decisions are evidence, never permission.

## Non-goals

- A general issue tracker (the internal work graph is a state machine for missions, with GitHub as a projection).
- Adopting an external task tracker such as Beads.
- A model call on the cheap path: the design gate is deterministic.

## Success criteria

- An unattended run can be audited from its manifest alone.
- A dispatched spec is verified by a gate the worker cannot satisfy by assertion.
- A repo can add project rules but cannot weaken the operator's.

## Riskiest assumptions

- Pi's CLI flags and JSON event shapes match its documentation on the nodes in use.
- Mixed-version fleets stay common enough that protocol gating pays for itself.
