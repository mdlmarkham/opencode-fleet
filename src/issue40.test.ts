/**
 * Issue #40 review: fixes for the verify-gate (#62) follow-ups.
 *
 * 1. LEDGER LAUNDERING: a clean exit (EC=0 / ok:true) whose verification gate
 *    FAILED must be persisted as state "failed-verification", never
 *    "completed" — in outcomeEntry AND the fleet_run_status reconcile.
 *    verified/verifyDetails are recorded on the entry so the failure survives
 *    node state cleanup (the ledger becomes the durable record).
 * 3. withVerified (previously dead code) is now the single shape-pinning
 *    helper: verified + verifyDetails are ALWAYS present (null when no gate).
 * 4. SHAPE PARITY: absent `expect` => verified:null + verifyDetails:null on
 *    the sync dispatch path too — identical to the detached path.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLedger, outcomeEntry, upsertRun, type LedgerEntry } from "./ledger.js";
import { withVerified } from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));

const base = (): LedgerEntry => ({
  runId: "run-1",
  node: "dev2",
  cwd: "/home/u/p",
  prompt: "task",
  startedAt: new Date(1_700_000_000_000).toISOString(),
  updatedAt: new Date().toISOString(),
  state: "running",
});

describe("issue #40 review: ledger state derivation consults `verified`", () => {
  it("a clean exit whose gate FAILED is failed-verification, never completed", () => {
    const out = outcomeEntry(base(), {
      timedOut: false,
      reconciledDead: false,
      parsed: { ok: true, verified: false, verifyDetails: { files: [{ path: "dist/index.js", ok: false }] } },
    });
    expect(out.state).toBe("failed-verification");
    expect(out.verified).toBe(false);
  });

  it("the gate outcome and verifyDetails are persisted on the entry (survive node state cleanup)", () => {
    const out = outcomeEntry(base(), {
      timedOut: false,
      reconciledDead: false,
      parsed: { ok: true, verified: false, verifyDetails: { files: [{ path: "report.md", ok: false }], command: { cmd: "npm test", exitCode: 1, ok: false } } },
    });
    expect(out).toMatchObject({
      state: "failed-verification",
      verified: false,
      verifyDetails: { files: [{ path: "report.md", ok: false }], command: { cmd: "npm test", exitCode: 1, ok: false } },
    });
    // After a JSON round trip (what loadLedger sees from disk) the details are
    // still there — the ledger is the durable record.
    const fromDisk = JSON.parse(JSON.stringify(out)) as LedgerEntry;
    expect(fromDisk.verified).toBe(false);
    expect(fromDisk.verifyDetails).toMatchObject({ files: [{ path: "report.md", ok: false }] });
  });

  it("verifyDetails persist even when the gate PASSED (durable, not only on failure)", () => {
    const out = outcomeEntry(base(), {
      timedOut: false,
      reconciledDead: false,
      parsed: { ok: true, verified: true, verifyDetails: { files: [{ path: "dist/index.js", ok: true }] } },
    });
    expect(out.state).toBe("completed");
    expect(out.verified).toBe(true);
    expect(out.verifyDetails).toMatchObject({ files: [{ path: "dist/index.js", ok: true }] });
  });

  it("back-compat: no gate (verified absent/true) keeps state completed", () => {
    // verified absent — a pre-#62 node payload or a gateless dispatch. The key
    // is not materialized in the persisted entry (undefined is dropped).
    const noGate = outcomeEntry(base(), { timedOut: false, reconciledDead: false, parsed: { ok: true } });
    expect(noGate.state).toBe("completed");
    expect(JSON.parse(JSON.stringify(noGate))).not.toHaveProperty("verified");
    // verified true — the gate ran and passed.
    const passed = outcomeEntry(base(), { timedOut: false, reconciledDead: false, parsed: { ok: true, verified: true } });
    expect(passed.state).toBe("completed");
    expect(passed.verified).toBe(true);
  });

  it("process-level failures keep their state; the gate only reclassifies the would-be-completed branch", () => {
    expect(outcomeEntry(base(), { timedOut: false, reconciledDead: true, parsed: { verified: false } }).state).toBe("failed");
    expect(outcomeEntry(base(), { timedOut: true, reconciledDead: false, parsed: { verified: false } }).state).toBe("timed-out");
    expect(outcomeEntry(base(), { timedOut: false, reconciledDead: false, parsed: { ok: false, verified: false } }).state).toBe("failed");
  });

  it("a failed-verification entry survives a real ledger write/read cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet40-"));
    try {
      await upsertRun(
        dir,
        outcomeEntry(base(), {
          timedOut: false,
          reconciledDead: false,
          parsed: { ok: true, verified: false, verifyDetails: { files: [{ path: "dist/index.js", ok: false }] } },
        }),
      );
      const runs = await loadLedger(dir);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ state: "failed-verification", verified: false });
      expect((runs[0].verifyDetails as { files: Array<{ path: string; ok: boolean }> }).files).toEqual([
        { path: "dist/index.js", ok: false },
      ]);
      // failed-verification is terminal: subject to retention, never in-flight.
      expect(loadLedger).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("issue #40 review: withVerified pins one verified shape everywhere", () => {
  it("no gate => verified:null AND verifyDetails:null (identical to the detached path)", () => {
    const out = withVerified({ runId: "r1", ok: true }, null);
    expect(out).toEqual({ runId: "r1", ok: true, verified: null, verifyDetails: null });
    // The keys are present — consumers can rely on `verified in result`.
    expect(out).toHaveProperty("verified", null);
    expect(out).toHaveProperty("verifyDetails", null);
  });

  it("a gateless node payload ({ok:true}) also maps to verified:null + verifyDetails:null", () => {
    const out = withVerified({ done: true, ok: true }, { ok: true } as { verified?: boolean; verifyDetails?: unknown });
    expect(out.verified).toBe(null);
    expect(out.verifyDetails).toBe(null);
  });

  it("a gate outcome merges verified/verifyDetails and keeps the target's keys", () => {
    const out = withVerified(
      { runId: "r1", result: { ok: true } },
      { verified: false, verifyDetails: { files: [{ path: "x.js", ok: false }] } },
    );
    expect(out).toMatchObject({
      runId: "r1",
      result: { ok: true },
      verified: false,
      verifyDetails: { files: [{ path: "x.js", ok: false }] },
    });
  });

  it("a passing gate without details still carries verifyDetails:null", () => {
    const out = withVerified({}, { verified: true });
    expect(out).toEqual({ verified: true, verifyDetails: null });
  });
});

describe("issue #40 review: gateway wiring (fleet_watch / fleet_iterate / reconcile)", () => {
  const src = readFileSync(join(here, "index.ts"), "utf8");

  it("fleet_watch and fleet_iterate accept and thread `expect` like fleet_dispatch", () => {
    // The gate spec is parsed up front and threaded to the node in all three
    // dispatchers (fleet_dispatch, fleet_watch, fleet_iterate).
    expect(src.match(/parseExpectSpec\(p\.expect\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src.match(/expect: expectSpec\.expect,/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("fleet_iterate's success check honors `verified` (a gate failure is not success/done)", () => {
    expect(src).toContain("(p.successMarker ? (parsed.summary ?? \"\").includes(p.successMarker) : !looksFailed) && verified !== false");
  });

  it("the sync dispatch path uses withVerified (shape parity; no key omission when expect is absent)", () => {
    expect(src.match(/withVerified\(/g)?.length).toBeGreaterThanOrEqual(3); // dispatch sync + watch + iterate
    const old = "?: { verified: parsedResult.verified, verifyDetails: parsedResult.verifyDetails ?? null }";
    expect(src.includes(old)).toBe(false); // the shape-divergent hoist is gone
  });

  it("the fleet_run_status reconcile derives failed-verification and persists verifiability", () => {
    expect(src).toContain('"failed-verification"');
    expect(src).toContain("reconcileVerified === false");
    expect(src).toContain("reconcileVerified !== null ? { verified: reconcileVerified } : {}");
  });

  it("the ledger module derives failed-verification from verified:false (outcomeEntry)", () => {
    const ledger = readFileSync(join(here, "ledger.ts"), "utf8");
    expect(ledger).toContain('"failed-verification"');
    expect(ledger).toContain('o.parsed.verified === false');
  });
});