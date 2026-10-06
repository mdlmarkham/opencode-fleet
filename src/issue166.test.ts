import { describe, expect, it } from "vitest";
import { qualityRecord, qualityReport } from "./spec-quality.js";
import type { LedgerEntry } from "./ledger.js";
import { upsertRun } from "./ledger.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

const T0 = "2026-10-01T00:00:00.000Z";
const entry = (o: Partial<LedgerEntry> & { runId: string }): LedgerEntry => ({ node: "n", cwd: "/w", prompt: "p", startedAt: T0, updatedAt: "2026-10-01T00:10:00.000Z", state: "completed", spec: { goal: "g", acceptance: ["a"], verify: { command: "./v.sh" }, scope: { files: ["x"] } }, ...o }) as LedgerEntry;

describe("#166: qualityRecord", () => {
  it("derives spec facts and outcome; stores no spec text", () => {
    const r = qualityRecord(entry({ runId: "r1", filesChanged: 0, design: { verdict: "accept-with-nudges", objectionIds: ["spec.no-scope"] }, usage: { tokens: 99 } }))!;
    expect(r).toMatchObject({ hadAcceptance: true, hadVerify: true, hadScope: true, outcome: "no-op", verdict: "accept-with-nudges", objectionIds: ["spec.no-scope"], tokens: 99, wallMs: 600_000 });
    expect(JSON.stringify(r)).not.toContain('"goal"');
  });
  it("an unknown change capture is not a no-op; failed gate and failure are distinct", () => {
    expect(qualityRecord(entry({ runId: "a" }))!.outcome).toBe("complete");
    expect(qualityRecord(entry({ runId: "b", state: "failed-verification" }))!.outcome).toBe("failed-verification");
    expect(qualityRecord(entry({ runId: "c", state: "failed", filesChanged: 0 }))!.outcome).toBe("failed");
  });
  it("a running run has no record; a file-only gate counts as a verify gate", () => {
    expect(qualityRecord(entry({ runId: "d", state: "running" }))).toBeUndefined();
    expect(qualityRecord(entry({ runId: "e", spec: { goal: "g", verify: { files: ["f"] } } }))!.hadVerify).toBe(true);
  });
});

describe("#166: qualityReport", () => {
  const noVerify = (i: number, bad: boolean) => entry({ runId: `nv${i}`, spec: { goal: "g" }, state: bad ? "failed-verification" : "completed", design: { verdict: "accept-with-nudges", objectionIds: ["spec.no-verify"] } });
  const withVerify = (i: number) => entry({ runId: `v${i}`, state: "completed", filesChanged: 2 });
  it("splits by fact and verdict, ignores prompt-only runs, and withholds rates below minN", () => {
    const es = [...Array.from({ length: 10 }, (_, i) => noVerify(i, i < 7)), ...Array.from({ length: 4 }, (_, i) => withVerify(i)), entry({ runId: "flat", spec: undefined })];
    const r = qualityReport(es, { minN: 10 });
    expect(r.n).toBe(14);
    expect(r.byFact.hadVerify.without).toMatchObject({ n: 10, failedVerification: 7, badRate: 0.7 });
    expect(r.byFact.hadVerify.with).toMatchObject({ n: 4, complete: 4, badRate: null });
    expect(r.byObjection["spec.no-verify"]!.n).toBe(10);
    expect(r.byVerdict.unrecorded!.n).toBe(4);
  });
  it("honours the window", () => {
    const r = qualityReport([entry({ runId: "old" })], { sinceMs: Date.parse("2026-11-01") });
    expect(r.n).toBe(0);
  });
});

describe("#166: wiring", () => {
  it("fleet_dispatch persists the verdict and objection ids (no text) on the ledger entry", async () => {
    const restore = fakeSsh("FLEET_CWD=ok");
    const t = loadPlugin((await loadEntry())!, { nodes: [{ nodeId: "n1", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] }], config: { nodes: { dev3: { roles: ["worker"], ssh: false } } }, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    try {
      await t.call("fleet_dispatch", { cwd: "/w/p", node: "dev3", spec: { goal: "SECRET-GOAL-TEXT" } });
      const { loadLedger } = await import("./ledger.js");
      const e = (await loadLedger(t.rootDir))[0]!;
      expect(e.design?.verdict).toBe("accept-with-nudges");
      expect(e.design?.objectionIds).toEqual(expect.arrayContaining(["spec.no-verify", "spec.no-acceptance"]));
      expect(JSON.stringify(e.design)).not.toContain("SECRET-GOAL-TEXT");
      const rep = await t.call("fleet_spec_quality", {});
      expect(rep).toMatchObject({ ok: true, n: 0 }); // still running: not terminal
    } finally { t.dispose(); restore(); }
  });
  it("the tool reports a finished run from the ledger", async () => {
    const t = loadPlugin((await loadEntry())!, {});
    try {
      await upsertRun(t.rootDir, entry({ runId: "r9", filesChanged: 0 }));
      expect(await t.call("fleet_spec_quality", {})).toMatchObject({ n: 1, overall: { noOp: 1, badRate: null } });
    } finally { t.dispose(); }
  });
});
