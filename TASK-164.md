# TASK #164 — align the #105 isolation-gate probe host with the cwd probe

## Problem
`entryHostForCaps = remoteIp ?? sshHost` (src/index.ts ~line 647) can diverge from
the pre-existing cwd probe, which uses `sshHost` (`loginUser@nodeKey` when a login
user is set). When `loginUser` is set and `remoteIp` is absent, the gate probes a
different host string than the cwd check. Fail-closed today, but it can MIS-REPORT
and refuse a genuinely-capable node.

## Required change
- In `src/index.ts`, align the isolation gate's probe host/user path with the cwd
  probe's: use `sshHost` + `svcUser` (do NOT prefer `remoteIp`). Keep fail-closed
  behaviour unchanged.
- Optional (secondary, same fix): give a distinct diagnostic for "node unreachable"
  vs "level unsupported" in the refusal message. Only if small and safe.
- Edit in place. Do not refactor unrelated code. Do not change the public tool I/O
  contract (no new required params).

## Required regression test
Add a test that FAILS before the fix and PASSES after: construct the state where
`loginUser` is set and `remoteIp` is absent, and assert the gate probes the SAME
host string the cwd probe uses (sshHost). A test that passes both ways is rejected.

## House rules
- Run the FULL suite (`npm test`) — all green before committing.
- Run `npm run build`.
- Commit ONCE on branch `fleet/dev2-164-probe-host` when green. Do NOT push.
- Reference #164 in the commit message.
