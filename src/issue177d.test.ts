import { describe, expect, it } from "vitest";
import { extractEvents } from "./audit.js";
import { contradictedClaims } from "./review-spawn.js";

const oc = (cmd: string, exit?: unknown) => JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { input: { command: cmd }, ...(exit !== undefined ? { metadata: { exit } } : {}) } } });

describe("#177: exit codes in the audit manifest", () => {
  it("opencode: records a numeric exit code only when the event carried one; absence is unknown, never 0", () => {
    const m = extractEvents([oc("npm test", 1), oc("npm run build", 0), oc("git status"), oc("ls", "0")].join("\n"), "opencode");
    expect(m.commands).toEqual([
      { tool: "bash", input: "npm test", exitCode: 1 },
      { tool: "bash", input: "npm run build", exitCode: 0 },
      { tool: "bash", input: "git status" },
      { tool: "bash", input: "ls" },
    ]);
  });
  it("pi: attaches an exit code from the matching tool_execution_end, defensively", () => {
    const ev = [
      { type: "agent_start" },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "npm test" } },
      { type: "tool_execution_end", toolCallId: "c1", result: { details: { exitCode: 2 } } },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c2", args: { command: "ls" } },
      { type: "tool_execution_end", toolCallId: "c2", result: { content: "x" } },
      { type: "tool_execution_end", toolCallId: "nope", result: { exitCode: 9 } },
    ].map((e) => JSON.stringify(e)).join("\n");
    const m = extractEvents(ev, "pi");
    expect(m.commands.map((c) => c.exitCode)).toEqual([2, undefined]);
  });
});

describe("#177: contradicted claims", () => {
  const manifest = [{ input: "git rev-parse HEAD", exitCode: 0 }, { input: "cd /w && npm test", exitCode: 1 }, { input: "npm run build" }];
  it("a claimed exit 0 for a command the manifest recorded as failing is contradicted", () => {
    expect(contradictedClaims([{ command: "npm test", exitCode: 0 }], manifest)).toEqual(["npm test (manifest exit 1)"]);
  });
  it("matching exits, unknown manifest exits, non-zero claims and unmatched commands contradict nothing", () => {
    expect(contradictedClaims([{ command: "git rev-parse HEAD", exitCode: 0 }, { command: "npm run build", exitCode: 0 }, { command: "npm test", exitCode: 1 }, { command: "other", exitCode: 0 }, { command: 5, exitCode: 0 }], manifest)).toEqual([]);
    expect(contradictedClaims([{ command: "npm test", exitCode: 0 }], [{ input: "npm test" }])).toEqual([]);
  });
});
