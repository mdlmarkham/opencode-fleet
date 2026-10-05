/**
 * Issue #39 (budget accounting + enforcement slice): per-day caps from ledger usage,
 * per-dispatch caps, the retryable "budget-exhausted" dispatch result, the
 * fleet_iterate budget stop, and budget visibility in fleet_capacity.
 *
 * Spend is derived from the ledger: each finished run's audit-manifest usage rides its
 * ledger entry, accounted to the UTC day the run STARTED. The helpers in budget.ts are
 * pure; the tool-level tests below exercise the same execute() functions the gateway runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetCheck, budgetExhausted, dayKey, daySpent, parseBudgetConfig, parseOverrides, usageFromManifest, type BudgetLimits } from "./budget.js";
import { loadLedger, upsertRun, type LedgerEntry, type RunUsage } from "./ledger.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const entry = await loadEntry();

const le = (over: Partial<LedgerEntry> & { runId: string; startedAt: string; usage?: RunUsage }): LedgerEntry => ({
  node: "dev2",
  cwd: "/w/proj",
  prompt: "p",
  updatedAt: over.startedAt,
  state: "completed",
  ...over,
});

describe("#39: budget config validation", () => {
  it("absent means no budget; a valid block parses", () => {
    expect(parseBudgetConfig(undefined)).toEqual({ ok: true });
    expect(parseBudgetConfig({ dailyCostUsd: 10, dailyTokens: 1000 })).toEqual({
      ok: true,
      config: { dailyCostUsd: 10, dailyTokens: 1000 },
    });
  });
  it("malformed blocks are errors, never silently no-budget", () => {
    expect(parseBudgetConfig("x")).toMatchObject({ ok: false });
    expect(parseBudgetConfig({})).toMatchObject({ ok: false, error: expect.stringContaining("dailyCostUsd") });
    expect(parseBudgetConfig({ dailyCostUsd: -1 })).toMatchObject({ ok: false });
    expect(parseBudgetConfig({ dailyCostUsd: "10" })).toMatchObject({ ok: false });
    expect(parseBudgetConfig({ dailyTokens: Number.NaN })).toMatchObject({ ok: false });
    expect(parseBudgetConfig({ daily: 5 })).toMatchObject({ ok: false, error: expect.stringContaining("daily") });
  });
  it("per-dispatch override parsing: both ways validated, wrong types refused", () => {
    expect(parseOverrides(undefined)).toEqual({ ok: true });
    expect(parseOverrides({})).toEqual({ ok: true });
    expect(parseOverrides({ perDispatchCostUsd: 2, perDispatchTokens: 500 })).toEqual({ ok: true, override: { perDispatchCostUsd: 2, perDispatchTokens: 500 } });
    expect(parseOverrides({ perDispatchCostUsd: -1 })).toMatchObject({ ok: false, error: expect.stringContaining("perDispatchCostUsd") });
    expect(parseOverrides({ perDispatchTokens: "x" })).toMatchObject({ ok: false });
  });
});

describe("#39: day attribution is by run START, UTC", () => {
  const RUNS: LedgerEntry[] = [
    le({ runId: "yesterday", startedAt: "2026-10-04T23:59:59Z", usage: { tokens: 100, costUsd: 1 } }),
    le({ runId: "today", startedAt: "2026-10-05T00:00:01Z", usage: { tokens: 50, costUsd: 0.5 } }),
    le({ runId: "no-usage", startedAt: "2026-10-05T10:00:00Z" }),
    le({ runId: "other-day", startedAt: "2026-10-01T10:00:00Z", usage: { tokens: 999, costUsd: 9 } }),
  ];
  it("dayKey buckets by UTC date", () => {
    expect(dayKey("2026-10-04T23:59:59Z")).toBe("2026-10-04");
    expect(dayKey("2026-10-05T00:00:01Z")).toBe("2026-10-05");
  });
  it("daySpent sums only that UTC day's runs", () => {
    // 23:59:59Z is still Oct 04 UTC; 00:00:01Z is Oct 05 — the boundary splits them.
    expect(daySpent(RUNS, "2026-10-05T12:00:00Z")).toEqual({ costUsd: 0.5, tokens: 50 });
    expect(daySpent(RUNS, "2026-10-04T12:00:00Z")).toEqual({ costUsd: 1, tokens: 100 });
    expect(daySpent(RUNS, "2026-10-03T00:00:00Z")).toEqual({ costUsd: 0, tokens: 0 });
  });
});

describe("#39: budgetCheck (pure ledger helper)", () => {
  const LIM: BudgetLimits = { dailyCostUsd: 10, dailyTokens: 1000, perDispatchCostUsd: 5, perDispatchTokens: 400 };
  it("no budget configured => allowed", () => {
    expect(budgetCheck([], undefined, "2026-10-05T12:00:00Z")).toEqual({ allowed: true });
  });
  it("under budget => allowed with the day's spend reported", () => {
    const r = budgetCheck([le({ runId: "a", startedAt: "2026-10-05T08:00:00Z", usage: { costUsd: 2, tokens: 100 } })], LIM, "2026-10-05T12:00:00Z");
    expect(r).toMatchObject({ allowed: true, spent: { costUsd: 2, tokens: 100 } });
  });
  it("exhausted => refused with a reason and the spend", () => {
    const r = budgetCheck(
      [le({ runId: "a", startedAt: "2026-10-05T08:00:00Z", usage: { costUsd: 9, tokens: 100 } })],
      LIM,
      "2026-10-05T12:00:00Z",
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("dailyCostUsd");
    expect(r.spent).toEqual({ costUsd: 9, tokens: 100 });
  });
  it("token cap is checked when cost fits", () => {
    const r = budgetCheck([le({ runId: "a", startedAt: "2026-10-05T08:00:00Z", usage: { tokens: 950 } })], LIM, "2026-10-05T12:00:00Z");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("dailyTokens");
  });
  it("per-dispatch override takes precedence both ways", () => {
    // override stricter than config: still allowed while the day can cover it
    const strict: BudgetLimits = { dailyCostUsd: 10 };
    expect(budgetCheck([], strict, "2026-10-05T12:00:00Z", { perDispatchCostUsd: 2 }).allowed).toBe(true);
    // override looser than config: refused because the declared cap exceeds the day
    expect(budgetCheck([], strict, "2026-10-05T12:00:00Z", { perDispatchCostUsd: 11 }).allowed).toBe(false);
    // config default cap is respected without an override
    expect(budgetCheck([], { dailyCostUsd: 10 }, "2026-10-05T12:00:00Z", undefined)).toEqual({ allowed: true, spent: { costUsd: 0, tokens: 0 } });
  });
  it("a zero per-dispatch cap allows a spendless dispatch but refuses once the day is spent", () => {
    const lim: BudgetLimits = { dailyCostUsd: 10 };
    // declaring 0 spend fits the remaining budget...
    expect(budgetCheck([], lim, "2026-10-05T12:00:00Z", { perDispatchCostUsd: 0 }).allowed).toBe(true);
    // ...but once the day's budget is reached, even a 0-cap dispatch is refused (it could still spend)
    const spent = [le({ runId: "a", startedAt: "2026-10-05T08:00:00Z", usage: { costUsd: 10, tokens: 1 } })];
    expect(budgetCheck(spent, lim, "2026-10-05T12:00:00Z", { perDispatchCostUsd: 0 }).allowed).toBe(false);
  });
  it("budgetExhausted is the same family as no-capacity", () => {
    const r = budgetExhausted({ costUsd: 9, tokens: 100 }, "dailyCostUsd would be exceeded", { perDispatchCostUsd: 2 });
    expect(r).toMatchObject({
      ok: false,
      retryable: true,
      reason: "budget-exhausted",
      spent: { costUsd: 9, tokens: 100 },
      caps: { perDispatchCostUsd: 2 },
      error: expect.stringContaining("budget exhausted"),
    });
  });
});

describe("#39: usageFromManifest (audit-manifest usage -> ledger RunUsage)", () => {
  it("reads opencode step_finish-style usage", () => {
    expect(usageFromManifest({ usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, costUsd: 0.4 } })).toEqual({ tokens: 40, costUsd: 0.4 });
  });
  it("accepts a pre-summed tokens field, and tolerates absent pieces", () => {
    expect(usageFromManifest({ usage: { tokens: 123, costUsd: 0.25 } })).toEqual({ tokens: 123, costUsd: 0.25 });
    expect(usageFromManifest({ usage: { inputTokens: 5 } })).toEqual({ tokens: 5 });
    expect(usageFromManifest({ usage: { costUsd: 1.5 } })).toEqual({ costUsd: 1.5 });
  });
  it("no usable usage => undefined (nothing recorded, never a zero)", () => {
    expect(usageFromManifest(undefined)).toBeUndefined();
    expect(usageFromManifest({})).toBeUndefined();
    expect(usageFromManifest({ usage: {} })).toBeUndefined();
  });
});

const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
const okLaunch = () => nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 });

describe.skipIf(!entry)("#39: fleet_dispatch budget enforcement", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const cfg = (budget: unknown, config: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, budget, ...config });
  const dispatch = (args: Record<string, unknown> = {}) => p!.call("fleet_dispatch", { cwd: "/w/proj", prompt: "do it", node: "dev2", ...args }) as Promise<Record<string, any>>;

  it("recorded ledger usage reaching dailyCostUsd -> retryable budget-exhausted, nothing launched", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ dailyCostUsd: 5 }), invoke: okLaunch });
    await upsertRun(p.rootDir, le({ runId: "spent", startedAt: new Date().toISOString().slice(0, 10) + "T08:00:00Z", usage: { costUsd: 5, tokens: 10 } }));
    const r = await dispatch();
    // The daily budget is fleet-wide, so the refusal is a top-level result (same family as pick:"any"'s noFreeSlot).
    expect(r).toMatchObject({ ok: false, retryable: true, reason: "budget-exhausted", spent: { costUsd: 5 } });
    expect(r.error).toContain("budget exhausted");
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(0);
    expect((await loadLedger(p.rootDir)).filter((e) => e.state === "running")).toHaveLength(0);
  });

  it("under budget -> allowed", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ dailyCostUsd: 5 }), invoke: okLaunch });
    await upsertRun(p.rootDir, le({ runId: "under", startedAt: new Date().toISOString().slice(0, 10) + "T08:00:00Z", usage: { costUsd: 1, tokens: 10 } }));
    const r = await dispatch({ perDispatchCostUsd: 2 });
    expect(r.dev2?.reason).toBeUndefined();
    expect(r.dev2).toMatchObject({ detached: true, pid: 1 });
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(1);
  });

  it("perDispatchCostUsd override below cap passes; at/over the cap refused", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ dailyCostUsd: 10 }), invoke: okLaunch });
    await upsertRun(p.rootDir, le({ runId: "half", startedAt: new Date().toISOString().slice(0, 10) + "T08:00:00Z", usage: { costUsd: 5, tokens: 0 } }));
    // override declares a smaller run: it fits under the day's remaining budget
    const pass = await dispatch({ perDispatchCostUsd: 4 });
    expect(pass.dev2?.reason).toBeUndefined();
    expect(pass.dev2).toMatchObject({ detached: true, pid: 1 });
    // and the override rides the ledger entry
    const ledger = await loadLedger(p.rootDir);
    const mine = ledger.find((e) => e.state === "running");
    expect(mine?.budgetCap).toEqual({ perDispatchCostUsd: 4 });
    // a second dispatch declaring MORE than the day's remaining amount is refused
    await upsertRun(p.rootDir, { ...mine!, state: "completed", usage: { costUsd: 4, tokens: 9000 } });
    const fail = await dispatch({ perDispatchCostUsd: 6 });
    expect(fail).toMatchObject({ ok: false, retryable: true, reason: "budget-exhausted", spent: { costUsd: 9 } });
  });

  it("no per-dispatch cap: once the day is reached nothing more launches (unknown spend)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ dailyCostUsd: 5 }), invoke: okLaunch });
    await upsertRun(p.rootDir, le({ runId: "reached", startedAt: new Date().toISOString().slice(0, 10) + "T08:00:00Z", usage: { costUsd: 7, tokens: 0 } }));
    const r = await dispatch();
    expect(r).toMatchObject({ ok: false, retryable: true, reason: "budget-exhausted" });
  });

  it("day boundary: budget permits a new dispatch after the ledger day rolls over", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ dailyCostUsd: 5 }), invoke: okLaunch });
    // yesterday's runs are over budget; the new run starts TODAY, so it is allowed.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await upsertRun(p.rootDir, le({ runId: "old-day", startedAt: yesterday + "T23:00:00Z", usage: { costUsd: 9, tokens: 99 } }));
    const r = await dispatch();
    expect(r.dev2?.reason).toBeUndefined();
    expect(r.dev2).toMatchObject({ detached: true, pid: 1 });
  });

  it("a malformed per-dispatch override is a clear refusal, never ignored", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(undefined), invoke: okLaunch });
    const r = await dispatch({ perDispatchTokens: -2 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("perDispatchTokens") });
  });
});

describe.skipIf(!entry)("#39: fleet_capacity budget visibility", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  it("shows spent/remaining and the per-dispatch caps when a budget is configured", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, budget: { dailyCostUsd: 10, dailyTokens: 1000, perDispatchCostUsd: 2, perDispatchTokens: 300 } },
      invoke: okLaunch,
    });
    const today = new Date().toISOString().slice(0, 10);
    await upsertRun(p.rootDir, le({ runId: "d1", startedAt: today + "T08:00:00Z", usage: { costUsd: 3, tokens: 200 } }));
    await upsertRun(p.rootDir, le({ runId: "d2", startedAt: (new Date(Date.now() - 86_400_000)).toISOString().slice(0, 10) + "T08:00:00Z", usage: { costUsd: 50, tokens: 5000 } }));
    const r = await p.call("fleet_capacity", {}) as { budget?: { dailyCostUsd: number; spent: { costUsd: number; tokens: number }; remainingCostUsd: number; remainingTokens: number; perDispatchCostUsd: number } };
    expect(r.budget).toMatchObject({
      dailyCostUsd: 10,
      spent: { costUsd: 3, tokens: 200 },
      remainingCostUsd: 7,
      remainingTokens: 800,
      perDispatchCostUsd: 2,
    });
  });

  it("no budget configured: no budget block at all (back-compat shape)", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: okLaunch,
    });
    const r = await p.call("fleet_capacity", {}) as { budget?: unknown };
    expect(r.budget).toBeUndefined();
  });
});

describe.skipIf(!entry)("#39: fleet_iterate budget stop", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const reply = () => nodeReply({ ok: false, summary: "still failing" });

  it("stops launching iterations once the budget is spent, escalating with a budget annotation", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, budget: { dailyCostUsd: 3 } },
      invoke: reply,
    });
    const today = new Date().toISOString().slice(0, 10);
    await upsertRun(p.rootDir, le({ runId: "drained", startedAt: today + "T08:00:00Z", usage: { costUsd: 4, tokens: 10 } }));
    const r = await p.call("fleet_iterate", { node: "dev2", cwd: "/w/proj", prompt: "fix it", maxIterations: 5 }) as {
      escalated?: boolean;
      stoppedBy?: string;
      reason?: string;
      recommendation?: string;
      retryable?: boolean;
      spent?: { costUsd: number };
      iterations?: unknown[];
    };
    expect(r.escalated).toBe(true);
    expect(r.stoppedBy).toBe("budget");
    expect(r.reason).toContain("budget exhausted");
    expect(r.recommendation).toContain("Budget stop");
    expect(r.spent).toMatchObject({ costUsd: 4 });
    expect(r.iterations).toEqual([]);
    // no node invoke for any iteration
    expect(p!.invokes).toHaveLength(0);
  });

  it("under budget: first iteration launches as before (no budget block => byte-identical)", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: reply,
    });
    const r = await p.call("fleet_iterate", { node: "dev2", cwd: "/w/proj", prompt: "fix it", maxIterations: 1 }) as { iterations?: unknown[] };
    expect(r.iterations).toHaveLength(1);
    expect(p!.invokes).toHaveLength(1);
  });
});

describe.skipIf(!entry)("#39: finished-run usage recorded on the ledger", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  it("fleet_run_status reconcile records the audit manifest's usage on the ledger entry", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: (call) => {
        if (call.params.prompt === "__RUN_STATUS__") {
          return nodeReply({ ok: true, runId: "r-usage", alive: false, state: "finished", finishedAt: new Date().toISOString(), exitCode: 0, manifest: { manifestVersion: 1, runId: "r-usage", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.3 } } });
        }
        throw new Error("unexpected invoke " + String(call.params.prompt));
      },
    });
    const startedAt = new Date().toISOString();
    await upsertRun(p.rootDir, le({ runId: "r-usage", startedAt, state: "running", updatedAt: startedAt }));
    await p.call("fleet_run_status", { node: "dev2", runId: "r-usage", includeOutput: false });
    const e = (await loadLedger(p.rootDir)).find((x) => x.runId === "r-usage");
    expect(e?.state).toBe("completed");
    expect(e?.startedAt).toBe(startedAt);
    expect(e?.usage).toEqual({ tokens: 30, costUsd: 0.3 });
  });

  it("a manifest with no usable usage records nothing; an already-recorded usage is kept", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: () => nodeReply({ ok: true, runId: "r-nou", alive: false, state: "finished", finishedAt: new Date().toISOString(), exitCode: 0, manifest: { manifestVersion: 1, runId: "r-nou" } }),
    });
    const startedAt = new Date().toISOString();
    await upsertRun(p.rootDir, le({ runId: "r-nou", startedAt, state: "running", updatedAt: startedAt, usage: { tokens: 5 } }));
    await p.call("fleet_run_status", { node: "dev2", runId: "r-nou", includeOutput: false });
    const e = (await loadLedger(p.rootDir)).find((x) => x.runId === "r-nou");
    expect(e?.usage).toEqual({ tokens: 5 });
  });
});