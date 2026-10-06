/**
 * Issue #87, slice 3 tests — wiring the S1 hooks into live dispatch.
 *
 * Three layers:
 *   1. HARDENING (s1-hooks.ts): a decideFn that THROWS is treated exactly
 *      like a structured { ok: false } on all three hooks (fallbacks:
 *      satisfied=null / escalate / engine=null) — it never propagates.
 *   2. WIRING HELPERS (s1-wire.ts): opt-in `route` (S1 picks the harness
 *      from a candidate list; invalid pick / S1 down => caller's harness
 *      stands) and opt-in `autoTriage` (a RECOMMENDATION on a hand-raise,
 *      never an auto-answer).
 *   3. END-TO-END WIRING (index.ts fleet_dispatch): with neither flag the
 *      dispatch makes NO S1 call and adds NO fields (byte-identical);
 *      with the flags the picks/surfaces land in the results and the ledger.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { adjudicateCompletion, routeEngine, triageHandRaise, type DecideFn } from "./s1-hooks.js";
import {
  parseRouteOptIn,
  s1RouteHarness,
  s1TriageIfRequested,
  triageContextFromRun,
} from "./s1-wire.js";
import { loadLedger } from "./ledger.js";
import type { DecideInput, FleetAnswer } from "./decision.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Shared stubs (unit layer) — same pattern as issue87b: capture the calls,
// replay canned answers, no network.
// ---------------------------------------------------------------------------

type DecideCalls = DecideInput[];

function okDecide(answer: FleetAnswer, calls?: DecideCalls): DecideFn {
  return async (input) => {
    calls?.push(input);
    const id = Object.keys(input.questions)[0];
    return {
      ok: true,
      model: "stub-s1",
      answers: { [id]: answer },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  };
}

function failingDecide(calls?: DecideCalls, error = "S1 returned HTTP 503"): DecideFn {
  return async (input) => {
    calls?.push(input);
    return { ok: false, error };
  };
}

function throwingDecide(calls?: DecideCalls, toThrow: unknown = new Error("boom")): DecideFn {
  return async (input) => {
    calls?.push(input);
    throw toThrow;
  };
}

function rejectingDecide(calls?: DecideCalls, toReject: unknown = new Error("boom-promise")): DecideFn {
  return async (input) => {
    calls?.push(input);
    return Promise.reject(toReject);
  };
}

function scoreDecide(probabilities: number[], calls?: DecideCalls): DecideFn {
  return okDecide(
    {
      type: "score",
      score: 1,
      confidence: 0.9,
      probabilities: [...probabilities],
    },
    calls,
  );
}

function choiceDecide(choice: string, reason?: string, calls?: DecideCalls): DecideFn {
  return okDecide({ type: "choice", choice, reason }, calls);
}

// ---------------------------------------------------------------------------
// 1. Hardening: a throwing decideFn is exactly { ok: false } on every hook
// ---------------------------------------------------------------------------

const ADJUDICATE_INPUT = {
  acceptance: ["tests green"],
  diffSummary: "+120/-4 across 3 files",
  verifyDetails: "npm test: 211 passed, 0 failed",
};

describe("issue #87c hardening: a throwing decideFn never propagates", () => {
  it("adjudicateCompletion throws-proof: satisfied=null, reason names the throw", async () => {
    for (const bad of [throwingDecide(), rejectingDecide()]) {
      const r = await adjudicateCompletion(ADJUDICATE_INPUT, bad);
      expect(r.satisfied).toBe(null);
      expect(r.confidence).toBeUndefined();
      expect(r.reason).toMatch(/^S1 unavailable: decideFn threw: /);
    }
  });

  it("triageHandRaise throws-proof: action=escalate, reason names the throw", async () => {
    for (const bad of [throwingDecide(), rejectingDecide()]) {
      const r = await triageHandRaise({ question: "Which branch?", context: "run used branch b" }, bad);
      expect(r.action).toBe("escalate");
      expect(r.reason).toMatch(/^S1 unavailable: decideFn threw: /);
    }
  });

  it("routeEngine throws-proof: engine=null, reason names the throw", async () => {
    for (const bad of [throwingDecide(), rejectingDecide()]) {
      const r = await routeEngine({ spec: "build the thing", candidates: ["opencode", "pi"] }, bad);
      expect(r.engine).toBe(null);
      expect(r.reason).toMatch(/^S1 unavailable: decideFn threw: /);
    }
  });

  it("the wrapper wraps the REAL call: the decideFn is actually invoked before falling back", async () => {
    const calls: DecideCalls = [];
    const r = await adjudicateCompletion(ADJUDICATE_INPUT, throwingDecide(calls));
    expect(r.satisfied).toBe(null);
    expect(calls).toHaveLength(1); // asked, then hardened — an ok:false shape with the throw named
  });

  it("a non-Error throw value (string) is still stringified, not swallowed", async () => {
    const r = await adjudicateCompletion(ADJUDICATE_INPUT, throwingDecide(undefined, "exploded"));
    expect(r.satisfied).toBe(null);
    expect(r.reason).toBe("S1 unavailable: decideFn threw: exploded");
  });

  it("a decideFn that is not a function at all falls back (throwing is caught)", async () => {
    const junk = "not-a-function" as unknown as DecideFn;
    const adj = await adjudicateCompletion(ADJUDICATE_INPUT, junk);
    expect(adj.satisfied).toBe(null);
    expect(adj.reason).toMatch(/^S1 unavailable: decideFn threw: /);
    const tri = await triageHandRaise({ question: "q", context: "c" }, junk);
    expect(tri).toEqual({ action: "escalate", reason: expect.stringMatching(/^S1 unavailable: decideFn threw: /) });
    const route = await routeEngine({ spec: "s", candidates: ["opencode"] }, junk);
    expect(route.engine).toBe(null);
    expect(route.reason).toMatch(/^S1 unavailable: decideFn threw: /);
  });

  it("a well-behaved decideFn is untouched: ok:false still maps to the same fallbacks", async () => {
    const adj = await adjudicateCompletion(ADJUDICATE_INPUT, failingDecide(undefined, "S1 returned HTTP 503"));
    expect(adj.satisfied).toBe(null);
    expect(adj.reason).toBe("S1 unavailable: S1 returned HTTP 503");
    const tri = await triageHandRaise({ question: "q", context: "c" }, failingDecide());
    expect(tri.action).toBe("escalate");
    const route = await routeEngine({ spec: "s", candidates: ["opencode"] }, failingDecide());
    expect(route.engine).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 2. s1-wire: opt-in `route` — S1 picks the dispatch harness
// ---------------------------------------------------------------------------

describe("issue #87c route: parseRouteOptIn (fail-closed param validation)", () => {
  it("absent / null => routing off", () => {
    expect(parseRouteOptIn(undefined)).toEqual({ ok: true, route: undefined });
    expect(parseRouteOptIn(null)).toEqual({ ok: true, route: undefined });
  });

  it("a well-formed candidates list parses, entries trimmed", () => {
    const r = parseRouteOptIn({ candidates: ["opencode", " pi "] });
    expect(r).toEqual({ ok: true, route: { candidates: ["opencode", "pi"] } });
  });

  it("malformed route is refused, never corrected", () => {
    for (const bad of [
      "bogus",
      42,
      [],
      {},
      { candidates: [] },
      { candidates: "opencode" },
      { candidates: ["opencode", ""] },
      { candidates: ["opencode", 7] },
      { candidates: ["opencode", "   "] },
    ]) {
      expect(parseRouteOptIn(bad).ok).toBe(false);
    }
    expect(parseRouteOptIn(42 as unknown)).toMatchObject({ ok: false });
    expect(parseRouteOptIn({ candidates: [] })).toMatchObject({
      ok: false,
      error: "route.candidates must be a non-empty array of engine names",
    });
  });
});

describe("issue #87c route: s1RouteHarness", () => {
  it("DEFAULT (no route): the harness passes through and the S1 client is NEVER called", async () => {
    const calls: DecideCalls = [];
    // A stub that would FAIL the test if reached proves the no-op path.
    const never = throwingDecide(calls, new Error("S1 must not be contacted without opt-in"));
    const r = await s1RouteHarness({ harness: "opencode", route: undefined, specText: "the task" }, never);
    expect(r).toEqual({ harness: "opencode", changed: false });
    expect(calls).toHaveLength(0);
  });

  it("DEFAULT with no caller harness: harness stays undefined, no S1 call", async () => {
    const calls: DecideCalls = [];
    const never = throwingDecide(calls);
    const r = await s1RouteHarness({ harness: undefined, route: undefined, specText: "task" }, never);
    expect(r).toEqual({ harness: undefined, changed: false });
    expect(calls).toHaveLength(0);
  });

  it("OPT-IN: a valid harness pick REPLACES the caller's harness", async () => {
    const calls: DecideCalls = [];
    const r = await s1RouteHarness(
      { harness: "opencode", route: { candidates: ["pi", "opencode"] }, specText: "render the config loader" },
      scoreDecide([0.9, 0.1], calls),
    );
    expect(r).toEqual({
      harness: "pi",
      changed: true,
      decision: { engine: "pi", reason: 'S1 ranked "pi" highest (probability 0.9)', applied: true },
    });
    expect(calls).toHaveLength(1);
    const q = calls[0].questions;
    const ids = Object.keys(q);
    expect(ids).toEqual(["engine"]);
    expect(q["engine"].type).toBe("score");
    expect(q["engine"].type === "score" ? q["engine"].criteria : undefined).toEqual(["pi", "opencode"]);
    expect(calls[0].state).toEqual({ spec: "render the config loader", candidates: ["pi", "opencode"] });
  });

  it("OPT-IN with no caller harness: pick becomes the harness", async () => {
    const r = await s1RouteHarness(
      { harness: undefined, route: { candidates: ["pi", "opencode"] }, specText: "task" },
      scoreDecide([0.8, 0.2]),
    );
    expect(r.harness).toBe("pi");
    expect(r.changed).toBe(true);
  });

  it("OPT-IN: a pick that is NOT a valid harness is ignored — the caller's harness stands", async () => {
    const calls: DecideCalls = [];
    const withCaller = await s1RouteHarness(
      { harness: "opencode", route: { candidates: ["codex", "opencode"] }, specText: "task" },
      scoreDecide([0.9, 0.1], calls), // S1 picks "codex"
    );
    expect(withCaller).toEqual({
      harness: "opencode",
      changed: false,
      decision: { engine: "codex", reason: 'S1 ranked "codex" highest (probability 0.9)', applied: false },
    });
    expect(calls).toHaveLength(1);

    const withoutCaller = await s1RouteHarness(
      { harness: undefined, route: { candidates: ["codex"] }, specText: "task" },
      scoreDecide([1]),
    );
    expect(withoutCaller).toEqual({
      harness: undefined,
      changed: false,
      decision: { engine: "codex", reason: expect.any(String), applied: false },
    });
  });

  it("OPT-IN: S1 unavailable (ok:false) keeps the caller's harness (today's behaviour)", async () => {
    const calls: DecideCalls = [];
    const r = await s1RouteHarness(
      { harness: "opencode", route: { candidates: ["pi", "opencode"] }, specText: "task" },
      failingDecide(calls, "S1 returned HTTP 503"),
    );
    expect(r.harness).toBe("opencode");
    expect(r.changed).toBe(false);
    expect(r.decision).toEqual({ engine: null, reason: "S1 unavailable: S1 returned HTTP 503", applied: false });
    expect(calls).toHaveLength(1); // routing was really attempted, then fell back
  });

  it("OPT-IN: an even throwing/undefined decideFn cannot break the dispatch (hooks are hardened)", async () => {
    const r = await s1RouteHarness(
      { harness: "opencode", route: { candidates: ["pi", "opencode"] }, specText: "task" },
      throwingDecide(undefined, new Error("connection refused")),
    );
    expect(r.harness).toBe("opencode");
    expect(r.decision).toEqual({ engine: null, reason: expect.stringMatching(/S1 unavailable: decideFn threw: /), applied: false });
    const junk = 42 as unknown as DecideFn;
    const r2 = await s1RouteHarness({ harness: "opencode", route: { candidates: ["pi"] }, specText: "t" }, junk);
    expect(r2.harness).toBe("opencode");
    expect(r2.decision?.applied).toBe(false);
  });

  it("OPT-IN: empty task text falls back WITHOUT calling S1", async () => {
    const calls: DecideCalls = [];
    const r = await s1RouteHarness(
      { harness: "opencode", route: { candidates: ["pi", "opencode"] }, specText: "  " },
      throwingDecide(calls),
    );
    expect(r.harness).toBe("opencode");
    expect(r.changed).toBe(false);
    expect(r.decision).toEqual({ engine: null, reason: "task spec is empty", applied: false });
    expect(calls).toHaveLength(0);
  });

  it("ties break to the candidate order and duplicates collapse to the first occurrence", async () => {
    const calls: DecideCalls = [];
    const r = await s1RouteHarness(
      { harness: undefined, route: { candidates: ["opencode", "pi"] }, specText: "task" },
      scoreDecide([0.5, 0.5], calls),
    );
    expect(r.harness).toBe("opencode"); // first in criteria order
    const scoreQ = calls[0].questions["engine"];
    expect(scoreQ.type === "score" ? scoreQ.criteria : undefined).toEqual(["opencode", "pi"]);
  });
});

// ---------------------------------------------------------------------------
// 3. s1-wire: opt-in `autoTriage` — a recommendation, never an auto-answer
// ---------------------------------------------------------------------------

describe("issue #87c triage: s1TriageIfRequested", () => {
  it("DEFAULT (autoTriage off/absent): returns nothing and NEVER calls S1", async () => {
    const calls: DecideCalls = [];
    const never = throwingDecide(calls);
    expect(await s1TriageIfRequested({ autoTriage: undefined, question: "q?", context: "ctx" }, never)).toBeUndefined();
    expect(await s1TriageIfRequested({ autoTriage: false, question: "q?", context: "ctx" }, never)).toBeUndefined();
    expect(await s1TriageIfRequested({}, never)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("OPT-IN but no hand-raise (no question): returns nothing, no S1 call", async () => {
    const calls: DecideCalls = [];
    const r = await s1TriageIfRequested(
      { autoTriage: true, question: undefined, context: "ctx" },
      throwingDecide(calls),
    );
    expect(r).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("OPT-IN + hand-raise: surfaces the S1 recommendation", async () => {
    const calls: DecideCalls = [];
    const r = await s1TriageIfRequested(
      { autoTriage: true, question: "Which branch should I target?", context: "worker summary: ran on branch b" },
      choiceDecide("answer", "the summary says branch b", calls),
    );
    expect(r).toEqual({ action: "answer", reason: 'S1 chose "answer": the summary says branch b' });
    expect(calls).toHaveLength(1);
    const q = calls[0].questions["handRaise"];
    expect(q.type).toBe("choice");
    expect(q.type === "choice" ? q.criteria : undefined).toEqual({
      answer: "the run context already answers this",
      escalate: "a human/manager decision is required",
    });
    expect(calls[0].state).toEqual({
      question: "Which branch should I target?",
      context: "worker summary: ran on branch b",
    });
  });

  it("OPT-IN + S1 unavailable/throwing: escalates", async () => {
    const down = await s1TriageIfRequested(
      { autoTriage: true, question: "q?", context: "ctx" },
      failingDecide(undefined, "S1 returned HTTP 503"),
    );
    expect(down).toEqual({ action: "escalate", reason: "S1 unavailable: S1 returned HTTP 503" });
    const threw = await s1TriageIfRequested({ autoTriage: true, question: "q?", context: "ctx" }, throwingDecide());
    expect(threw).toEqual({ action: "escalate", reason: expect.stringMatching(/decideFn threw: /) });
  });

  it("the recommendation is advisory: the helper never mutates anything and returns only {action, reason}", async () => {
    const runPayload = {
      ok: true,
      handRaised: true,
      question: "Should I include the test?",
      summary: "worked, then stopped to ask",
    };
    const r = await s1TriageIfRequested(
      { autoTriage: true, question: runPayload.question, context: "worker summary: worked, then stopped to ask" },
      choiceDecide("answer"),
    );
    expect(r?.action).toBe("answer");
    // The run object passed by the caller is untouched — the helper returns a
    // standalone recommendation.
    expect(runPayload).toEqual({
      ok: true,
      handRaised: true,
      question: "Should I include the test?",
      summary: "worked, then stopped to ask",
    });
  });
});

describe("issue #87c triage: triageContextFromRun", () => {
  it("joins the run's own output into a bounded context", () => {
    const ctx = triageContextFromRun({
      summary: "worker finished the parser",
      verifyDetails: { verified: false, missing: ["dist/x.js"] },
      treeState: { ok: true, uncommitted: 0 },
    });
    expect(ctx).toEqual(
      [
        "worker summary: worker finished the parser",
        'verify details: {"verified":false,"missing":["dist/x.js"]}',
        'working tree: {"ok":true,"uncommitted":0}',
      ].join("\n"),
    );
  });

  it("drops empty/missing parts and keeps only meaningful text", () => {
    expect(triageContextFromRun({ summary: "   ", verifyDetails: undefined, treeState: null })).toBe("");
    expect(triageContextFromRun({ summary: "only this" })).toBe("worker summary: only this");
  });

  it("caps long parts so the S1 request stays bounded", () => {
    const long = "x".repeat(5000);
    const ctx = triageContextFromRun({ summary: long });
    expect(ctx.startsWith("worker summary: ")).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual("worker summary: ".length + 2001);
    expect(ctx.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. END-TO-END wiring: the real fleet_dispatch execute, in-process
// ---------------------------------------------------------------------------

// The dispatch path probes the run cwd over REAL ssh (issue #26). These tests
// stub the transport: the probe gets a passing FLEET_CWD=ok report instead.
const cwdProbe = vi.hoisted(() => ({
  stdout: "FLEET_CWD=ok",
  calls: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  const execFileMock = (
    file: string,
    args: readonly string[],
    options: unknown,
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    void file;
    cwdProbe.calls.push(String(args[args.length - 1] ?? ""));
    cb(null, cwdProbe.stdout, "");
    return undefined as unknown as import("node:child_process").ChildProcess;
  };
  // Same (err, stdout, stderr) -> {stdout, stderr} promise shape as the real execFile,
  // via the promisify.custom hook (util.promisify returns fn[custom] DIRECTLY,
  // so the hook must be the promise function itself, not a builder).
  (execFileMock as unknown as Record<symbol, unknown>)[CUSTOM] = (
    file: string,
    args: readonly string[],
    options?: unknown,
  ) =>
    new Promise((resolve, reject) => {
      execFileMock(file, args, options, (err: unknown, stdout: string, stderr: string) => {
        if (err != null) {
          (err as { stdout?: string }).stdout = stdout;
          (err as { stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { ...actual, execFile: execFileMock };
});

import entry from "./index.js";

interface InvokeReq {
  nodeId: string;
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type Tool = {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
};

function makeEnv(opts: {
  runPayload: Record<string, unknown>;
  rootDir: string;
}) {
  const invokeCalls: InvokeReq[] = [];
  const registered = new Map<string, Tool>();
  const api = {
    pluginConfig: { project: { gate: "off" }, nodes: { dev2: { roles: ["worker"], ssh: true, user: "svcuser" } } },
    rootDir: opts.rootDir,
    registerNodeInvokePolicy: () => {},
    registerTool: (tool: Tool) => {
      registered.set(tool.name, tool);
    },
    runtime: {
      nodes: {
        list: async () => ({
          nodes: [{ nodeId: "n-1", displayName: "dev2", invocableCommands: ["opencode.run"] }],
        }),
        invoke: async (req: InvokeReq) => {
          invokeCalls.push(req);
          const prompt = String(req.params?.prompt ?? "");
          if (prompt === "__RUN_STATUS__") {
            return { payload: { probed: true, alive: false, state: "finished", finishedAt: "t" } };
          }
          if (prompt === "__STATUS__") {
            return { payload: { ok: true, note: "clean tree" } };
          }
          // Detached launch (sentinel + runId present) or a synchronous run.
          if (req.params?.runId !== undefined) {
            return { payload: { ok: true, detached: true, runId: req.params.runId, pid: 4242 } };
          }
          return { payload: opts.runPayload };
        },
      },
    },
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  const dispatch = registered.get("fleet_dispatch");
  if (!dispatch) throw new Error("fleet_dispatch was not registered");
  return { dispatch, invokeCalls };
}

/** S1 over the global fetch transport (the wiring's default client). */
type AnyFetch = (url: unknown, init?: { body?: string }) => Promise<unknown>;
type FetchSpy = ReturnType<typeof vi.fn>;

