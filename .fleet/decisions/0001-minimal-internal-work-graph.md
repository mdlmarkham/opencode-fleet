---
schemaVersion: 1
id: "0001"
title: Minimal internal work graph, no external task tracker
status: accepted
date: 2026-10-04
scope: [src/tasks.ts]
---

## Context

Missions need a work graph (specs, dependencies, claims, retries). Options were an external tracker such as Beads, GitHub issues as the store, or something internal.

## Decision

A small internal `TaskTracker` over an append-only journal, with GitHub as a projection and never on the critical path.

## Alternatives rejected

- Beads: judged too messy, and a second store to keep consistent with the run ledger and audit manifest.
- GitHub issues as the source of truth: rate limits, no atomic claim, and the fleet must work offline.

## Consequences

The graph changes atomically with the things the fleet already owns. We must not grow it into a general tracker (issue #132 lists what we will not build).
