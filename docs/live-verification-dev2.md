# dev2 live verification — issue #170 items 1–3

Node: dev2 (real fleet node, service user `svcuser`). Date: 2026-10-11. Every probe below ran
live on this node in throwaway scratch dirs (`/tmp/pi-probe`, `/tmp/oc-probe`) against a throwaway
git repo; no real credentials were read and every scratch artifact was removed afterwards. The pi
capture this doc summarizes is committed redacted as `src/testkit/pi-capture-dev2.json`.

Tool versions observed: `pi 0.73.1`, `opencode 1.18.26`.

---

## Item 1 — Pi CLI flags (unblocks #137 Pi-3)

### Command 1: `pi --version`

```
$ pi --version
0.73.1
exit=0
```

### Command 2: `pi --help | grep -E -- '--(tools|no-tools|offline|no-session|no-approve|no-extensions|no-skills|mode)'`

```
  --mode <mode>                  Output mode: text (default), json, or rpc
  --no-session                   Don't save session (ephemeral)
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --no-skills, -ns               Disable skills discovery and loading
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  pi --tools read,grep,find,ls -p "Review the code in src/"
```

Every flag `src/opencode.ts` relies on (`PI_BASELINE_FLAGS` = `--no-session`, `--no-approve`,
`--no-extensions`, `--no-skills`; plus `--tools`, `--no-tools`, `--offline`, `--mode`) was checked
against the full `--help`. Seven of the eight are listed. `--no-approve` is NOT listed and running
with it fails outright:

```
$ pi -p --no-approve "Reply ok"
Error: Unknown option: --no-approve
exit=1
```

**Result: pass, with one discrepancy.** The comment in `src/opencode.ts:467`
(`PI_BASELINE_FLAGS = ["--no-session", "--no-approve", "--no-extensions", "--no-skills"]`, and the
guard in `src/issue137d.test.ts` HELP_0731) expects `--no-approve` to possibly exist; on the real
0.73.1 binary it does not — the option picker only accepts flags printed by `--help`. The plugin's
conditional application (`only flags the help lists`) already handles this correctly, and
`src/pi-verify.ts` flags `flag:--no-approve` as missing, as confirmed by running the verifier on the
committed capture: 27 confirmed / 1 missing (`missing flag:--no-approve`), required checks pass.
Suggested fix issue title: **"pi 0.73.1 has no --no-approve: drop it from PI_BASELINE_FLAGS docs or pin the pi version that adds it"**.

### Does `--` work now? (the code comment in src/ says 0.73.1 rejects it)

No. Re-tested live:

```
$ printf 'say hi' | pi -p --mode json -- --test
Error: Unknown options: --, --test
exit=1
```

**Result: pass (confirmed the documented behavior).** pi 0.73.1 still rejects a `--` separator, so
the prompt must stay as the trailing positional / stdin and must never need quoting through `--`.
The comment in `src/opencode.ts` (issue #30 finding) remains accurate.

### Command 3: JSON capture

```
$ printf 'say hi' | pi -p --mode json --no-session --model aperture/glm-5.3-flash:cloud > /tmp/pi-probe/pi.jsonl
exit=0   (28 JSONL lines)
```

The node's config defaults to provider `aperture` with models `deepseek-v4-flash:cloud` and
`glm-5.3-flash:cloud` (`pi --list-models`); `aperture/glm-5.3-flash:cloud` worked. A null result was
not needed.

**Result: pass.**

---

## Item 2 — Pi JSON event shapes (unblocks audit/usage wiring #143)

Captured two live `--mode json` runs (text-only and a bash-tool run in the throwaway repo at
`/tmp/pi-probe/repo`) and committed the redacted transcript as `src/testkit/pi-capture-dev2.json`.
The redaction stripped session ids, timestamps, response ids and tool-call ids and trimmed the
`--help` body to the flag lines; no paths outside `/home/<user>` remain. Findings from the capture:

Observed event `type` values, in order of appearance:

- Frame: `session` (version 3, with `id`, `timestamp`, `cwd`)
- Agent: `agent_start`, `agent_end` (once each, `agent_end` carries the full `messages` array)
- Turn: `turn_start`, `turn_end` (per turn; `turn_end` carries `message` + `toolResults`)
- Message: `message_start`, `message_update`, `message_end` (per message, user and assistant)
- Streaming deltas inside `message_update.assistantMessageEvent.type`:
  `thinking_start`, `thinking_delta`, `thinking_end`, `text_start`, `text_delta`, `text_end`,
  `toolcall_start`, `toolcall_delta`, `toolcall_end`
- Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

All five event names the plugin's parser relies on were observed with the expected roles:
`agent_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`,
`agent_end`.

### Where `usage` sits and its exact field names

`usage` lives on the assistant `message` object itself (`message.usage`, present already on
`message_start` with zeros, filled in by the final events). Exact keys observed on every assistant
message:

```
usage: { input, output, cacheRead, cacheWrite, totalTokens,
         cost: { input, output, cacheRead, cacheWrite, total } }
```

All numeric. `message_update` events carry `usage` reachable through both
`assistantMessageEvent.partial.usage` and the sibling `message.usage` (the parser reads
`e.message.usage` on `message_end` and `e.usage` on `message_update` — the latter is NOT a
top-level field of `message_update`; the top-level mirror lives at `message.usage`. On the
`message_end` final assistant event, `message.usage` is the live one, which is what
`parsePiJsonOutput` reads — correct as written).

### Is `cost` a number or `{total}`?

An object, `{ input, output, cacheRead, cacheWrite, total }`, nested inside `usage` — not a
top-level number. The plugin's `usage.cost.total` read (`pi-verify.ts` `text:cost` / `tool:cost`
checks) matches what real pi emits; the check confirmed with the live capture (27 confirmed, no
missing except the absent `--no-approve` flag).