const realFetch = globalThis.fetch;
let fetchRestore: (() => void) | undefined;

function restoreFetch(): void {
  fetchRestore?.();
  fetchRestore = undefined;
}

function installFetch(impl: AnyFetch): FetchSpy {
  restoreFetch();
  const mock = vi.fn(impl as unknown as (...args: unknown[]) => Promise<unknown>) as unknown as FetchSpy;
  (globalThis as { fetch?: unknown }).fetch = mock;
  fetchRestore = () => {
    (globalThis as { fetch?: unknown }).fetch = realFetch;
  };
  return mock;
}

/** A working fake S1: answers the (single) question asked with `scores`/`choice`. */
function s1OverFetch(reply: { choice?: string; reason?: string; scores?: number[] }): FetchSpy {
  return installFetch(async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as { questions: Record<string, { type: string; criteria: unknown }> };
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] =
        body.questions[id].type === "score"
          ? {
              type: "score",
              score: 1,
              confidence: 0.9,
              probabilities: Object.fromEntries((reply.scores ?? []).map((p, i) => [String(i), p])),
            }
          : { type: "choice", choice: reply.choice, reason: reply.reason };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "e2e-s1",
        answers,
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    };
  });
}

/** An S1 outage: the transport fails like a dead endpoint (connection refused). */
function s1Outage(): FetchSpy {
  return installFetch(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8009");
  });
}

