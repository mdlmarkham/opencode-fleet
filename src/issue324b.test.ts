/**
 * Issue #324b (the outcome half; #326 landed the naming half): a verify gate
 * that could not RUN its toolchain (a missing tsc on a fresh clone — exit 126/127)
 * is UNVERIFIED, not failed. `verified` is null with `endedBy: "gate-unavailable"`,
 * the same discipline #309 set for a gate that did not FINISH. Null is never a
 * pass; a hard failure or a failed file check still wins false; the mixed
 * timeout+unavailable edge is conservatively false.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyGateScript } from "./node/runtime.js";
import { evaluateExpect, type ExpectCheck } from "./verify.js";
import { outcomeEntry, syncGate, type LedgerEntry } from "./ledger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet324b-")); });
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

describe("#324b: the launcher's shell gate", () => {
  it("exit 127 (tsc missing) is verified:null + endedBy gate-unavailable, with the missing tool recorded", async () => {
    const done = await runLauncher({ commands: ["no-such-tool-324b"] });
    expect(done).toMatchObject({
      done: 1,
      verified: null,
      endedBy: "gate-unavailable",
      missing: "no-such-tool-324b",
      verifyDetails: { command: { exitCode: 127, ok: false, kind: "environment-unavailable", missing: "no-such-tool-324b" } },
    });
  });
  it("exit 126 (cannot execute) reclassifies the same way", async () => {
    const done = await runLauncher({ commands: ["/nope-324b/scripthere"] });
    expect(done.verified).toBeNull();
    expect(done.endedBy).toBe("gate-unavailable");
    // bash -c on an ABSENT path exits 127 on this platform (the permission-denied
    // file case exits 126); both are tagged kind:"environment-unavailable" and
    // classify as could-not-run. #326 pinned the same launcher shapes.
    expect(done.verifyDetails.command).toMatchObject({ exitCode: 127, ok: false, kind: "environment-unavailable" });
  });
  it("a plain failure (exit 3) stays verified:false with NO endedBy and no kind", async () => {
    const done = await runLauncher({ commands: ["exit 3"] });
    expect(done.verified).toBe(false);
    expect(done.endedBy).toBeUndefined();
    expect(done.verifyDetails.command).toMatchObject({ exitCode: 3, ok: false });
    expect(done.verifyDetails.command.kind).toBeUndefined();
    expect((done.verifyDetails.command as Record<string, unknown>)["missing"]).toBeUndefined();
  });
  it("a hard failure beside an unavailable command is NOT reclassified: false wins", async () => {
    const done = await runLauncher({ commands: ["true", "exit 3", "no-such-tool-324b"] });
    expect(done.verified).toBe(false);
    expect(done.endedBy).toBeUndefined();
  });
  it("a timeout beside an unavailable command is conservatively false (the mixed edge, pinned)", async () => {
    const done = await runLauncher({ commands: ["sleep 30", "no-such-tool-324b"], timeoutMs: 1000 });
    expect(done.verified).toBe(false);
    expect(done.endedBy).toBeUndefined();
  }, 15_000);
  it("files all ok + only unavailable commands => null; a failed file check => false", async () => {
    const onlyUnavailable = await runLauncher({ files: ["present.txt"], commands: ["no-such-tool-324b"] }, (c) => writeFileSync(join(c, "present.txt"), "x"));
    expect(onlyUnavailable).toMatchObject({ verified: null, endedBy: "gate-unavailable" });
    const failedFile = await runLauncher({ files: ["absent-324b.txt"], commands: ["no-such-tool-324b"] });
    expect(failedFile.verified).toBe(false);
    expect(failedFile.endedBy).toBeUndefined();
  });
  it("a passing gate is unchanged (no endedBy, no missing)", async () => {
    const done = await runLauncher({ command: "true" });
    expect(done).toMatchObject({ verified: true, verifyDetails: { command: { exitCode: 0, ok: true } } });
    expect(done.endedBy).toBeUndefined();
    expect(done.missing).toBeUndefined();
  });
});

describe("#324b: the in-process gate (evaluateExpect)", () => {
  it("a command that could not start (127) is verified:null + endedBy gate-unavailable", async () => {
    const out = await evaluateExpect({ command: "definitely-not-a-command-324b" }, dir);
    expect(out.verified).toBeNull();
    expect(out.endedBy).toBe("gate-unavailable");
    expect(out.missing).toBe("definitely-not-a-command-324b");
    expect(out.verifyDetails.command).toMatchObject({ ok: false, exitCode: 127, kind: "environment-unavailable" });
  });
  it("files all ok + only unavailable commands => null; only timeouts keep gate-timeout; the mixed edge is false", async () => {
    const unavailable = await evaluateExpect({ commands: ["definitely-not-a-command-324b"] }, dir);
    expect(unavailable).toMatchObject({ verified: null, endedBy: "gate-unavailable" });
    const timedOut = await evaluateExpect({ command: "sleep 30", timeoutMs: 250 }, dir);
    expect(timedOut).toMatchObject({ verified: null, endedBy: "gate-timeout" });
    const mixed = await evaluateExpect({ commands: ["sleep 30", "definitely-not-a-command-324b"], timeoutMs: 250 }, dir);
    expect(mixed.verified).toBe(false);
    expect(mixed.endedBy).toBeUndefined();
  }, 15_000);
});

describe("#324b: the ledger keeps a gate-unavailable run out of failed-verification", () => {
  const base = (o: Partial<LedgerEntry>): LedgerEntry => ({ runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", state: "running", ...o }) as LedgerEntry;
  it("outcomeEntry records gateUnavailable (+ missing) and keeps the run completed (not failed-verification)", () => {
    const e = outcomeEntry(base({}), { timedOut: false, reconciledDead: false, parsed: { ok: true, gateUnavailable: true, gateMissing: "tsc", verifyDetails: undefined } });
    expect(e).toMatchObject({ state: "completed", gateUnavailable: true, gateMissing: "tsc" });
    expect(e.verified).toBeUndefined();
  });
  it("a verified:false gate STILL lands failed-verification (fail closed; unverified is never a pass)", () => {
    const e = outcomeEntry(base({}), { timedOut: false, reconciledDead: false, parsed: { ok: true, verified: false, gateUnavailable: true, verifyDetails: undefined } });
    expect(e.state).toBe("failed-verification");
    expect(e.verified).toBe(false);
  });
});

describe("#324b: the gateway says 'the gate could not run (tool missing: tsc)', never 'failed'", () => {
  const base = (o: Partial<LedgerEntry>): LedgerEntry => ({ runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", state: "completed", ...o }) as LedgerEntry;
  it("fleet_sync with requireVerified refuses with could-not-run wording naming the tool", () => {
    const refused = syncGate(base({ gateUnavailable: true, gateMissing: "tsc" }), { requireVerified: true });
    expect(refused.allow).toBe(false);
    expect(refused.verified).toBeNull();
    expect(refused.reason).toMatch(/tool missing: tsc/);
    expect(refused.reason).toMatch(/UNVERIFIED/);
    expect(refused.reason).not.toMatch(/failed its verification gate/);
  });
  it("without requireVerified it allows with 'the gate could not run' wording (never 'failed')", () => {
    const ok = syncGate(base({ gateUnavailable: true, gateMissing: "tsc" }), {});
    expect(ok).toMatchObject({ allow: true, verified: null });
    expect(ok.reason).toMatch(/the gate could not run \(tool missing: tsc\)/);
    expect(ok.reason).not.toMatch(/failed/);
  });
  it("allowUnverified overrides the could-not-run refusal (an explicit human choice)", () => {
    expect(syncGate(base({ gateUnavailable: true, gateMissing: "tsc" }), { requireVerified: true, allowUnverified: true }).allow).toBe(true);
  });
  it("a genuine failure is unchanged: refused as FAILED", () => {
    const r = syncGate(base({ verified: false, state: "failed-verification" }), {});
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/failed its verification gate/);
  });
});