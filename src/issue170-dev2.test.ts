import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiJsonEvents, parsePiOutput } from "./opencode.js";
import { verifyPiCapture, type PiCapture } from "./pi-verify.js";

// Issue #170 (dev2): the LIVE pi 0.73.1 capture recorded on this node, redacted and committed as a
// fixture. Unlike the #137c synthetic docs-shaped fixtures, this transcript is what real pi printed
// on the node — these tests pin the shapes the production parsers rely on to what was observed.

const HERE = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(readFileSync(join(HERE, "testkit", "pi-capture-dev2.json"), "utf8")) as PiCapture;

describe("#170 dev2: the live pi capture fixture (src/testkit/pi-capture-dev2.json)", () => {
  it("parses as JSON with the pi-capture.mjs shape (help + text and tool runs)", () => {
    expect(capture.piVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof capture.help).toBe("string");
    expect(capture.runs.map((r) => r.name)).toEqual(["text", "tool"]);
    for (const r of capture.runs) {
      expect(r.exitCode, r.name).toBe(0);
      expect(r.stdout.trim().startsWith("{"), `${r.name} stdout is JSONL`).toBe(true);
    }
  });

  it("the capture succeeded: both runs carry the observed real event types", () => {
    const expectSeen = (run: string, types: string[]) => {
      const events = parsePiJsonEvents(capture.runs.find((r) => r.name === run)!.stdout);
      expect(events, `${run}: JSONL parses`).not.toBeNull();
      const seen = [...new Set(events!.map((e) => e.type))];
      for (const t of types) expect(seen, `${run}: ${t}`).toContain(t);
    };
    // Frame + agent + message events, on both runs.
    expectSeen("text", ["session", "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end"]);
    // A tool run additionally shows the tool_execution pair with a bash start/end.
    expectSeen("tool", ["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
    const start = capture.runs[1]!.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((e) => e.type === "tool_execution_start")!;
    expect(start.toolName).toBe("bash");
    expect(typeof start.toolCallId).toBe("string");
    expect(typeof start.args.command).toBe("string");
  });

  it("the live usage/cost/stopReason shapes the audit wiring (#143) reads are exactly as observed", () => {
    for (const run of capture.runs) {
      const events = parsePiJsonEvents(run.stdout)!;
      const last = [...events].reverse().find((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
      expect(last, `${run.name}: final assistant message_end`).toBeTruthy();
      const msg = (last as any).message;
      // usage sits on the message itself; numeric token counts
      for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        expect(typeof msg.usage[k], `${run.name}: usage.${k}`).toBe("number");
      }
      // cost is an OBJECT {input, output, cacheRead, cacheWrite, total}, not a number
      expect(typeof msg.usage.cost, `${run.name}: cost is an object`).toBe("object");
      expect(typeof msg.usage.cost.total, `${run.name}: cost.total`).toBe("number");
      expect(typeof msg.stopReason).toBe("string");
    }
  });

  it("production parsers succeed on the live transcript (summary, toolCalls, usage, stopReason)", () => {
    const toolRun = capture.runs.find((r) => r.name === "tool")!;
    const parsed = parsePiOutput(toolRun.stdout, { exitCode: 0 });
    expect(parsed.harness).toBe("pi");
    expect(parsed.toolCalls?.map((c) => c.tool) ?? []).toContain("bash");
    expect(parsed.usage).toBeTruthy();
    expect(parsed.stopReason).toBe("stop");
  });

  it("the built-in verifier passes every required check against the live capture", () => {
    const report = verifyPiCapture(capture);
    expect(report.ok, report.checks.filter((c) => c.required && c.status !== "confirmed").map((c) => c.id).join(",")).toBe(true);
    // The one known discrepancy stays visible: pi 0.73.1 does not have --no-approve.
    expect(report.checks.find((c) => c.id === "flag:--no-approve")!.status).toBe("missing");
  });

  it("the fixture is redacted: no absolute svcuser paths, session ids or emails remain", () => {
    const raw = readFileSync(join(HERE, "testkit", "pi-capture-dev2.json"), "utf8");
    expect(raw).not.toContain("/home/svcuser");
    expect(raw).not.toContain("@");
    expect(raw).not.toContain(/"[0-9a-f-]{36}"/.source.replace(/\\\//g, "/"));
  });
});

describe("#170 dev2: the verification doc covers all three items and the found semantics", () => {
  const doc = readFileSync(join(HERE, "..", "docs", "live-verification-dev2.md"), "utf8");

  it("names items 1, 2 and 3 with their issue pointers", () => {
    for (const [item, issue] of [["Item 1", "#137"], ["Item 2", "#143"], ["Item 3", "#51"]] as const) {
      expect(doc, `${item} pointer to ${issue}`).toContain(item);
      expect(doc, `${item} pointer to ${issue}`).toContain(issue);
    }
  });

  it("records the opencode permission semantics found in item 3: last-match-wins, not most-specific-wins", () => {
    expect(doc).toMatch(/last-match-wins/i);
    expect(doc).toMatch(/not most-specific-wins/i);
  });

  it("carries the pass/discrepancy outcomes for every item", () => {
    expect(doc).toContain("**Result: pass");
    expect(doc).toContain("-no-approve");
    expect(doc).toContain("last-match-wins");
  });
});