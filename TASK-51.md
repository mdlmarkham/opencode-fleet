# TASK #51 slice 2 — wire the deny-rule baseline into the fleet (issue #51, P1)

Node: dev2 · Branch to commit on: `fleet/dev2-51-deny-baseline` (base = master @ a31bed1)
Repo cwd on the node: `/home/svcuser/fleet/opencode-fleet`

## Context
Slice 1 already landed: `src/deny-baseline.ts` provides PURE helpers —
`BASELINE_DENY`, `mergeDenyBaseline(existing)`, `baselinePresent(nodeConfig)`,
`detectAutoSupport(probe)`. It has NO live wiring yet (only `src/issue51.test.ts`
imports it). This slice is the WIRING described in the issue's acceptance
checklist. Do NOT rewrite or weaken slice 1 — build on it.

## Required change (all MANAGER-side, in `src/`)

1. **`fleet_provision_config` installs the baseline (merge, never overwrite).**
   In `src/config-provision.ts`, when the operator opts in, read the node's
   existing `~/.config/opencode/opencode.json`, apply `mergeDenyBaseline()`, and
   write the merged JSON back. It must merge with existing config (never replace
   unrelated keys) and be idempotent. Give the request an explicit opt-in field
   (e.g. `installDenyBaseline?: boolean`) so default behavior is unchanged.

2. **`fleet_capabilities` reports whether the baseline is present.**
   In `src/capabilities.ts`, read the node's `~/.config/opencode/opencode.json`
   (the code ALREADY reads this file to list models — extend that path), parse
   it, and set a `denyBaseline` boolean on `NodeCapabilities` via
   `baselinePresent()`. Missing/unparseable config => `denyBaseline: false`.

3. **`fleet_dispatch` gates `autoApprove` on the baseline.**
   In `src/index.ts`, when `autoApprove === true`:
   - probe (or read from the capability detection) the node's opencode
     `--version` / `run --help` and use `detectAutoSupport()`; if the node's
     opencode does NOT support `--auto`, **refuse with a clear error** naming the
     node (never append an unparseable flag).
   - if the node lacks the deny baseline, still proceed (do not break existing
     flows) but include a warning string on the dispatch result, e.g.
     `warnings: ["node <n> has no deny baseline installed; autoApprove rests on the node's own rules"]`.
   Keep the existing `allowAutoApprove === false` refusal behavior intact.
   Keep all changes additive and default-behavior-preserving when `autoApprove`
   is not set.

## REQUIRED regression test
Add `src/issue51b.test.ts` (vitest, matching existing style), covering:
- `mergeDenyBaseline` is applied by the config-install path against a fixture
  node config: baseline denials present, unrelated keys preserved, idempotent.
- `detectNodeCapabilities`-shaped parsing sets `denyBaseline: true` for a config
  containing the baseline and `false` for a config lacking it / unparseable.
- The dispatch `autoApprove` gate refuses when `detectAutoSupport` is false and
  passes (with no refusal) when true. Prefer testing the extracted predicate —
  if the logic lives inline in `index.ts`, extract a small pure helper into
  `deny-baseline.ts` (e.g. `autoApproveGate(...)`) so it is unit-testable, and
  test THAT; do not spin up a live SSH node in tests.
- No network, no temp SSH; pure/unit-level where the existing suite is.

## House rules (MANDATORY)
- Edit files IN PLACE. Do NOT create a new branch and do NOT push — the manager
  pushes.
- Commit locally on branch `fleet/dev2-51-deny-baseline` **only when the FULL
  suite is green**.
- Run the FULL suite: `./scripts/verify.sh` (runs `npm run build` + `npx vitest
  run`). All tests must pass.
- Commit message: `feat(#51 slice 2): wire deny baseline into provision_config, capabilities, and dispatch`
- Do not touch unrelated files. If you must rename/move or change a public
  schema in a breaking way, STOP and raise a question instead.
- This is bounded: finish the wiring + the test, run the suite, commit. Do not
  start other issues.
