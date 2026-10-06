/**
 * Issue #196: the design gate's overlap evidence counted FINISHED ledger runs as
 * in-flight, producing spurious `overlap.unknown` nudges on every dispatch to a
 * checkout with recent runs — and claimed "a scope is missing" on dispatches that
 * DID declare scope.files.
 *
 * The query that feeds the gate must reconcile live-at-query-time the same way
 * fleet_capacity does: only genuinely running entries (state=running, not past
 * staleAfterMs) are conflict evidence; finished runs may appear only as
 * informational `recentlyFinished`, never as in-flight evidence; the "scope
 * missing" language holds only when a side really has no scope; and the
 * dispatch-does-not-conflict-with-itself exclusion still holds.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capacityInputFromLedger, ledgerToInFlight, type LedgerLike } from "./capacity.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { upsertRun } from "./ledger.js";
import type { TaskSpec } from "./spec.js";

const entry = await loadEntry();
const GOOD: TaskSpec = { goal: "add x", acceptance: ["x works"], verify: { command: "scripts/check.sh" }, scope: { files: ["src/x/"] } };
const reply = () => nodeReply({ ok: true, detached: true, runId: "r-live", pid: 1 });
const cfgNode = () => ({ nodes: { dev2: { roles: ["worker"], ssh: false } } });

describe("#196: capacityInputFromLedger reconciles live-at-query-time", () => {
  const NOW = Date.parse("2026-10-05T20:40:00Z");
  const SA = 6 * 60 * 60_000;

  it("finished runs become recentlyFinished, never inFlight", () => {
    const ledger: LedgerLike[] = [
      { runId: "fin-1", node: "dev2", cwd: "/w/p", state: "completed", startedAt: "2026-10-05T20:08:14Z", updatedAt: "2026-10-05T20:08:28Z", finishedAt: "2026-10-05T20:08:28Z" },
      { runId: "fin-2", node: "dev2", cwd: "/w/p", state: "failed", startedAt: "2026-10-05T20:08:14Z", updatedAt: "2026-10-05T20:08:33Z", finishedAt: "2026-10-05T20:08:33Z" },
      { runId: "live-1", node: "dev2", cwd: "/w/p", state: "running", startedAt: "2026-10-05T21:30:00Z", updatedAt: "2026-10-05T20:39:00Z" },
    ];
    const r = capacityInputFromLedger(ledger, { nodeNames: ["dev2"], cwd: "/w/p", now: NOW, staleAfterMs: SA, excludeRunId: "live-1" });
    expect(r.inFlight.map((x) => x.runId)).toEqual([]);
    expect(r.recentlyFinished.map((x) => x.runId)).toEqual(["fin-1", "fin-2"]);
  });

  it("running-but-stale drops out of inFlight", () => {
    const ledger: LedgerLike[] = [
      { runId: "stale-1", node: "dev2", cwd: "/w/p", state: "running", startedAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z" },
    ];
    const r = capacityInputFromLedger(ledger, { nodeNames: ["dev2"], cwd: "/w/p", now: NOW, staleAfterMs: SA });
    expect(r.inFlight).toEqual([]);
    expect(r.recentlyFinished).toEqual([]);
  });

  it("running-and-fresh IS inFlight", () => {
    const ledger: LedgerLike[] = [
      { runId: "fresh-1", node: "dev2", cwd: "/w/p", state: "running", startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z" },
    ];
    const r = capacityInputFromLedger(ledger, { nodeNames: ["dev2"], cwd: "/w/p", now: NOW, staleAfterMs: SA });
    expect(r.inFlight.map((x) => x.runId)).toEqual(["fresh-1"]);
  });

  it("runs on other nodes / other checkouts never appear", () => {
    const ledger: LedgerLike[] = [
      { runId: "other-node", node: "dev3", cwd: "/w/p", state: "running", startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z" },
      { runId: "other-cwd", node: "dev2", cwd: "/other", state: "running", startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z" },
    ];
    const r = capacityInputFromLedger(ledger, { nodeNames: ["dev2"], cwd: "/w/p", now: NOW, staleAfterMs: SA });
    expect(r.inFlight).toEqual([]);
  });
});

describe("#196: ledgerToInFlight keeps scope + isolation", () => {
  it("carries spec scope; runCwd marks isolated runs", () => {
    const scoped = {
      runId: "r1", node: "dev2", cwd: "/w/p", state: "running",
      startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z",
      spec: { goal: "g", scope: { files: ["src/x/"] } },
    } as unknown as LedgerLike;
    const isolated = {
      runId: "r2", node: "dev2", cwd: "/w/p", state: "running",
      startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z",
      runCwd: "/w/p-clones/r2",
    } as unknown as LedgerLike;
    expect(ledgerToInFlight(scoped)).toEqual({ runId: "r1", node: "dev2", cwd: "/w/p", scope: { files: ["src/x/"] }, goal: "g" });
    expect(ledgerToInFlight(isolated)).toEqual({ runId: "r2", node: "dev2", cwd: "/w/p", isolated: true });
    expect(ledgerToInFlight({ runId: "r3", node: "dev2", cwd: "/w/p", state: "running", startedAt: "2026-10-05T20:30:00Z", updatedAt: "2026-10-05T20:39:00Z" } as unknown as LedgerLike)).toEqual({ runId: "r3", node: "dev2", cwd: "/w/p" });
  });
});

describe.skipIf(!entry)("#196: tool surface", () => {
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok\n" + JSON.stringify(reply())); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  it("a stale running ledger entry (old updatedAt) yields NO overlap objection", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode(), invoke: reply });
    await upsertRun(p.rootDir, { runId: "stale-live", node: "dev2", cwd: "/w/proj", prompt: "p", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "running" } as never);
    const r = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/proj" }) as { verdict: string; overlapChecked: boolean };
    expect(r).toMatchObject({ ok: true, verdict: "accept", overlapChecked: true });
  });

  it("a fresh running entry still yields overlap.in-flight on fleet_design_check", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode(), invoke: reply });
    const now = new Date().toISOString();
    await upsertRun(p.rootDir, { runId: "fresh-live", node: "dev2", cwd: "/w/proj", prompt: "p", startedAt: now, updatedAt: now, state: "running", spec: { goal: "g", scope: { files: ["src/x/"] } } } as never);
    const r = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/proj" }) as { verdict: string; objections: Array<{ id: string }> };
    expect(r.verdict).toBe("reject-with-reason");
    expect(r.objections[0]!.id).toBe("overlap.in-flight");
  });

  it("a fresh running entry WITHOUT scope yields overlap.unknown (nudge), not in-flight evidence", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode(), invoke: reply });
    const now = new Date().toISOString();
    await upsertRun(p.rootDir, { runId: "no-scope-live", node: "dev2", cwd: "/w/proj", prompt: "p", startedAt: now, updatedAt: now, state: "running" } as never);
    const r = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/proj" }) as { verdict: string; objections: Array<{ id: string; message: string; evidence: string }> };
    expect(r.verdict).toBe("accept-with-nudges");
    const unk = r.objections.find((o) => o.id === "overlap.unknown");
    expect(unk).toBeDefined();
    // the dispatch DID declare scope: the missing scope is the OTHER side's, and the text must say so
    expect(unk!.evidence).toContain("no-scope-live");
    expect(unk!.message).toContain("other");
  });
});
