import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyGateScript } from "./node/runtime.js";
import { evaluateExpect, type ExpectCheck } from "./verify.js";
import { outcomeEntry, syncGate, type LedgerEntry } from "./ledger.js";

// #309: a verify gate that did not FINISH is unverified (null, endedBy gate-timeout), never "failed".
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet309-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const runLauncher = async (expectSpec: ExpectCheck, setup?: (cwd: string) => void) => {
  const cwd = join(dir, `r-${process.hrtime.bigint().toString(36)}`);
  mkdirSync(cwd, { recursive: true });
  setup?.(cwd);
  const donePath = join(dir, "done.json");
  const gate = verifyGateScript(expectSpec, donePath, { cwd });
  const scriptPath = join(dir, "launcher.sh");
  writeFileSync(scriptPath, ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n"), { mode: 0o700 });
  await promisify(execFile)("/bin/bash", [scriptPath]);
  return JSON.parse(readFileSync(donePath, "utf8")) as Record<string, any>;
};

describe("#309: the launcher's shell gate", () => {
  it("a command killed by its own timeout records verified:null + endedBy gate-timeout (exit 124), not false", async () => {
    const done = await runLauncher({ command: "sleep 30", timeoutMs: 1000 });
    expect(done).toMatchObject({ done: 1, verified: null, endedBy: "gate-timeout", verifyDetails: { command: { exitCode: 124, ok: false } } });
  }, 15_000);
  it("a command that fails outright (not 124/137) is still verified:false, with no endedBy", async () => {
    const done = await runLauncher({ command: "exit 3" });
    expect(done.verified).toBe(false);
    expect(done.endedBy).toBeUndefined();
    expect(done.verifyDetails.command).toMatchObject({ exitCode: 3, ok: false });
  });
  it("a passing gate is unchanged", async () => {
    const done = await runLauncher({ command: "true" });
    expect(done).toMatchObject({ verified: true, verifyDetails: { command: { exitCode: 0, ok: true } } });
    expect(done.endedBy).toBeUndefined();
  });
  it("a missing file alongside a timeout is a real failure: false wins", async () => {
    const done = await runLauncher({ files: ["nope.txt"], command: "sleep 30", timeoutMs: 1000 });
    expect(done.verified).toBe(false);
    expect(done.endedBy).toBeUndefined();
  }, 15_000);
  it("plural commands: one hard failure plus one timeout is false; timeouts only is null", async () => {
    expect((await runLauncher({ commands: ["exit 2", "sleep 30"], timeoutMs: 1000 })).verified).toBe(false);
    const only = await runLauncher({ commands: ["true", "sleep 30"], timeoutMs: 1000 });
    expect(only).toMatchObject({ verified: null, endedBy: "gate-timeout" });
    expect(only.verifyDetails.commands).toHaveLength(2);
  }, 30_000);
});

describe("#309: the in-process gate", () => {
  it("a timed-out command is verified:null + endedBy, with timedOut recorded on the command", async () => {
    const out = await evaluateExpect({ command: "sleep 30", timeoutMs: 300 }, dir);
    expect(out.verified).toBeNull();
    expect(out.endedBy).toBe("gate-timeout");
    expect(out.verifyDetails.command).toMatchObject({ ok: false, timedOut: true });
  }, 15_000);
  it("a real failure is false and not marked timed out; a timeout beside a failed command stays false", async () => {
    expect((await evaluateExpect({ command: "exit 1" }, dir)).verified).toBe(false);
    const mixed = await evaluateExpect({ commands: ["exit 1", "sleep 30"], timeoutMs: 300 }, dir);
    expect(mixed.verified).toBe(false);
    expect(mixed.endedBy).toBeUndefined();
  }, 15_000);
});

describe("#309: the gateway says 'timed out', never 'failed'", () => {
  const base = (o: Partial<LedgerEntry>): LedgerEntry => ({ runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", state: "completed", ...o }) as LedgerEntry;
  it("outcomeEntry records gateTimedOut and keeps the run completed (not failed-verification)", () => {
    const e = outcomeEntry(base({ state: "running" }), { timedOut: false, reconciledDead: false, parsed: { ok: true, gateTimedOut: true } });
    expect(e).toMatchObject({ state: "completed", gateTimedOut: true });
    expect(e.verified).toBeUndefined();
  });
  it("fleet_sync with requireVerified refuses with 'TIMED OUT' wording; without it, allows with 'unverified (not failed)'", () => {
    const entry = base({ gateTimedOut: true });
    const refused = syncGate(entry, { requireVerified: true });
    expect(refused.allow).toBe(false);
    expect(refused.reason).toMatch(/TIMED OUT/);
    expect(refused.reason).not.toMatch(/failed its verification gate/);
    expect(refused.verified).toBeNull();
    const ok = syncGate(entry, {});
    expect(ok).toMatchObject({ allow: true, verified: null });
    expect(ok.reason).toMatch(/timed out/);
  });
  it("allowUnverified overrides the timeout refusal (an explicit human choice)", () => {
    expect(syncGate(base({ gateTimedOut: true }), { requireVerified: true, allowUnverified: true }).allow).toBe(true);
  });
  it("a genuine failure is unchanged: refused as FAILED", () => {
    const r = syncGate(base({ verified: false, state: "failed-verification" }), {});
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/failed its verification gate/);
  });
});
