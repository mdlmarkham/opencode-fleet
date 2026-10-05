import { afterEach, describe, expect, it } from "vitest";
import { awaitRuns, clampPoll, clampTimeout, isTerminal, nextInterval, MAX_AWAIT_TIMEOUT_MS, MAX_POLL_MS, type RunSnapshot } from "./await.js";
import { upsertRun, loadLedger } from "./ledger.js";
import { loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

/** A fake clock: sleeping advances time, so no real waiting. */
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
};

describe("#180: terminal classification and clamps", () => {
  it("terminal when finished/aborted/exit code, never-started/cleaned, or a dead process", () => {
    expect(isTerminal({ state: "running", alive: true })).toBe(false);
    expect(isTerminal({ state: "finished", finishedAt: "x" })).toBe(true);
    expect(isTerminal({ state: "aborted" })).toBe(true);
    expect(isTerminal({ exitCode: 1 })).toBe(true);
    expect(isTerminal({ status: "never-started" })).toBe(true);
    expect(isTerminal({ status: "cleaned" })).toBe(true);
    expect(isTerminal({ alive: false, state: "unknown" })).toBe(true);
    expect(isTerminal({})).toBe(false);
  });
  it("clamps timeout and poll interval; backoff grows and is capped", () => {
    expect(clampTimeout(undefined)).toBe(120_000);
    expect(clampTimeout(1e12)).toBe(MAX_AWAIT_TIMEOUT_MS);
    expect(clampTimeout(5)).toBe(1_000);
    expect(clampTimeout(NaN)).toBe(120_000);
    expect(clampPoll(1)).toBe(50);
    expect(clampPoll(1e9)).toBe(MAX_POLL_MS);
    let i = 2000; for (let k = 0; k < 20; k++) i = nextInterval(i);
    expect(i).toBe(MAX_POLL_MS);
  });
});

