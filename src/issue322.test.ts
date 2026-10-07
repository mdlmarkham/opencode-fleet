/**
 * Issue #322: the shadow readiness log overstated how often S1 actually
 * answered. A fallback (`source:"baseline"`, with `fallbackReason`) wrote
 * NOTHING, and a failed `dispatch.heavy` shadowPoint was silent too. The
 * fallback rows must be logged (except when S1 is not configured at all,
 * "off" != "unavailable"), the fallbackReason must ride the row, and
 * `readinessCoverage` must summarize the log.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEntry, fakeSshMultiline, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { drainShadowDecisions, s1ShadowLogPath } from "./s1-shadow.js";
import { readinessCoverage } from "./decision-points.js";
import type { S1Fetch } from "./decision.js";

const realFetch = globalThis.fetch;

const spec = { goal: "Determine why a restart orphans the run-checkout link", acceptance: ["the cause is identified"], verify: { command: "./scripts/verify.sh" }, scope: { files: ["src/"] } };

afterEach(() => {
  if (realFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
  else (globalThis as { fetch?: unknown }).fetch = realFetch;
});

interface LoadedCtx {
  t: Loaded;
  restore: () => void;
}

async function dispatchFixture(name: string, cfg: Record<string, unknown>, fetchImpl: unknown): Promise<LoadedCtx> {
  const loaded = await loadEntry();
  if (!loaded) throw new Error(`${name}: no entry (SDK refused to load on this Node)`);
  const restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
  // The SDK's undici fetch wrapper routes through a test-injected global fetch only when it looks like a vitest mock
  // (isMockedFetch: a function with a `.mock` object), so install fakes the way issue87c's installFetch does: vi.fn-wrapped.
  const mock = vi.fn(fetchImpl as (...args: unknown[]) => Promise<unknown>) as unknown as (...args: unknown[]) => Promise<unknown>;
  (globalThis as { fetch?: unknown }).fetch = mock;
  const t = loadPlugin(loaded, {
    nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }],
    config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, ...cfg },
    invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }),
  });
  return { t, restore };
}

function teardown(ctx: LoadedCtx | undefined): void {
  if (!ctx) return;
  ctx.restore();
  ctx.t.dispose();
}

/** Parse the log's JSON lines (any kind). */
const logRows = (log: string): Array<Record<string, unknown>> => log.split("\n").filter(Boolean).flatMap((l) => {
  try {
    const e = JSON.parse(l) as Record<string, unknown>;
    return [e];
  } catch {
    return [];
  }
});

/** The readiness rows specifically. */
const readinessRows = (log: string): Array<Record<string, unknown>> => logRows(log).filter((e) => e.kind === "readiness.dispatch");