/** A tripwire: an S1 contact in the default path would throw AND be observable. */
function s1Forbidden(): FetchSpy {
  return installFetch(async () => {
    throw new Error("S1 must not be contacted in the default dispatch path");
  });
}

async function runDispatch(tool: Tool, params: unknown): Promise<Record<string, unknown>> {
  const res = (await tool.execute("e2e", params, new AbortController().signal)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  expect(res.details).toBeTypeOf("object");
  return res.details;
}

const ROOT = { runPayload: { ok: true, exitCode: 0, summary: "did the work" } };
const CWD = "/srv/work/repo";

describe("issue #87c e2e: fleet_dispatch DEFAULT — neither opt-in flag (invariant)", () => {
  let rootDir: string;
  afterEach(() => {
    restoreFetch();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("no S1 call, no s1 fields: result and launcher are byte-identical to today", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    cwdProbe.calls.length = 0;
    const { dispatch, invokeCalls } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1Forbidden();
    const details = await runDispatch(dispatch, { prompt: "do the thing", cwd: CWD });

      // No S1 call happened at all.
      expect(spy).not.toHaveBeenCalled();
      // No s1 key anywhere in the results.
      expect(details["s1"]).toBeUndefined();
      expect(JSON.stringify(details)).not.toContain('"s1"');
      expect(JSON.stringify(details)).not.toContain("route");
      // Top-level keys are exactly the node keys (no new fields).
      expect(Object.keys(details)).toEqual(["dev2"]);
      const node = details["dev2"] as Record<string, unknown>;
      // The detached happy-path shape today: nothing added.
      expect(Object.keys(node).sort()).toEqual(["ackPending", "detached", "note", "pid", "runId"].sort());
      expect(node).toEqual({
        runId: expect.any(String),
        detached: true,
        pid: 4242,
        ackPending: false,
        note: expect.stringContaining("launched detached"),
      });
      // The launcher was invoked with the caller's (absent) harness.
      const launch = invokeCalls[0];
      expect(invokeCalls).toHaveLength(1);
      expect(launch.command).toBe("opencode.run");
      expect((launch.params as Record<string, unknown>).harness).toBeUndefined();
      // The ledger entry is identical to today's: no S1 fields, harness absent.
      const ledger = await loadLedger(rootDir);
      expect(ledger).toHaveLength(1);
      expect(Object.keys(ledger[0]).sort()).toEqual(
        ["cwd", "node", "pid", "prompt", "runId", "startedAt", "state", "transport", "updatedAt"].sort(),
      );
      expect(ledger[0].harness).toBeUndefined();
  });
});

describe("issue #87c e2e: fleet_dispatch `route` (opt-in)", () => {
  let rootDir: string;
  afterEach(() => {
    restoreFetch();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("S1 picks a VALID harness: the dispatch runs with it (launcher + ledger), the pick surfaces", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch, invokeCalls } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1OverFetch({ scores: [0.9, 0.1] }); // pi first in the list
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      route: { candidates: ["pi", "opencode"] },
      piModel: "prov/m",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // The routed pick replaced the harness for the real launcher call.
    const launch = invokeCalls[0];
    expect(invokeCalls).toHaveLength(1);
    expect((launch.params as Record<string, unknown>).harness).toBe("pi");
    expect((launch.params as Record<string, unknown>).piModel).toBe("prov/m");
    // The pick is surfaced opt-in only.
    expect(Object.keys(details)).toEqual(["s1", "dev2"]);
    expect(details["s1"]).toEqual({
      route: { engine: "pi", reason: expect.stringContaining('S1 ranked "pi"'), applied: true },
    });
    // The ledger records the routed harness.
    const ledger = await loadLedger(rootDir);
    expect(ledger[0].harness).toBe("pi");
    expect(ledger[0].piModel).toBe("prov/m");
    // The S1 request carried the task text + candidates.
    const req = JSON.parse(String((spy.mock.calls[0] as unknown as [unknown, { body: string }])[1]?.body)) as {
      state: unknown;
      questions: Record<string, { type: string; criteria?: unknown }>;
    };
    expect(req.state).toEqual({ spec: "do the thing", candidates: ["pi", "opencode"] });
    const q = req.questions["engine"];
    expect(q).toMatchObject({ type: "score", criteria: ["pi", "opencode"] });
  });

  it("S1 picks a NON-harness candidate: ignored, the caller's harness is kept", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch, invokeCalls } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1OverFetch({ scores: [0.9, 0.1] }); // "codex" wins
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      harness: "opencode",
      route: { candidates: ["codex", "opencode"] },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const launch = invokeCalls[0];
    expect((launch.params as Record<string, unknown>).harness).toBe("opencode");
    expect(details["s1"]).toEqual({
      route: { engine: "codex", reason: expect.any(String), applied: false },
    });
    // No pi-model refusal leaked in through the ignored pick.
    expect(Object.keys(details)).toEqual(["s1", "dev2"]);
  });

  it("S1 DOWN: caller's harness kept — today's behaviour — with the miss surfaced", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch, invokeCalls } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1Outage();
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      harness: "opencode",
      route: { candidates: ["pi", "opencode"] },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const launch = invokeCalls[0];
    expect((launch.params as Record<string, unknown>).harness).toBe("opencode");
    expect(details["s1"]).toEqual({
      route: { engine: null, reason: expect.stringMatching(/^S1 unavailable: S1 request failed: /), applied: false },
    });
    const ledger = await loadLedger(rootDir);
    expect(ledger[0].harness).toBe("opencode");
  });

  it("malformed route is refused and S1 is never called", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1Outage();
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      route: { candidates: [] },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(details).toEqual({
      ok: false,
      error: "invalid route: route.candidates must be a non-empty array of engine names",
    });
  });
});

