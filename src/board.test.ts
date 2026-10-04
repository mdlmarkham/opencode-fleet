import { describe, expect, it } from "vitest";
import { classify, issueFromEntry, renderBoard } from "./board.js";
import type { LedgerEntry } from "./ledger.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
function entry(o: Partial<LedgerEntry>): LedgerEntry {
  return {
    runId: "run-1",
    node: "dev2",
    cwd: "/w",
    prompt: "fix #104 the spec",
    startedAt: "2026-10-04T11:55:00Z",
    updatedAt: "2026-10-04T11:55:00Z",
    state: "running",
    ...o,
  } as LedgerEntry;
}

describe("issue #: fleet_board classification", () => {
  it("extracts the issue number from a run's prompt", () => {
    expect(issueFromEntry(entry({ prompt: "implement #104 exactly" }))).toBe(104);
    expect(issueFromEntry(entry({ prompt: "no issue here" }))).toBeUndefined();
  });

  it("a running run is in-flight; one with no completion after the window is stale", () => {
    const fresh = classify(entry({}), NOW, 45 * 60_000);
    expect(fresh.bucket).toBe("in-flight");
    expect(fresh.verified).toBeNull();
    const old = classify(entry({ startedAt: "2026-10-04T10:00:00Z" }), NOW, 45 * 60_000);
    expect(old.bucket).toBe("stale");
  });

  it("a FAILED verification gate needs a human, never reads as landed", () => {
    const r = classify(entry({ state: "failed-verification", verified: false }), NOW);
    expect(r.bucket).toBe("needs-you");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/FAILED/);
  });

  it("a hand-raise needs a human", () => {
    expect(classify(entry({ handRaised: true }), NOW).bucket).toBe("needs-you");
  });

  it("completed is landed; failed is failed", () => {
    expect(classify(entry({ state: "completed", verified: true }), NOW).bucket).toBe("landed");
    expect(classify(entry({ state: "failed" }), NOW).bucket).toBe("failed");
  });

  it("renders a board that hides landed by default and summarises in the header", () => {
    const entries: LedgerEntry[] = [
      entry({ runId: "run-needs", state: "failed-verification", verified: false, prompt: "fix #7" }),
      entry({ runId: "run-flight", prompt: "do #9" }),
      entry({ runId: "run-done", state: "completed", verified: true, prompt: "fix #8" }),
    ];
    const { text, counts } = renderBoard(entries, { now: NOW });
    expect(counts.landed).toBe(1);
    expect(counts["needs-you"]).toBe(1);
    expect(counts["in-flight"]).toBe(1);
    expect(text).toContain("1 in-flight");
    expect(text).toContain("needs-you");
    expect(text).not.toContain("run-done"); // landed hidden by default
    // with includeLanded the completed row shows
    const all = renderBoard(entries, { now: NOW, buckets: ["needs-you", "stale", "failed", "in-flight", "landed"] });
    expect(all.text).toContain("run-done");
  });

  it("says so plainly when nothing needs attention", () => {
    const { text } = renderBoard([entry({ state: "completed", verified: true })], { now: NOW });
    expect(text).toContain("nothing needs attention");
  });
});
