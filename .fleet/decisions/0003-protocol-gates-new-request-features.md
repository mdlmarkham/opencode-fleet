---
schemaVersion: 1
id: "0003"
title: New request features are gated by node protocol
status: accepted
date: 2026-10-04
scope: [src/protocol.ts, src/gateway-policy.ts]
---

## Context

A node that predates a feature ignores its field and runs the task as if it were absent, which is a silent downgrade (no isolation, no verification gate, unrestricted Pi).

## Decision

A request's `protocol` is the minimum node protocol it needs, stamped only after discovery. A feature an older node would drop gets a FEATURE_MIN_PROTOCOL entry so the gateway refuses instead.

## Alternatives rejected

- Stamping protocol on every request (the #76 revert: it broke older nodes and poisoned the probe).

## Consequences

Every new request feature needs a protocol bump and an older-node test.
