import { describe, expect, it } from "vitest";
import { renderBoard } from "./board.js";
import type { LedgerEntry } from "./ledger.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
function entry(o: Partial<LedgerEntry>): LedgerEntry {
  return {
    runId: "run-1",
    node: "dev2",
    cwd: "/w",
    prompt: "work",
    startedAt: "2026-10-04T11:55:00Z",
    updatedAt: "2026-10-04T11:55:00Z",
    state: "running",
    ...o,
  } as LedgerEntry;
}

describe("issue #295: terminal-run SUMMARY line in the fleet_board header", () => {
  it("an empty ledger reports 0/0/0", () => {
    const { text } = renderBoard([], { now: NOW });
    expect(text).toContain("history: 0 completed, 0 failed, 0 failed-verification");
  });

  it("one completed, one failed and one failed-verification report 1/1/1", () => {
    const entries: LedgerEntry[] = [
      entry({ runId: "run-done", state: "completed", verified: true }),
      entry({ runId: "run-fail", state: "failed" }),
      entry({ runId: "run-gate", state: "failed-verification", verified: false }),
    ];
    const { text } = renderBoard(entries, { now: NOW });
    expect(text).toContain("history: 1 completed, 1 failed, 1 failed-verification");
  });

  it("a landed run shows in the body only with includeLanded, and the summary does not change the body rendering", () => {
    const landed = entry({ runId: "run-done", state: "completed", verified: true });
    const inFlight = entry({ runId: "run-flight", state: "running" });

    const hidden = renderBoard([landed, inFlight], { now: NOW });
    expect(hidden.text).toContain("history: 1 completed, 0 failed, 0 failed-verification");
    expect(hidden.text).not.toContain("run-done"); // landed still hidden by default
    expect(hidden.text).toContain("run-flight"); // non-landed rows render as before

    const onlyLanded = renderBoard([landed], { now: NOW });
    expect(onlyLanded.text).toContain("history: 1 completed, 0 failed, 0 failed-verification");
    expect(onlyLanded.text).toContain("(nothing needs attention)");

    const shown = renderBoard([landed, inFlight], {
      now: NOW,
      buckets: ["needs-you", "stale", "failed", "in-flight", "landed"],
    });
    expect(shown.text).toContain("history: 1 completed, 0 failed, 0 failed-verification");
    expect(shown.text).toContain("[landed] #? run-done opencode dev2 5m state=completed verified=✓"); // body line format unchanged

    // Body line format is byte-identical to the existing rendering: bucket then runId.
    expect(shown.text.split("\n")[2]).toMatch(/^\[landed\] #\? run-done /);
  });
});