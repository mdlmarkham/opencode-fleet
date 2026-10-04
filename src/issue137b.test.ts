import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCodeCommand, parsePiJsonEvents, parsePiOutput, validatePiOptions } from "./opencode.js";

const J = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join("\n") + "\n";
const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const happy = J(
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: `echo ${SECRET}` } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false },
  { type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "a.ts" } },
  { type: "tool_execution_end", toolCallId: "c2", toolName: "read", isError: true },
  { type: "message_update", usage: { input: 10, output: 5 } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All done." }], stopReason: "end_turn", usage: { input: 12, output: 6 } } },
  { type: "agent_end", messages: [], willRetry: false },
);

describe("#137 Pi-1: --mode json parsing", () => {
  it("extracts final message, tool calls, usage, stopReason", () => {
    const r = parsePiOutput(happy, { exitCode: 0 });
    expect(r).toMatchObject({ ok: true, harness: "pi", summary: "All done.", stopReason: "end_turn", usage: { input: 12, output: 6 } });
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls?.[0]).toMatchObject({ tool: "bash" });
    expect(r.toolCalls?.[1]).toMatchObject({ tool: "read", isError: true, input: '{"path":"a.ts"}' });
  });
  it("redacts secrets in recorded commands", () => {
    expect(JSON.stringify(parsePiOutput(happy, { exitCode: 0 }))).not.toContain(SECRET);
  });
  it("HAND_RAISE comes from the final message", () => {
    const raw = J({ type: "agent_start" }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "HAND_RAISE: which db?" }], stopReason: "end_turn" } });
    expect(parsePiOutput(raw, { exitCode: 0 })).toMatchObject({ handRaised: true, question: "which db?" });
  });
  it("exit code, timeout and stopReason error still fail the run", () => {
    expect(parsePiOutput(happy, { exitCode: 3 }).ok).toBe(false);
    expect(parsePiOutput(happy, { timedOut: true }).ok).toBe(false);
    const bad = J({ type: "agent_start" }, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
    expect(parsePiOutput(bad, { exitCode: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("stopReason error") });
    const prov = J({ type: "agent_start" }, { type: "message_update", assistantMessageEvent: { type: "error", reason: "rate limited" } });
    expect(parsePiOutput(prov, { exitCode: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("rate limited") });
  });
  it("plain text and garbage fall back to the existing path", () => {
    expect(parsePiJsonEvents("just words\n{not json\n")).toBeNull();
    const r = parsePiOutput("just words", { exitCode: 0 });
    expect(r).toMatchObject({ ok: true, summary: "just words" });
    expect(r.toolCalls).toBeUndefined();
  });
  it("odd shapes never throw", () => {
    const raw = J({ type: "agent_start" }, { type: "tool_execution_start", toolName: "x", args: 5 }, { type: "message_end", message: null }, { type: "message_update", usage: [1] });
    expect(() => parsePiOutput(raw, { exitCode: 0 })).not.toThrow();
  });
});

describe("#137 Pi-1: piJson flag", () => {
  const fake = (flags: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fakepi-"));
    writeFileSync(join(dir, "pi"), `#!/bin/bash\nif [ "$1" = "--help" ]; then echo "${flags}"; exit 0; fi\necho "ARGV: $*"\n`);
    chmodSync(join(dir, "pi"), 0o755);
    return dir;
  };
  const run = (piJson: boolean, flags: string) =>
    spawnSync("bash", ["-c", buildOpenCodeCommand({ prompt: "p", cwd: "/tmp", transport: "http", harness: "pi", piModel: "a/b", ...(piJson ? { piJson } : {}) })], { env: { ...process.env, PATH: `${fake(flags)}:${process.env.PATH}` }, encoding: "utf8" }).stdout;
  it("adds --mode json only when asked and supported", () => {
    expect(run(true, "--mode")).toContain("--mode json");
    expect(run(true, "--no-session")).not.toContain("--mode json");
    expect(run(false, "--mode")).not.toContain("--mode json");
  });
  it("validates the type", () => {
    expect(validatePiOptions({ piJson: "yes" } as never)).not.toBeNull();
  });
});
