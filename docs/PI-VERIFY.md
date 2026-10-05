# Verifying Pi on a live node (issue #137)

Every Pi flag and JSON event name this plugin uses came from Pi's docs, not a live run. None of
them fails open if wrong (a missing baseline flag is simply not applied; a missing `--tools` /
`--offline` makes the dispatch refuse with exit 67; a renamed event loses commands/usage in the
audit manifest), but none is proven either. This is the one-pass check.

1. On a node where `pi` is installed and configured with a model:

   ```
   node scripts/pi-capture.mjs > pi-capture.json
   ```

   It runs two tiny prompts in a throwaway directory. The second makes Pi run
   `echo fleet-pi-probe` with its shell tool, so it calls the configured model and executes that
   one harmless command. `pi-capture.json` contains Pi's raw output: read it before sharing it.

2. Anywhere (pure, offline):

   ```
   npm run pi:verify -- pi-capture.json
   ```

   It prints, per assumption, `OK` / `MISSING` / `UNKNOWN` and what breaks in production while
   it stays unconfirmed. Exit 0 = every required check confirmed, 1 = a required check is
   missing, 2 = unreadable input.

Required checks: at least one captured run; `--mode json` produces JSONL; the final `message_end`
assistant message carries text; the production parser reads a non-empty summary; and, for the tool
run, `tool_execution_start` has `toolName`/`toolCallId`. Flags, usage/cost fields and `isError` are
reported but optional, because the plugin degrades safely without them.

The unit tests use synthetic, docs-shaped fixtures, so they prove the verifier discriminates
between a conforming and a drifted capture; only a capture from a real node proves Pi conforms.
Attach the report to #137 and #170.
