import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_TERMINAL_CAP, capLedger, ledgerPath, loadLedger, outcomeEntry, upsertRun, type LedgerEntry } from "./ledger.js";

const entry = (i: number, state: LedgerEntry["state"] = "running", startedAt?: string): LedgerEntry => ({
  runId: `run-${i}`, node: "dev2", cwd: "/home/u/p", prompt: `task ${i}`,
  startedAt: startedAt ?? new Date(1_700_000_000_000 + i * 1000).toISOString(),
  updatedAt: new Date().toISOString(), state,
});

async function scratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fleet37-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("issue #37: concurrent upserts are serialized", () => {
  it("keeps every entry when 50 upserts race (fan-out dispatch)", async () => {
    await scratch(async (dir) => {
      await Promise.all(Array.from({ length: 50 }, (_, i) => upsertRun(dir, entry(i))));
      const runs = await loadLedger(dir);
      expect(new Set(runs.map((r) => r.runId)).size).toBe(50);
    });
  });
  it("concurrent updates to the same run converge on the last write, no lost others", async () => {
    await scratch(async (dir) => {
      await Promise.all([
        upsertRun(dir, entry(1)),
        upsertRun(dir, entry(2)),
        upsertRun(dir, { ...entry(1), state: "completed", exitCode: 0 }),
      ]);
      const runs = await loadLedger(dir);
      expect(runs).toHaveLength(2);
      expect(runs.find((r) => r.runId === "run-1")).toMatchObject({ state: "completed", exitCode: 0 });
    });
  });
  it("leaves no temp files and a 0600 file", async () => {
    await scratch(async (dir) => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => upsertRun(dir, entry(i))));
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect((await stat(ledgerPath(dir))).mode & 0o777).toBe(0o600);
    });
  });
  it("a failed write does not poison later writes", async () => {
    await scratch(async (dir) => {
      await expect(upsertRun(join(dir, "\0bad"), entry(1))).rejects.toBeDefined();
      await upsertRun(dir, entry(2));
      expect(await loadLedger(dir)).toHaveLength(1);
    });
  });
});

describe("issue #37: retention never evicts in-flight runs", () => {
  it("keeps all running entries even when terminal ones exceed the cap", () => {
    const old = Array.from({ length: 5 }, (_, i) => entry(i, "running", `2020-01-0${i + 1}T00:00:00Z`));
    const terminal = Array.from({ length: LEDGER_TERMINAL_CAP + 50 }, (_, i) => entry(1000 + i, "completed"));
    const out = capLedger([...old, ...terminal]);
    expect(out.filter((r) => r.state === "running")).toHaveLength(5);
    expect(out.filter((r) => r.state === "completed")).toHaveLength(LEDGER_TERMINAL_CAP);
  });
  it("evicts the oldest terminal runs first", () => {
    const runs = Array.from({ length: 5 }, (_, i) => entry(i, "failed"));
    const out = capLedger(runs, 3);
    expect(out.map((r) => r.runId).sort()).toEqual(["run-2", "run-3", "run-4"]);
  });
});

describe("issue #37: review follow-ups", () => {
  it("timed-out runs are not terminal: never evicted by the cap (worker may still be running)", () => {
    const timedOut = [entry(1, "timed-out", "2020-01-01T00:00:00Z")];
    const terminal = Array.from({ length: LEDGER_TERMINAL_CAP + 10 }, (_, i) => entry(1000 + i, "completed"));
    expect(capLedger([...timedOut, ...terminal]).some((r) => r.runId === "run-1")).toBe(true);
  });
  it("outcomeEntry keeps the original entry (startedAt, engine, pid)", () => {
    const base: LedgerEntry = { ...entry(7), harness: "pi", piModel: "p/m", pid: 4242, startedAt: "2026-01-01T00:00:00Z" };
    const out = outcomeEntry(base, { timedOut: false, reconciledDead: false, parsed: { ok: true, summary: "done", sessionId: "s" } });
    expect(out).toMatchObject({ startedAt: "2026-01-01T00:00:00Z", harness: "pi", piModel: "p/m", pid: 4242, state: "completed", summary: "done", sessionId: "s" });
  });
  it("a silent-death failure is not overwritten by the timed-out outcome", () => {
    const out = outcomeEntry(entry(8), { timedOut: true, reconciledDead: true, parsed: {} });
    expect(out.state).toBe("failed");
    expect(out.summary).toMatch(/silent death/);
  });
  it("state mapping: timed-out, failed (ok:false), completed", () => {
    expect(outcomeEntry(entry(1), { timedOut: true, reconciledDead: false, parsed: {} }).state).toBe("timed-out");
    expect(outcomeEntry(entry(1), { timedOut: false, reconciledDead: false, parsed: { ok: false } }).state).toBe("failed");
    expect(outcomeEntry(entry(1), { timedOut: false, reconciledDead: false, parsed: { ok: true } }).state).toBe("completed");
  });
});