const HAND_RAISE_RUN = {
  ok: true,
  exitCode: 0,
  summary: "did the work, then asked",
  handRaised: true,
  question: "Which branch should I target?",
};

describe("issue #87c e2e: fleet_dispatch `autoTriage` (opt-in)", () => {
  let rootDir: string;
  afterEach(() => {
    restoreFetch();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("hand-raise + autoTriage: surfaces an S1 recommendation and does NOT alter the run", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    // A/B: the same dispatch run WITHOUT autoTriage, then WITH it.
    const plain = makeEnv({ runPayload: HAND_RAISE_RUN, rootDir });
    const plainSpy = s1Outage(); // would fail the test if the default path called S1
    const plainDetails = await runDispatch(plain.dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      async: false,
    });
    expect(plainSpy).not.toHaveBeenCalled();
    expect(plain.invokeCalls).toHaveLength(2); // the run + the status probe, nothing else

    const triaged = makeEnv({ runPayload: HAND_RAISE_RUN, rootDir });
    const spy = s1OverFetch({ choice: "answer", reason: "the run summary names branch b" });
    const details = await runDispatch(triaged.dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      async: false,
      autoTriage: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(triaged.invokeCalls).toHaveLength(2); // triage adds NO invoke: no auto-answer re-dispatch

    const node = details["dev2"] as Record<string, unknown>;
    // ONLY an advisory recommendation is added...
    expect(node["s1"]).toEqual({
      triage: { action: "answer", reason: 'S1 chose "answer": the run summary names branch b' },
    });
    // ...and the run itself is untouched: identical to the plain dispatch
    // minus the s1 field, still handRaised, no auto-answer re-dispatch.
    const plainNode = plainDetails["dev2"] as Record<string, unknown>;
    expect({ ...node, s1: undefined, runId: undefined }).toEqual({ ...plainNode, runId: undefined });
    expect(plainNode["s1"]).toBeUndefined();
    const runResult = node["result"] as { payload: Record<string, unknown> };
    expect(runResult.payload).toEqual(HAND_RAISE_RUN);
    expect(node["runId"]).toBeTypeOf("string");
    expect(node["verified"]).toBe(null);
    expect(node["verifyDetails"]).toBe(null);
    // The triage request carried the question + the run's own context.
    const req = JSON.parse(String((spy.mock.calls[0] as unknown as [unknown, { body: string }])[1]?.body)) as {
      state: { question: string; context: string };
    };
    expect(req.state.question).toBe("Which branch should I target?");
    expect(req.state.context).toContain("worker summary: did the work, then asked");
    expect(req.state.context).toContain("working tree:");
  });

  it("the SAME dispatch without autoTriage is identical minus the s1 field (no S1 call)", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch, invokeCalls } = makeEnv({ runPayload: HAND_RAISE_RUN, rootDir });
    const spy = s1Outage(); // would fail the test if S1 were ever contacted
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      async: false,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(Object.keys(details)).toEqual(["dev2"]);
    const node = details["dev2"] as Record<string, unknown>;
    expect(JSON.stringify(node)).not.toContain('"s1"');
    expect(node["result"]).toEqual({ payload: HAND_RAISE_RUN });
    expect(invokeCalls).toHaveLength(2); // run + status probe, nothing else
  });

  it("autoTriage + S1 down: action=escalate is surfaced, the run is unchanged", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch, invokeCalls } = makeEnv({ runPayload: HAND_RAISE_RUN, rootDir });
    const spy = s1Outage();
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      async: false,
      autoTriage: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const node = details["dev2"] as Record<string, unknown>;
    expect(node["s1"]).toEqual({
      triage: { action: "escalate", reason: expect.stringMatching(/^S1 unavailable: S1 request failed: /) },
    });
    expect((node["result"] as { payload: Record<string, unknown> }).payload).toEqual(HAND_RAISE_RUN);
    expect(invokeCalls).toHaveLength(2);
  });

  it("autoTriage without a hand-raise: no s1 field, no S1 call", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet87c-"));
    const { dispatch } = makeEnv({ runPayload: ROOT.runPayload, rootDir });
    const spy = s1Outage();
    const details = await runDispatch(dispatch, {
      prompt: "do the thing",
      cwd: CWD,
      async: false,
      autoTriage: true,
    });
    expect(spy).not.toHaveBeenCalled();
    const node = details["dev2"] as Record<string, unknown>;
    expect(node["s1"]).toBeUndefined();
    expect(Object.keys(node).sort()).toEqual(
      ["result", "runId", "treeState", "verified", "verifyDetails"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The wiring contract in index.ts: opt-in guards, S1 surfaced shapes,
//    and no S1 in the default path.
// ---------------------------------------------------------------------------

describe("issue #87c wiring contract (index.ts)", () => {
  const dispatchSrc = readFileSync(join(here, "index.ts"), "utf8");

  it("the dispatch schema declares both opt-in flags with default-off semantics", () => {
    expect(dispatchSrc).toMatch(/route: \{\n\s+type: "object",\n\s+additionalProperties: false,\n\s+description: "Opt-in S1 engine routing/);
    expect(dispatchSrc).toMatch(/candidates: \{ type: "array", items: \{ type: "string" \}/);
    expect(dispatchSrc).toMatch(/autoTriage: \{ type: "boolean", description: "OPT-IN S1 triage \(default false/);
  });

  it("routing runs only when `route` is present (no S1 call, no field otherwise)", () => {
    expect(dispatchSrc).toContain("let routed: S1RouteHarnessResult = { harness: p.harness, changed: false };");
    expect(dispatchSrc).toContain("if (p.route !== undefined) {");
    // The routing decision surfaces only under the opt-in guard.
    expect(dispatchSrc).toContain("if (s1RouteDecision) results.s1 = { route: s1RouteDecision };");
  });

  it("the routed harness replaces p.harness everywhere in the DISPATCH (validation, launcher, ledger)", () => {
    // Scope to the fleet_dispatch tool block: the other fleet tools
    // (fleet_iterate etc.) legitimately keep their own `harness: p.harness`.
    const dispatchToolSrc = dispatchSrc.slice(
      dispatchSrc.indexOf("name: \"fleet_dispatch\""),
      dispatchSrc.indexOf("name: \"fleet_resume\""),
    );
    expect(dispatchToolSrc).toContain("const harnessCheck = validateHarnessTransport({ harness: routed.harness, transport });");
    expect(dispatchToolSrc).toContain("const piModel = routed.harness === \"pi\"");
    expect(dispatchToolSrc).toContain("harness: routed.harness,");
    // Only two legit `p.harness` mentions remain: the fallback seed and the
    // routing call argument (S1 falls back to the CALLER's harness).
    expect((dispatchToolSrc.match(/harness: p\.harness,/g) ?? [""])).toHaveLength(2);
    // The effective harness feeds validation, the launcher, and the ledger.
    expect((dispatchToolSrc.match(/harness: routed\.harness/g) ?? [""])).toHaveLength(3);
  });

  it("triage runs only opt-in AND on a hand-raise; the recommendation is the ONLY added field", () => {
    expect(dispatchSrc).toContain("if (p.autoTriage === true && parsedResult.handRaised === true) {");
    expect(dispatchSrc).toContain("...(s1Triage ? { s1: { triage: s1Triage } } : {}),");
    expect(dispatchSrc).toContain("s1TriageIfRequested({");
    // The run result object itself is never rewritten by the triage hook.
    expect(dispatchSrc).toContain("result: dispatchResult,");
  });

  it("S1 loads lazily: a type-only import plus exactly two in-guard dynamic loads", () => {
    expect(dispatchSrc).toContain('import type { TriageResult } from "./s1-hooks.js";');
    expect(dispatchSrc).toContain('import type { S1RouteDecision, S1RouteHarnessResult } from "./s1-wire.js";');
    // Exactly two dynamic loads, each inside an opt-in guard — the default
    // dispatch path imports nothing from S1.
    expect(dispatchSrc.split('await import("./s1-wire.js")').length - 1).toBe(2);
    // The only static ./s1-wire import is the TYPE import.
    expect(dispatchSrc.match(/from "\.\/s1-wire\.js";/g) ?? [""]).toHaveLength(1);
  });
});