/** Poll until the shadow log gains a matching row (the append is async), or give up after ~2s. */
async function waitForAnyRows(path: string, pred: (row: Record<string, unknown>) => boolean, ms = 2000): Promise<Array<Record<string, unknown>>> {
  const end = Date.now() + ms;
  for (;;) {
    await drainShadowDecisions();
    let log = "";
    try {
      log = readFileSync(path, "utf8");
    } catch {
      log = "";
    }
    const rows = logRows(log).filter(pred);
    if (rows.length > 0 || Date.now() > end) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The dispatch result is per-node (`{dev2: {...}}`); decode the single target's row. */
function nodeResult(r: Record<string, any>): Record<string, any> {
  const row = r?.dev2 ?? Object.values(r ?? {})[0];
  if (row === undefined || row === null || typeof row !== "object") throw new Error(`no per-node result: ${JSON.stringify(r).slice(0, 200)}`);
  return row as Record<string, any>;
}

function logPath(t: Loaded): string {
  return s1ShadowLogPath(t.rootDir);
}

function dispatchDone(ctx: LoadedCtx): Promise<Record<string, any>> {
  return ctx.t.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", spec }) as Promise<Record<string, any>>;
}

describe("#322: fallback readiness judgements land in the shadow log", () => {
  it("a hung S1 (aborts on signal) logs a baseline row whose fallbackReason includes 'S1 timed out'", async () => {
    // The #311-style abort-honoring fake (the probe's `new Promise(() => {})` hangs forever).
    // The live failure is prefixed once ("S1 error: S1 timed out after Nms ..."), so match the substring.
    const hung: S1Fetch = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("This operation was aborted"))));
    const ctx = await dispatchFixture("HUNG-S1", { s1: { mode: "shadow", timeoutMs: 100 } }, hung);
    try {
      await drainShadowDecisions();
      const r = nodeResult(await dispatchDone(ctx));
      expect(r.runId).toBeDefined();
      const rows = await waitForAnyRows(logPath(ctx.t), (row) => row.source === "baseline" && String(row.fallbackReason ?? "").includes("S1 timed out"));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]).toMatchObject({ kind: "readiness.dispatch", source: "baseline", ready: expect.any(Boolean), baselineReady: expect.any(Boolean) });
      expect(rows[0].probabilities).toBeUndefined();
    } finally {
      teardown(ctx);
    }
  });

  it("healthy S1 logs an s1 row with ready, baselineReady and probabilities", async () => {
    // Probe's healthy fake, but answering in the WIRE shape (boolean -> noul; the decider maps it back).
    const healthy: S1Fetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
      return { ok: true, status: 200, json: async () => ({ model: "e2e-s1", answers, usage: { input_tokens: 3, output_tokens: 2 } }) };
    };
    const ctx = await dispatchFixture("HEALTHY-S1", { s1: { mode: "shadow", timeoutMs: 1000 } }, healthy);
    try {
      const r = nodeResult(await dispatchDone(ctx));
      expect(r.runId).toBeDefined();
      const rows = await waitForAnyRows(logPath(ctx.t), (row) => row.kind === "readiness.dispatch" && row.source === "s1");
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]).toMatchObject({ kind: "readiness.dispatch", source: "s1", ready: expect.any(Boolean), baselineReady: expect.any(Boolean), probabilities: expect.any(Object) });
    } finally {
      teardown(ctx);
    }
  });

  it("S1 not configured at all: no readiness.dispatch row is written", async () => {
    const ctx = await dispatchFixture("NO-S1", { s1: undefined }, async () => { throw new Error("S1 must not be reached when unconfigured"); });
    try {
      const r = nodeResult(await dispatchDone(ctx));
      expect(r.runId).toBeDefined();
      const rows = await waitForAnyRows(logPath(ctx.t), () => true, 700);
      expect(rows.length).toBe(0);
    } finally {
      teardown(ctx);
    }
  });
});

describe("#322: readinessCoverage summarizes the log", () => {
  it("counts judged / answeredByS1 / fellBack and buckets byReason by #311 prefixes (real wire format, with the 'S1 error: ' wrapper)", () => {
    const log: object[] = [
      { kind: "readiness.dispatch", ts: "t1", source: "s1", ready: true, baselineReady: true, probabilities: { a: 0.9 }, uncertain: [] },
      { kind: "readiness.dispatch", ts: "t2", source: "baseline", ready: false, baselineReady: false, uncertain: [], fallbackReason: "S1 error: S1 timed out after 100ms (elapsed 101ms) at http://x" },
      { kind: "readiness.dispatch", ts: "t3", source: "baseline", ready: true, baselineReady: true, uncertain: [], fallbackReason: "S1 error: S1 unreachable at http://x (ECONNREFUSED)" },
      { kind: "readiness.dispatch", ts: "t4", source: "baseline", ready: true, baselineReady: true, uncertain: [], fallbackReason: "S1 error: S1 request failed: weird" },
      { kind: "readiness.dispatch", ts: "t5", source: "baseline", ready: true, baselineReady: true, uncertain: [], fallbackReason: "S1 error: S1 rejected the request: HTTP 422 bad" },
      { kind: "readiness.dispatch", ts: "t6", source: "baseline", ready: false, baselineReady: false, uncertain: [], fallbackReason: "S1 answers were unusable" },
      { kind: "decision-point", decisionId: "dp-1" },
    ];
    const cov = readinessCoverage(log);
    expect(cov.judged).toBe(6);
    expect(cov.answeredByS1).toBe(1);
    expect(cov.fellBack).toBe(5);
    expect(cov.byReason).toMatchObject({
      "S1 timed out": 1,
      "S1 unreachable": 1,
      "S1 request failed": 1,
      "S1 rejected the request": 1,
      "S1 answers were unusable": 1,
    });
  });

  it("a real wrapped reason (the judge's 'S1 error: ' + the decider's timeout text) buckets under the stable 'S1 timed out' prefix", () => {
    // The live shape from the probe: judgeReadiness emits `S1 error: ${r.error}` and the decider (#311) names the
    // condition with per-row ms/origin — without stripping the wrapper every row buckets under its unique raw string.
    const cov = readinessCoverage([
      { kind: "readiness.dispatch", ts: "t1", source: "baseline", ready: false, baselineReady: false, uncertain: [], fallbackReason: "S1 error: S1 timed out after 15000ms" },
      { kind: "readiness.dispatch", ts: "t2", source: "baseline", ready: false, baselineReady: false, uncertain: [], fallbackReason: "S1 error: S1 timed out after 9876ms (elapsed 9912ms) at http://127.0.0.1:8009" },
    ]);
    expect(cov.fellBack).toBe(2);
    expect(cov.byReason).toMatchObject({ "S1 timed out": 2 });
  });

  it("empty and non-readiness logs give zeros", () => {
    expect(readinessCoverage([{ kind: "decision-point" }, { kind: "decision-outcome" }])).toMatchObject({ judged: 0, answeredByS1: 0, fellBack: 0 });
    expect(readinessCoverage([]).byReason).toEqual({});
  });
});

