# Verifying opencode on a live node (issues #111, #137, #243)

The plugin relies on opencode flags, event shapes and config paths that were taken from docs, not a
live run. One capture and one command settle them (mirror of `docs/PI-VERIFY.md`).

```sh
# on the node, as the service user, where `opencode` is installed
node scripts/opencode-capture.mjs > opencode-capture.json

# anywhere (pure, offline)
npm run build && node dist/opencode-verify-cli.js opencode-capture.json
```

The capture runs non-model probes (`--version`, `--help`, `run --help`, `acp --help`, `agent list`,
`debug paths`, `debug skill`) in a throwaway project containing a project-local agent and skill, lists
the candidate global agent/skill directories, and makes **one model call** that runs the harmless
`echo fleet-oc-probe` with `--format json`. That call uses the node's configured model and credentials.
Review the JSON before sharing it.

What it settles, each as `confirmed`, `missing` or `unverifiable` (the capture could not speak to it;
never treated as confirmed):

| Check | Why it matters |
|---|---|
| `run --model/--agent/--format/--auto` | flags `buildOpenCodeCommand` passes (required except `--agent`) |
| `acp` has no `--auto` | the autoApprove guard on acp |
| `events.tool_use` | manifest commands and the #177 reviewer cross-check (required) |
| `events.exit-code` | `state.metadata.exit`: without it the exit-code contradiction check (#243) is inert |
| `events.step_finish` | token/cost accounting |
| `agents.project-local`, `skills.project-local`, `paths.global` | where roles and per-run skills would be installed (#110, #111) |

Exit code 0 = every required check confirmed, 1 = one is missing, 2 = bad input. A `missing` exit-code
check means the real field name differs: update `src/audit.ts` (`extractEvents`) to match.
