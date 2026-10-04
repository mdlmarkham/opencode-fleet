---
schemaVersion: 1
id: "0002"
title: S1 decisions are evidence, never permission
status: accepted
date: 2026-10-04
scope: [src/decision.ts, src/decision-backends.ts, src/s1-hooks.ts, src/s1-shadow.ts]
---

## Context

The Jev/Kev decision service can rate commands, outputs and routing. A model verdict could be treated as authority.

## Decision

S1 output is recorded as evidence and can only add caution. Static rules always stay in force and the combination fails closed. Default mode is shadow; egress to a non-loopback backend needs an explicit allow and redaction.

## Alternatives rejected

- Letting a high-confidence S1 verdict override a static deny.
- Sending unredacted text to hosted backends on the assumption they are trusted.

## Consequences

Enforcement needs a calibrated threshold from a real run (#78) and a model-change downgrade to shadow.