describe("#180: awaitRuns", () => {
  const runs = [{ runId: "a", node: "n1" }, { runId: "b", node: "n1" }, { runId: "c", node: "n2" }];

  it("returns as soon as the whole set is terminal, in one call", async () => {
    const c = clock();
    const finishAt: Record<string, number> = { a: 1000, b: 5000, c: 3000 };
    let polls = 0;
    const r = await awaitRuns(runs, { timeoutMs: 60_000, pollMs: 1000 }, {
      now: c.now, sleep: c.sleep,
      poll: async (run) => { polls++; return c.at() >= finishAt[run.runId]! ? { state: "finished", exitCode: 0, finishedAt: "t" } : { state: "running", alive: true }; },
    });
    expect(r).toMatchObject({ allTerminal: true, timedOut: false, aborted: false });
    expect(r.outcomes.map((o) => o.terminal)).toEqual([true, true, true]);
    expect(c.at()).toBeLessThan(10_000);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("on timeout returns the finished runs and marks the rest pending (partials, not an error)", async () => {
    const c = clock();
    const r = await awaitRuns(runs, { timeoutMs: 10_000, pollMs: 1000 }, {
      now: c.now, sleep: c.sleep,
      poll: async (run) => (run.runId === "b" ? { state: "running", alive: true } : { state: "finished", exitCode: 0, finishedAt: "t" }),
    });
    expect(r).toMatchObject({ allTerminal: false, timedOut: true });
    expect(r.outcomes.filter((o) => !o.terminal).map((o) => o.runId)).toEqual(["b"]);
    expect(r.outcomes.find((o) => o.runId === "a")!.terminal).toBe(true);
    expect(c.at()).toBeLessThanOrEqual(10_000);
  });

  it("a poll that throws settles that run with an error and does not hang or hide the others", async () => {
    const c = clock();
    const r = await awaitRuns(runs, { timeoutMs: 5_000, pollMs: 100 }, {
      now: c.now, sleep: c.sleep,
      poll: async (run) => { if (run.runId === "a") throw new Error("node unreachable"); return { state: "finished", exitCode: 0, finishedAt: "t" }; },
    });
    expect(r.allTerminal).toBe(true);
    expect(r.outcomes[0]).toMatchObject({ runId: "a", terminal: true, error: "node unreachable" });
  });

  it("polls one run per node at a time (no burst to a single host)", async () => {
    const c = clock();
    const active: Record<string, number> = {};
    let maxPerNode = 0;
    await awaitRuns(runs, { pollMs: 100 }, {
      now: c.now, sleep: c.sleep,
      poll: async (run) => {
        active[run.node] = (active[run.node] ?? 0) + 1;
        maxPerNode = Math.max(maxPerNode, active[run.node]!);
        await Promise.resolve();
        active[run.node]! -= 1;
        return { state: "finished", exitCode: 0, finishedAt: "t" } as RunSnapshot;
      },
    });
    expect(maxPerNode).toBe(1);
  });

  it('until:"any" returns as soon as one run is terminal and leaves the rest pending (not timed out)', async () => {
    const c = clock();
    const r = await awaitRuns(runs, { timeoutMs: 60_000, pollMs: 1000, until: "any" }, {
      now: c.now, sleep: c.sleep,
      poll: async (run) => (run.runId === "c" && c.at() >= 2000 ? { state: "finished", exitCode: 0, finishedAt: "t" } : { state: "running", alive: true }),
    });
    expect(r).toMatchObject({ allTerminal: false, timedOut: false, aborted: false });
    expect(r.outcomes.filter((o) => o.terminal).map((o) => o.runId)).toEqual(["c"]);
    expect(c.at()).toBeLessThan(10_000);
  });

  it('until:"any" with nothing finishing still times out', async () => {
    const c = clock();
    const r = await awaitRuns(runs, { timeoutMs: 3_000, pollMs: 1000, until: "any" }, { now: c.now, sleep: c.sleep, poll: async () => ({ state: "running", alive: true }) });
    expect(r).toMatchObject({ allTerminal: false, timedOut: true });
  });

  it("stops promptly when aborted", async () => {
    const ctl = new AbortController();
    const c = clock();
    const r = await awaitRuns(runs, { timeoutMs: 60_000, pollMs: 100 }, {
      now: c.now, signal: ctl.signal,
      sleep: async (ms) => { c.sleep(ms); ctl.abort(); },
      poll: async () => ({ state: "running", alive: true }),
    });
    expect(r).toMatchObject({ allTerminal: false, aborted: true, timedOut: false });
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the fleet_await tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#180: fleet_await tool", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const entry = (runId: string) => ({ runId, node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", state: "running" as const });
  /** Run state as the fake node reports it; `b` finishes only after `bAfter` status reads. */
  const setup = (bAfter: number, bVerified: boolean | undefined = true) => {
    const reads: Record<string, number> = {};
    return loadPlugin(loaded!, {
      nodes: NODES,
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: (call) => {
        const runId = String(call.params.runId);
        if (call.params.prompt !== "__RUN_STATUS__") return nodeReply({ ok: true });
        reads[runId] = (reads[runId] ?? 0) + 1;
        const done = runId === "a" || reads[runId]! > bAfter;
        return nodeReply(done
          ? { ok: true, alive: false, state: "finished", exitCode: 0, startedAt: "s", finishedAt: "f", ...(bVerified === undefined ? {} : { verified: runId === "b" ? bVerified : true }) }
          : { ok: true, alive: true, state: "running", startedAt: "s" });
      },
    });
  };

  it("one call returns when the whole set is terminal, and reconciles the ledger like fleet_run_status", async () => {
    p = setup(2, false);
    await upsertRun(p.rootDir, entry("a"));
    await upsertRun(p.rootDir, entry("b"));
    const r = await p.call("fleet_await", { runIds: ["a", "b"], timeoutMs: 20_000, pollMs: 50 });
    expect(r).toMatchObject({ ok: true, allTerminal: true, timedOut: false, pending: [] });
    expect(r.runs.a).toMatchObject({ terminal: true, state: "finished", exitCode: 0 });
    // A failed gate is reported and persisted exactly as the status tool would.
    expect(r.runs.b).toMatchObject({ terminal: true, verified: false });
    const led = await loadLedger(p.rootDir);
    expect(led.find((x) => x.runId === "b")).toMatchObject({ state: "failed-verification", verified: false });
    expect(led.find((x) => x.runId === "a")).toMatchObject({ state: "completed" });
  });

  it("on timeout returns the finished run and the pending one with a hint (not an error)", async () => {
    p = setup(1_000_000);
    await upsertRun(p.rootDir, entry("a"));
    await upsertRun(p.rootDir, entry("b"));
    const r = await p.call("fleet_await", { runIds: ["a", "b"], timeoutMs: 1_000, pollMs: 50 });
    expect(r).toMatchObject({ ok: true, allTerminal: false, timedOut: true, pending: ["b"] });
    expect(r.runs.a.terminal).toBe(true);
    expect(r.runs.b).toMatchObject({ terminal: false, state: "running" });
    expect(r.hint).toContain("fleet_await");
  });

  it('until:"any" through the tool: one finished run returns early with the other pending', async () => {
    p = setup(1_000_000);
    await upsertRun(p.rootDir, entry("a"));
    await upsertRun(p.rootDir, entry("b"));
    const r = await p.call("fleet_await", { runIds: ["a", "b"], timeoutMs: 20_000, pollMs: 50, until: "any" });
    expect(r).toMatchObject({ ok: true, allTerminal: false, timedOut: false, pending: ["b"] });
    expect(r.runs.a.terminal).toBe(true);
  });

  it("an unknown run id settles with an error instead of hanging; bad input is refused", async () => {
    p = setup(0);
    await upsertRun(p.rootDir, entry("a"));
    const r = await p.call("fleet_await", { runIds: ["a", "ghost"], timeoutMs: 5_000, pollMs: 50 });
    expect(r.runs.ghost).toMatchObject({ terminal: true, error: expect.stringContaining("unknown run id") });
    expect(r.allTerminal).toBe(true);
    expect(await p.call("fleet_await", { runIds: [] })).toMatchObject({ ok: false });
    expect(await p.call("fleet_await", { runIds: Array.from({ length: 26 }, (_, i) => `r${i}`) })).toMatchObject({ ok: false, error: expect.stringContaining("at most 25") });
  });
});