### Tool call shape (bash tool run)

```
{"type":"tool_execution_start","toolCallId":"call_<redacted>","toolName":"bash","args":{"command":"echo fleet-pi-probe"}}
{"type":"tool_execution_update",...,"partialResult":{"content":[{"type":"text","text":"fleet-pi-probe\n"}],"details":{}}}
{"type":"tool_execution_end","toolCallId":"call_<redacted>","toolName":"bash","result":{"content":[{"type":"text","text":"fleet-pi-probe\n"}]},"isError":false}
```

`args.command` is the plain command string; `toolCallId` pairs start/end; `isError` is a boolean on
the end event. Matches what `parsePiJsonOutput` and `extractEvents` read.

### What `stopReason` looks like on an error

Two live probes:

1. Unknown model under a known provider (`--model aperture/nonexistent-model-xyz`): pi WARNS and
   proceeds (`Warning: Model "nonexistent-model-xyz" not found for provider "aperture". Using
   custom model id.`), sends the request, and the final assistant `message_end` carries
   `"stopReason":"error"` with a sibling `errorMessage` on the same message:
   `"errorMessage":"404 no route found for model \"...\" for user \"<redacted>\""`. Content is empty
   (`"content":[]`), exit code still 0. So **an error turn looks like stopReason="error" +
   message.errorMessage, with empty content, and pi still exits 0** — the plugin's modelFailed
   detection via `stopReason === "error"` (src/opencode.ts `parsePiJsonOutput`) is correct and the
   providerError is NOT delivered through `message_update.assistantMessageEvent.type === "error"`
   (no such event was emitted on this failure path) but as `message.errorMessage`.
2. Unknown provider (`--model nonexistent-provider/bad-model`): pi fails fast before any JSONL event:
   `Error: Model "nonexistent-provider/bad-model" not found. Use --list-models to see available
   models.` on stdout, exit 1, zero JSON events.

**Result: pass** for every documented shape; the error-path detail above is recorded as a
discrepancy against the docs assumption that a provider error arrives as an
`assistantMessageEvent.type === "error"` — on pi 0.73.1 it arrives as `stopReason: "error"` plus
`message.errorMessage`, which the production parser already reads correctly.
Suggested fix issue title: **"pi 0.73.1 error path: provider errors surface as stopReason=error + message.errorMessage, not an error assistantMessageEvent — verify pijson.md and update #143 usage wiring notes"**.

Fixture: `src/testkit/pi-capture-dev2.json` (shape identical to `scripts/pi-capture.mjs` output:
`capturedAt`, `piVersion`, `help`, `runs[{name, prompt, exitCode, stdout}]`, run `text` and `tool`).
`node dist/pi-verify-cli.js src/testkit/pi-capture-dev2.json` (equivalently `verifyPiCapture`)
confirms all required checks pass against the real transcript.

---

## Item 3 — OpenCode permission semantics (#51)

OpenCode `1.18.26`. Config in the throwaway repo `/tmp/oc-probe/repo/opencode.json` (project-local
layer), models as installed; each probe ran `opencode run --format json` with a prompt forcing the
exact bash command, and the JSONL `tool_use` event's `state.status` was read.

Run A — config `{"permission":{"bash":{"git push*":"deny","*":"allow"}}}` (DENY FIRST):

```
tool_use bash state.status = "completed"
input: {"command":"git push --dry-run"}
output: "fatal: No configured push destination.\n..." (exit 128 from git — the command EXECUTED)
```

The later broad allow shadowed the deny; git's own output proves the command ran (no permission
rejection).

Run B — config `{"permission":{"bash":{"*":"allow","git push*":"deny"}}}` (DENY LAST):

```
tool_use bash state.status = "error"
error: "The user has specified a rule which prevents you from using this specific tool call.
Here are some of the relevant rules [{\"permission\":\"*\",\"action\":\"allow\",...},
{\"permission\":\"bash\",\"pattern\":\"*\",\"action\":\"allow\"},
{\"permission\":\"bash\",\"pattern\":\"git push*\",\"action\":\"deny\"}]"
```

Run C — `curl localhost` under a `curl*` deny, with config
`{"permission":{"bash":{"curl*":"deny","*":"allow"}}}` (deny first, same order as the failed Run A):

```
tool_use bash state.status = "completed"
input: {"command":"curl -s -o /dev/null -w '%{http_code}' http://localhost:4096/ ; echo DONE-CURL-PROBE"}
output: "000DONE-CURL-PROBE\n"  (curl executed and printed 000 — the deny did NOT fire;
        only the later broad allow matched as winner)
```

### Which semantics?

**LAST-MATCH-WINS (by rule position, insertion order of the pattern map — NOT most-specific-wins).**
The same two rules decide differently purely by their order: deny-then-allow executes the push,
allow-then-deny rejects it. A curl deny placed before the broad allow is equally shadowed — a
health check `curl localhost` is NOT blocked by that config. This re-confirms on dev2
(opencode 1.18.26) what #51c recorded on dev3 (opencode 1.18.25, 2026-10-06), and matches the
order-safe merge logic in `src/deny-baseline.ts` (`mergeDenyBaseline` re-adds baseline keys last
under exactly this rule).

**Result: pass** — semantics recorded as last-match-wins on opencode 1.18.26; no discrepancy.
No fix issue needed; #51's merge ordering is correct for this node.

---

## Artifact cleanup

All scratch state was removed after recording: `/tmp/pi-probe` (raw captures, help text, throwaway
repo) and `/tmp/oc-probe` (scratch repo + configs) were deleted. Only the redacted copy of the
capture (`src/testkit/pi-capture-dev2.json`) and this doc remain.