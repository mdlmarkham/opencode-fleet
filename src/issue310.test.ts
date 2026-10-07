import { describe, expect, it } from "vitest";
import { renderBoard, shortRunId } from "./board.js";
import type { LedgerEntry } from "./ledger.js";

const FULL = "run-011629d6-d720-4345-badb-8b4a1377698c"; // the id from the issue: 41 chars
const entry = (runId: string, o: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ runId, node: "dev2", cwd: "/w", prompt: "p", startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString(), state: "running", ...o }) as LedgerEntry;

describe("#310: the board never shows a truncated id that looks complete", () => {
  it("a long id is visibly abbreviated (with …) and keeps a distinguishing suffix", () => {
    const s = shortRunId(FULL);
    expect(s).toContain("…");
    expect(s.length).toBeLessThanOrEqual(25);
    expect(s.endsWith(FULL.slice(-8))).toBe(true);
    expect(s).not.toBe(FULL.slice(0, 20)); // the old, misleading rendering
  });
  it("a short id is unchanged", () => {
    expect(shortRunId("run-abc123")).toBe("run-abc123");
    expect(shortRunId("x".repeat(20))).toBe("x".repeat(20));
    expect(shortRunId("x".repeat(21))).toContain("…");
  });
  it("two ids sharing a 20-char prefix render distinguishably", () => {
    const a = "run-011629d6-d720-4345-badb-aaaaaaaaaaaa", b = "run-011629d6-d720-4345-badb-bbbbbbbbbbbb";
    expect(a.slice(0, 20)).toBe(b.slice(0, 20));
    expect(shortRunId(a)).not.toBe(shortRunId(b));
  });
  it("the rendered line carries the abbreviated id, and the structured runs carry the FULL id", () => {
    const { text, runs } = renderBoard([entry(FULL)]);
    expect(text).toContain(shortRunId(FULL));
    expect(text).not.toContain(FULL);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: FULL, node: "dev2", state: "running", bucket: "in-flight" });
  });
  it("only the visible rows are returned, in the board's order", () => {
    const { runs } = renderBoard([entry("run-1"), entry("run-2", { state: "completed", finishedAt: new Date().toISOString() } as never)]);
    expect(runs.map((r) => r.runId)).toEqual(["run-1"]);
  });
});
