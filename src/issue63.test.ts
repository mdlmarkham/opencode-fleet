import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleOpencodeRun } from "./node/handler.js";
import { resolveAbortRunId, type LedgerEntry } from "./ledger.js";

describe("#63: abort never kills by name pattern", () => {
  it("node abort without a runId refuses, and does not signal anything", async () => {
    const r = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__ABORT__", op: "abort", cwd: "/", sessionId: "s1" })));
    expect(r).toMatchObject({ ok: false, aborted: false, sessionId: "s1" });
    expect(r.error).toMatch(/runId/);
  });

  it("the node handler no longer contains a pattern pkill/pgrep fallback", () => {
    const src = readFileSync(new URL("./node/handler.ts", import.meta.url), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/pkill -f/);
    expect(src).not.toMatch(/pgrep -f/);
  });

  it("fleet_abort asks the ledger resolver and requires some runId", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf('name: "fleet_abort"'), src.indexOf('name: "fleet_diff"'));
    expect(body).toContain("resolveAbortRunId");
    expect(body).toContain("runId required");
  });
});

const run = (runId: string, over: Partial<LedgerEntry>): LedgerEntry => ({
  runId, node: "dev2", cwd: "/w", harness: "opencode", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  state: "completed", sessionId: "s1", ...over,
} as LedgerEntry);

describe("#63: resolveAbortRunId", () => {
  it("prefers the newest non-terminal run, whatever order the ledger is stored in", () => {
    const old = run("old", { state: "completed", startedAt: "2026-01-01T00:00:00Z" });
    const live = run("live", { state: "timed-out", startedAt: "2026-01-02T00:00:00Z" });
    const live2 = run("live2", { state: "running", startedAt: "2026-01-03T00:00:00Z" });
    expect(resolveAbortRunId([old, live, live2], "s1", ["dev2"])).toBe("live2");
    expect(resolveAbortRunId([live2, live, old], "s1", ["dev2"])).toBe("live2");
    expect(resolveAbortRunId([old, live], "s1", ["dev2"])).toBe("live");
  });
  it("falls back to the newest match overall when none is in flight", () => {
    const a = run("a", { startedAt: "2026-01-01T00:00:00Z" });
    const b = run("b", { startedAt: "2026-01-05T00:00:00Z", state: "failed" });
    expect(resolveAbortRunId([a, b], "s1", ["dev2"])).toBe("b");
    expect(resolveAbortRunId([b, a], "s1", ["dev2"])).toBe("b");
  });
  it("never matches another node's or another session's run, and returns nothing without a match", () => {
    const other = run("x", { node: "dev3", state: "running" });
    const diffSession = run("y", { sessionId: "s2", state: "running" });
    expect(resolveAbortRunId([other, diffSession], "s1", ["dev2"])).toBeUndefined();
    expect(resolveAbortRunId([], "s1", ["dev2"])).toBeUndefined();
  });
});