describe("#322: a failed dispatch.heavy shadowPoint is logged, never silent", () => {
  it("S1 rejects the point question -> an s1-shadow failure record names the point and the bounded error", async () => {
    const rejecting: S1Fetch = async () => ({ ok: false, status: 422, json: async () => ({ detail: "unknown type" }) });
    const ctx = await dispatchFixture("REJECT-S1", { s1: { mode: "shadow", timeoutMs: 1000 } }, rejecting);
    try {
      const r = nodeResult(await dispatchDone(ctx));
      expect(r.runId).toBeDefined();
      // Regression (review, MAJOR): the point's decision-point row is PRE-EXISTING behaviour and proves nothing —
      // runPoint turns every failure into the safe default and the fire-and-forget promise NEVER rejects, so the
      // failure record must be written inside shadowPoint's own swallow path (kind s1-shadow, questionId naming the
      // point, bounded error). This test FAILS against the pre-fix source, where nothing wrote it.
      const rows = await waitForAnyRows(logPath(ctx.t), (e) => e.kind === "s1-shadow" && (e as { questionId?: string }).questionId === "dispatch.heavy");
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const rec = rows[0] as { ok?: unknown; error?: unknown };
      expect(rec.ok).toBe(false);
      expect(String(rec.error)).toMatch(/S1 rejected the request|422|unknown type/i);
      expect(String(rec.error).length).toBeLessThanOrEqual(4000);
      // The dispatch itself is untouched: the safe-default decision-point row still exists beside the failure record.
      const dps = logRows(readFileSync(logPath(ctx.t), "utf8")).filter((e) => e.kind === "decision-point" && (e as { pointId?: string }).pointId === "dispatch.heavy");
      expect(dps.length).toBeGreaterThanOrEqual(1);
    } finally {
      teardown(ctx);
    }
  });
});

describe("#322 (minor): a probe dispatch writes NO readiness row", () => {
  it("a trivial probe prompt is not judged: the shadow log gains no readiness.dispatch row", async () => {
    // A probe IS dispatched (runId returned) but judgeReadiness returns undefined for it ("reply with exactly: OK"),
    // so the logging branch never fires — the PR's claimed coverage, made real here.
    const healthy: S1Fetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
      return { ok: true, status: 200, json: async () => ({ model: "e2e-s1", answers, usage: { input_tokens: 3, output_tokens: 2 } }) };
    };
    const ctx = await dispatchFixture("PROBE-NO-JUDGE", { s1: { mode: "shadow", timeoutMs: 1000 } }, healthy);
    try {
      const r = (await ctx.t.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", prompt: "reply with exactly: OK" })) as Record<string, any>;
      expect(r.dev2?.runId ?? Object.values(r ?? {}).find((v) => v && typeof v === "object" && "runId" in (v as object))?.runId).toBeDefined();
      await drainShadowDecisions();
      let log = "";
      try { log = readFileSync(logPath(ctx.t), "utf8"); } catch { /* no log yet */ }
      expect(logRows(log).filter((e) => e.kind === "readiness.dispatch")).toEqual([]);
    } finally {
      teardown(ctx);
    }
  });
});
