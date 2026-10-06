/**
 * Issue #87, slice 4 tests — the SHADOW-ONLY live call site.
 *
 * Layout:
 *   1. UNIT (s1-shadow.ts):
 *        - buildShadowDecider gate: undefined for `off` / invalid config; a decider
 *          otherwise; never throws; sink/fetch/decider injectable (no network).
 *        - shadowRecord: bounded record `{ok, answer?, error?, meta}`; CATCHES
 *          everything (a throwing/rejecting/non-function decider, a failing
 *          sink); the caller never sees a throw.
 *        - shadowFileSink: private+atomic JSONL appends; a failing
 *          serialization never throws.
 *        - trackShadow/drainShadowDecisions: rejected fire-and-forget promises
 *          are defused and drainable.
 *   2. END-TO-END (index.ts fleet_dispatch, in-process, stubbed child_process
 *      and injected S1 fetch — no network):
 *        - DEFAULT INVARIANT: with NO `s1` config block the fetch/decider is
 *          NEVER constructed, no S1 call happens, and the dispatch result keys
 *          (and ledger keys) are unchanged.
 *        - shadow configured: exactly one S1 call, a record logged to the
 *          shadow file, and the dispatch result/ledger UNCHANGED (no new keys).
 *        - enforce configured: still records-only — even with a threshold the
 *          dispatch would have been blocked by, nothing changes.
 *        - `off` / invalid config: nothing at all.
 *        - S1 outage (fetch rejects) and a LITERALLY THROWING decider: the
 *          dispatch is unaffected and the failure is recorded as an error.
 *   3. WIRING CONTRACT (index.ts / s1-shadow.ts source): lazy guarded import,
 *      no static import, and no combineWithStatic anywhere in the shadow path.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLedger } from "./ledger.js";
import type {
  DeciderLike,
  ShadowDispatchRequest,
  ShadowDeps,
  ShadowEntry,
  ShadowRecordDeps,
} from "./s1-shadow.js";
import type { DecideInput, FleetAnswer } from "./decision.js";
import { gatewaySrc } from "./testkit/src.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Spy/mock control for the shadow module: disarmed (default) = the REAL module
// passes through untouched; armed = buildShadowDecider/recordDispatchShadow
// record their calls and (for recordDispatchShadow) inject `shadowCtl.decider`
// into the real implementation.
// ---------------------------------------------------------------------------

const shadowCtl = vi.hoisted(() => ({
  armed: false,
  buildCalls: [] as unknown[],
  dispatchCalls: [] as unknown[],
  decider: undefined as unknown,
}));

vi.mock("./s1-shadow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./s1-shadow.js")>();
  return {
    ...actual,
    buildShadowDecider: (cfg: unknown, deps?: unknown) => {
      if (!shadowCtl.armed) return actual.buildShadowDecider(cfg, deps as ShadowDeps | undefined);
      shadowCtl.buildCalls.push({ cfg, deps });
      return shadowCtl.decider as DeciderLike | undefined;
    },
    recordDispatchShadow: (cfg: unknown, req: unknown, rootDir?: string, deps?: unknown) => {
      if (!shadowCtl.armed) {
        return actual.recordDispatchShadow(cfg, req as ShadowDispatchRequest, rootDir, deps as ShadowRecordDeps | undefined);
      }
      shadowCtl.dispatchCalls.push({ cfg, req, rootDir });
      // Still run the REAL dispatch shadow, with the injectable decider when armed.
      const injected = shadowCtl.decider ? { decider: shadowCtl.decider as DeciderLike } : undefined;
      return actual.recordDispatchShadow(cfg, req as ShadowDispatchRequest, rootDir, injected);
    },
  };
});

// The dispatch path probes the run cwd over REAL ssh (issue #26). Stub the
// transport exactly like issue87c: the probe gets a passing FLEET_CWD=ok report.
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
import {
  DISPATCH_ROUTE_CANDIDATES,
  DISPATCH_ROUTE_QUESTION_ID,
  SHADOW_RECORD_MAX_CHARS,
  buildShadowDecider,
  drainShadowDecisions,
  recordDispatchShadow,
  s1ShadowLogPath,
  shadowFileSink,
  shadowRecord,
  trackShadow,
} from "./s1-shadow.js";

// ---------------------------------------------------------------------------
// Shared stubs — fake deciders/sinks/fetch. No network anywhere.
// ---------------------------------------------------------------------------

function okDecider(answer: FleetAnswer): DeciderLike {
  return async (input) => {
    const id = Object.keys(input.questions)[0];
    return {
      ok: true,
      model: "stub-s1",
      answers: { [id]: answer },
      usage: { input_tokens: 10, output_tokens: 5 },
      meta: { backend: "local-kev", mode: "shadow", effectiveMode: "shadow", latencyMs: 1, warnings: [] },
    };
  };
}

const throwingDecider: DeciderLike = async () => {
  throw new Error("fake decider exploded");
};

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. buildShadowDecider
// ---------------------------------------------------------------------------

describe("issue #79b: buildShadowDecider gate", () => {
  it("returns undefined for mode 'off' and for every invalid config, and never throws", () => {
    expect(buildShadowDecider({ mode: "off" })).toBeUndefined();
    expect(buildShadowDecider({ mode: "nope" })).toBeUndefined();
    expect(buildShadowDecider({ backend: "made-up" })).toBeUndefined();
    expect(buildShadowDecider({ thresholds: { x: 5 } })).toBeUndefined();
    expect(buildShadowDecider("garbage")).toBeUndefined();
    expect(buildShadowDecider(42)).toBeUndefined();
    expect(buildShadowDecider(() => "fn")).toBeUndefined();
    expect(buildShadowDecider({ timeoutMs: -1 })).toBeUndefined();
  });

  it("returns a decider for shadow AND enforce mode (enforce stays records-only this slice)", () => {
    expect(typeof buildShadowDecider({ mode: "shadow" })).toBe("function");
    const enforce = buildShadowDecider({ mode: "enforce", thresholds: { "dispatch.route": 0.5 } });
    expect(typeof enforce).toBe("function");
    expect((enforce as unknown as { config?: { mode?: string } }).config?.mode).toBe("enforce");
  });

  it("returns the injected decider untouched (identity, no construction)", () => {
    const fake = okDecider({ type: "boolean", probabilityTrue: 0.5 });
    expect(buildShadowDecider({ mode: "shadow" }, { decider: fake })).toBe(fake);
  });

  it("builds a makeDecider with the INJECTED sink: every call is audited to the sink, no network", async () => {
    const entries: unknown[] = [];
    const decider = buildShadowDecider({ mode: "shadow" }, {
      sink: (e) => {
        entries.push(e);
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "stub-s1",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }),
    });
    expect(typeof decider).toBe("function");
    const r = (await decider!(
      {
        state: { spec: "task" },
        questions: { q: { type: "boolean", instructions: "ok?" } },
      },
    )) as { ok: boolean; meta?: { mode: string } };
    expect(r.ok).toBe(true);
    expect(r.meta?.mode).toBe("shadow");
    // 0.9 with no threshold for the question is fine here: combineWithStatic is
    // NOT this module's job — shadow only records.
    expect(entries).toHaveLength(1);
    const e0 = entries[0] as { kind: string; ok: boolean; questionIds: string[] };
    expect(e0.kind).toBe("decision");
    expect(e0.ok).toBe(true);
    expect(e0.questionIds).toEqual(["q"]);
  });
});

// ---------------------------------------------------------------------------
// 2. shadowRecord — the bounded record; everything is caught
// ---------------------------------------------------------------------------

const REQ = {
  questionId: "q1",
  state: { spec: "the task" },
  question: { type: "boolean", instructions: "ok?" } as const,
};

describe("issue #79b: shadowRecord (bounded record, never throws)", () => {
  it("happy path: records { kind, ts, questionId, ok:true, answer, meta } and calls the sink", async () => {
    const answer = { type: "boolean", probabilityTrue: 0.7 } as const;
    const sinkEntries: object[] = [];
    const rec = await shadowRecord(okDecider(answer), REQ, { sink: (e) => void sinkEntries.push(e) });
    expect(rec.ok).toBe(true);
    expect(rec.questionId).toBe("q1");
    expect(rec.kind).toBe("s1-shadow");
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.answer).toEqual(answer);
    expect(rec.error).toBeUndefined();
    expect((rec.meta as { effectiveMode?: string }).effectiveMode).toBe("shadow");
    expect(sinkEntries).toEqual([rec]);
  });

  it("a structured {ok:false} decision is recorded as an error", async () => {
    const rec = await shadowRecord(async () => ({ ok: false, error: "S1 returned HTTP 503" }), REQ);
    expect(rec.ok).toBe(false);
    expect(rec.error).toContain("503");
    expect(rec.answer).toBeUndefined();
  });

  it("a LITERALLY THROWING decider (sync throw or rejected promise) is recorded as an error, never rethrown", async () => {
    const syncThrow = async () => {
      throw new Error("boom-sync");
    };
    const rejected = async () => Promise.reject(new Error("boom-promise"));
    for (const bad of [syncThrow, rejected, throwingDecider]) {
      const rec = await shadowRecord(bad, REQ);
      expect(rec.ok).toBe(false);
      expect(rec.error).toMatch(/^decider threw: (boom-|fake decider exploded)/);
      expect(rec.answer).toBeUndefined();
      expect((rec.meta as { threw?: boolean }).threw).toBe(true);
    }
  });

  it("a non-function decider and an empty result are recorded as errors, never thrown", async () => {
    const rec1 = await shadowRecord(undefined as unknown as DeciderLike, REQ);
    expect(rec1.ok).toBe(false);
    expect(rec1.error).toContain("not a function");
    const rec2 = await shadowRecord(async () => undefined, REQ);
    expect(rec2.ok).toBe(false);
    expect(rec2.error).toContain("unavailable");
  });

  it("a THROWING sink is swallowed: the record still returns", async () => {
    const rec = await shadowRecord(okDecider({ type: "boolean", probabilityTrue: 0.9 }), REQ, {
      sink: () => {
        throw new Error("log exploded");
      },
    });
    expect(rec.ok).toBe(true);
    expect(rec.answer).toEqual({ type: "boolean", probabilityTrue: 0.9 });
  });

  it("records are BOUNDED: oversized strings/meta are capped (default and explicit maxChars)", async () => {
    const huge = "x".repeat(10 * SHADOW_RECORD_MAX_CHARS);
    // A huge STRING answer must be capped (+1 for the ellipsis); `answer` is
    // capped via boundedText/JSON, so assert on its serialized length.
    const recStr = await shadowRecord(async () => ({ ok: true, answers: { q1: huge } }), REQ);
    expect(JSON.stringify(recStr.answer).length).toBeLessThanOrEqual(SHADOW_RECORD_MAX_CHARS + 3);
    const recErr = await shadowRecord(async () => ({ ok: false, error: huge }), REQ);
    expect(recErr.error!.length).toBeLessThanOrEqual(SHADOW_RECORD_MAX_CHARS + 1);
    const recBig = await shadowRecord(
      async () => ({ ok: true, answers: { q1: { type: "boolean", probabilityTrue: 0.5 } }, meta: { warnings: [huge] } }),
      REQ,
      { maxChars: 50 },
    );
    expect(JSON.stringify(recBig.meta).length).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// 3. shadowFileSink — private, atomic JSONL appends; never throws
// ---------------------------------------------------------------------------

describe("issue #79b: shadowFileSink (private + atomic JSONL)", () => {
  let rootDir = "";
  afterEach(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("appends one JSON line per entry, in a 0700 dir with a 0600 file", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const sink = shadowFileSink(rootDir);
    await sink({ kind: "a" });
    await sink({ kind: "b" });
    const path = s1ShadowLogPath(rootDir);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ kind: "a" });
    expect(JSON.parse(lines[1])).toEqual({ kind: "b" });
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
    expect(statSync(join(rootDir, ".opencode-fleet")).mode & 0o077).toBe(0);
  });

  it("an unserializable entry (circular / BigInt) never throws and writes nothing", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const sink = shadowFileSink(rootDir);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(sink({ circular })).resolves.toBeUndefined();
    await expect(sink({ n: 1n })).resolves.toBeUndefined();
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
  });

  it("writes under <rootDir>/.opencode-fleet/s1-shadow.jsonl", () => {
    expect(s1ShadowLogPath("/m")).toBe(join("/m", ".opencode-fleet", "s1-shadow.jsonl"));
  });
});

// ---------------------------------------------------------------------------
// 4. recordDispatchShadow / trackShadow — fire-and-forget that tests can drain
// ---------------------------------------------------------------------------

describe("issue #79b: recordDispatchShadow (fire-and-forget; drains deterministically)", () => {
  let rootDir = "";
  afterEach(async () => {
    await drainShadowDecisions();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("with an injected decider it records the dispatch route question boundedly", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    recordDispatchShadow({ mode: "shadow" }, { task: "do the thing", cwd: "/w/repo" }, rootDir, { decider: okDecider({ type: "boolean", probabilityTrue: 0.8 }) });
    await drainShadowDecisions();
    const lines = readFileSync(s1ShadowLogPath(rootDir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as ShadowEntry;
    expect(rec.kind).toBe("s1-shadow");
    expect(rec.questionId).toBe(DISPATCH_ROUTE_QUESTION_ID);
    expect(rec.ok).toBe(true);
  });

  it("s1 'off' records NOTHING (no file, no call)", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    recordDispatchShadow({ mode: "off" }, { task: "t", cwd: "/w" }, rootDir);
    await drainShadowDecisions();
    await settle();
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
  });

  it("invalid config records NOTHING", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    recordDispatchShadow("garbage", { task: "t", cwd: "/w" }, rootDir);
    await drainShadowDecisions();
    await settle();
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
  });

  it("trackShadow defuses rejections: drain never throws and clears", async () => {
    let sawUnhandled = false;
    const onUnhandled = (): void => {
      sawUnhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);
    trackShadow(Promise.reject(new Error("boom")));
    await drainShadowDecisions();
    process.removeListener("unhandledRejection", onUnhandled);
    expect(sawUnhandled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. END-TO-END: the real fleet_dispatch execute, in-process
// ---------------------------------------------------------------------------

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

function makeEnv(opts: { rootDir: string; s1?: unknown }) {
  const invokeCalls: InvokeReq[] = [];
  const registered = new Map<string, Tool>();
  const api = {
    pluginConfig: {
      nodes: { dev2: { roles: ["worker"], ssh: true, user: "svcuser" } },
      // These tests pin what S1 does to a dispatch; the design gate (#117) has its own tests.
      project: { gate: "off" },
      ...(opts.s1 !== undefined ? { s1: opts.s1 } : {}),
    },
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
          if (req.params?.runId !== undefined) {
            return { payload: { ok: true, detached: true, runId: req.params.runId, pid: 4242 } };
          }
          return { payload: { ok: true, exitCode: 0, summary: "did the work" } };
        },
      },
    },
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  const dispatch = registered.get("fleet_dispatch");
  if (!dispatch) throw new Error("fleet_dispatch was not registered");
  return { dispatch, invokeCalls };
}

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

/** A working fake S1 over the injected fetch (no network): answers score questions. */
function s1OverFetch(scores: number[], opts?: { reject?: boolean }): FetchSpy {
  return installFetch(async (_url, init) => {
    if (opts?.reject) throw new Error("connect ECONNREFUSED 127.0.0.1:8009");
    const body = JSON.parse(init?.body ?? "{}") as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = {
        type: "score",
        score: 1,
        confidence: 0.9,
        probabilities: Object.fromEntries(scores.map((p, i) => [String(i), p])),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: "e2e-s1", answers, usage: { input_tokens: 3, output_tokens: 2 } }),
    };
  });
}

function s1Forbidden(): FetchSpy {
  return installFetch(async () => {
    throw new Error("S1 must not be contacted on this dispatch path");
  });
}

async function runDispatch(tool: Tool, params: unknown): Promise<Record<string, unknown>> {
  const res = (await tool.execute("e2e", params, new AbortController().signal)) as {
    details: Record<string, unknown>;
  };
  return res.details;
}

const CWD = "/srv/work/repo";
const TASK = "do the thing";

/** The exact per-node + ledger shapes today's detached happy path produces. */
const TODAY_NODE_KEYS = ["ackPending", "detached", "note", "pid", "runId"];
const TODAY_LEDGER_KEYS = ["cwd", "node", "nodeId", "pid", "prompt", "runId", "startedAt", "state", "transport", "updatedAt"];

function expectUnchangedDispatchShape(details: Record<string, unknown>): void {
  expect(Object.keys(details)).toEqual(["dev2"]);
  expect(Object.keys(details["dev2"] as Record<string, unknown>).sort()).toEqual(TODAY_NODE_KEYS);
  expect(JSON.stringify(details)).not.toContain('"s1"');
}

/** Poll for the shadow records of a dispatch (waits for the tracked decision to land). */
async function shadowRecords(
  rootDir: string,
  assert: (recs: ShadowEntry[], allLines: number, kinds: string[]) => void,
): Promise<void> {
  const path = s1ShadowLogPath(rootDir);
  await vi.waitFor(() => {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as ShadowEntry);
    const recs = parsed.filter((e) => e.kind === "s1-shadow");
    const kinds = parsed.map((e) => String(e.kind));
    assert(recs, lines.length, kinds);
  }, { timeout: 2000, interval: 25 });
}

describe("issue #79b e2e: fleet_dispatch DEFAULT — no s1 config (invariant)", () => {
  let rootDir = "";
  afterEach(async () => {
    restoreFetch();
    await drainShadowDecisions();
    shadowCtl.armed = false;
    shadowCtl.buildCalls.length = 0;
    shadowCtl.dispatchCalls.length = 0;
    shadowCtl.decider = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("with NO s1 block: fetch/decider NOT constructed, no S1 call, result + ledger byte-identical to today", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    shadowCtl.armed = true; // spy on decider construction / shadow wiring
    const { dispatch } = makeEnv({ rootDir });
    const spy = s1Forbidden(); // any S1 contact would throw AND be observable
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });

    // The shadow wiring never even ran: nothing imported, nothing built.
    await drainShadowDecisions();
    await settle();
    expect(shadowCtl.dispatchCalls).toHaveLength(0);
    expect(shadowCtl.buildCalls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    // No shadow log was created.
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
    // The dispatch result keys are exactly today's; no new fields anywhere.
    expectUnchangedDispatchShape(details);
    const ledger = await loadLedger(rootDir);
    expect(ledger).toHaveLength(1);
    expect(Object.keys(ledger[0]).sort()).toEqual(TODAY_LEDGER_KEYS);
  });

  it("with NO s1 block, a spec dispatch is equally untouched", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    shadowCtl.armed = true;
    const { dispatch } = makeEnv({ rootDir });
    const spy = s1Forbidden();
    const details = await runDispatch(dispatch, { spec: { goal: "add a flag", acceptance: ["flag builds"] }, cwd: CWD });
    await drainShadowDecisions();
    await settle();
    expect(shadowCtl.dispatchCalls).toHaveLength(0);
    expect(shadowCtl.buildCalls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    expectUnchangedDispatchShape(details);
  });
});

describe("issue #79b e2e: fleet_dispatch with s1 configured (shadow records-only)", () => {
  let rootDir = "";
  afterEach(async () => {
    restoreFetch();
    await drainShadowDecisions();
    shadowCtl.armed = false;
    shadowCtl.buildCalls.length = 0;
    shadowCtl.dispatchCalls.length = 0;
    shadowCtl.decider = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  it("shadow: EXACTLY one S1 call, one bounded record in the log, dispatch result + ledger unchanged", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch, invokeCalls } = makeEnv({ rootDir, s1: { mode: "shadow" } });
    const spy = s1OverFetch([0.9, 0.1]);
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();

    // One fire-and-forget S1 call, asking the dispatch-route question.
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0] as unknown as [string, { body: string }];
    expect(call[0]).toBe("http://127.0.0.1:8009/v1/systemone");
    const body = JSON.parse(call[1].body) as {
      state?: { spec?: string; cwd?: string; candidates?: string[] };
      questions: Record<string, { type: string; criteria?: string[]; instructions?: string }>;
    };
    expect(body.state).toEqual({ spec: TASK, cwd: CWD, candidates: [...DISPATCH_ROUTE_CANDIDATES] });
    expect(Object.keys(body.questions)).toEqual([DISPATCH_ROUTE_QUESTION_ID]);
    expect(body.questions[DISPATCH_ROUTE_QUESTION_ID]).toMatchObject({
      type: "score",
      criteria: [...DISPATCH_ROUTE_CANDIDATES],
    });
    expect(body.questions[DISPATCH_ROUTE_QUESTION_ID]?.instructions).toContain(TASK);

    // Issue #102: ONE record per dispatch (the double-write was merged).
    await shadowRecords(rootDir, (recs, allLines, kinds) => {
      expect(allLines).toBe(1);
      expect(kinds).toEqual(["s1-shadow"]);
      expect(recs).toHaveLength(1);
      expect(recs[0].ok).toBe(true);
      expect(recs[0].questionId).toBe(DISPATCH_ROUTE_QUESTION_ID);
      expect(recs[0].answer).toMatchObject({ type: "score", probabilities: [0.9, 0.1] });
      expect(recs[0].meta).toMatchObject({ effectiveMode: "shadow", backend: "local-kev", mode: "shadow" });
    });

    // The record is shadow-only: nothing in the dispatch result or ledger changed.
    expectUnchangedDispatchShape(details);
    const ledger = await loadLedger(rootDir);
    expect(ledger).toHaveLength(1);
    expect(Object.keys(ledger[0]).sort()).toEqual(TODAY_LEDGER_KEYS);
    expect(Object.keys(invokeCalls[0]?.params ?? {})).not.toContain("s1");
  });

  it("shadow with a spec: the RENDERED prompt rides to S1; results unchanged", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch } = makeEnv({ rootDir, s1: { mode: "shadow" } });
    const spy = s1OverFetch([0.9, 0.1]);
    const details = await runDispatch(dispatch, {
      spec: { goal: "add a flag", acceptance: ["flag builds", "tests pass"] },
      cwd: CWD,
    });
    await drainShadowDecisions();
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((spy.mock.calls[0] as unknown as [unknown, { body: string }])[1].body) as {
      state?: { spec?: string };
    };
    expect(body.state?.spec).toContain("add a flag");
    expect(body.state?.spec).toContain("Acceptance criteria:");
    await shadowRecords(rootDir, (recs) => expect(recs).toHaveLength(1));
    expectUnchangedDispatchShape(details);
  });

  it("enforce: STILL records-only — even a threshold that would block changes nothing", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch } = makeEnv({ rootDir, s1: { mode: "enforce", thresholds: { "dispatch.route": 0.01 } } });
    const spy = s1OverFetch([0.9, 0.1]); // 0.9 >= 0.01: combineWithStatic would block — it is NOT consulted
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();
    expect(spy).toHaveBeenCalledTimes(1);
    await shadowRecords(rootDir, (recs) => {
      expect(recs).toHaveLength(1);
      expect(recs[0].ok).toBe(true);
      expect(recs[0].meta).toMatchObject({ effectiveMode: "enforce" });
    });
    expectUnchangedDispatchShape(details); // the dispatch RAN, unchanged
  });

  it("s1 mode 'off': no S1 call, no shadow log, results unchanged", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch } = makeEnv({ rootDir, s1: { mode: "off" } });
    const spy = s1Forbidden();
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
    expectUnchangedDispatchShape(details);
  });

  it("invalid s1 config: no S1 call, no shadow log, results unchanged", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch } = makeEnv({ rootDir, s1: "garbage" });
    const spy = s1Forbidden();
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(() => statSync(s1ShadowLogPath(rootDir))).toThrow();
    expectUnchangedDispatchShape(details);
  });

  it("S1 outage (fetch rejects): the dispatch is unaffected and the failure is recorded as an error", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    const { dispatch } = makeEnv({ rootDir, s1: { mode: "shadow" } });
    s1OverFetch([0.9, 0.1], { reject: true });
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();
    expectUnchangedDispatchShape(details);
    await shadowRecords(rootDir, (recs, allLines) => {
      expect(allLines).toBe(1); // issue #102: one record per dispatch
      expect(recs).toHaveLength(1);
      expect(recs[0].ok).toBe(false);
      expect(typeof recs[0].error).toBe("string");
      expect(recs[0].error!.length).toBeGreaterThan(0);
    });
  });

  it("a LITERALLY THROWING decider: the dispatch is unaffected and the throw is recorded as an error", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet79b-"));
    shadowCtl.armed = true;
    shadowCtl.decider = throwingDecider;
    const { dispatch } = makeEnv({ rootDir, s1: { mode: "shadow" } });
    const spy = s1Forbidden(); // no transport reached: the decider itself throws first
    const details = await runDispatch(dispatch, { prompt: TASK, cwd: CWD });
    await drainShadowDecisions();
    expect(shadowCtl.dispatchCalls).toHaveLength(1); // one fire-and-forget shadow decision
    expect(spy).not.toHaveBeenCalled();
    expectUnchangedDispatchShape(details);
    await shadowRecords(rootDir, (recs) => {
      expect(recs).toHaveLength(1);
      expect(recs[0].ok).toBe(false);
      expect(recs[0].error).toContain("fake decider exploded");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Wiring contract in the source: lazy, guarded, and enforcement-free
// ---------------------------------------------------------------------------

describe("issue #79b wiring contract", () => {
  const dispatchSrc = gatewaySrc();
  const shadowSrc = readFileSync(join(here, "s1-shadow.ts"), "utf8");

  it("the shadow module loads lazily: exactly ONE dynamic import, inside the s1 guard, no static import", () => {
    expect((dispatchSrc.match(/import\("\.\/s1-shadow\.js"\)/g) ?? ["x"]).length).toBe(1);
    expect(dispatchSrc.match(/from "\.\/s1-shadow\.js";/g)).toBeNull();
    // The guard is the s1 config block itself: absent => the import never runs.
    expect(dispatchSrc).toContain("if (cfg.s1 != null) {");
    expect(dispatchSrc.indexOf("if (cfg.s1 != null) {")).toBeLessThan(dispatchSrc.indexOf('import("./s1-shadow.js")'));
  });

  it("the shadow path can never enforce: no combineWithStatic anywhere on it", () => {
    // The CODE must never import combineWithStatic; the name may legitimately
    // appear in a doc comment (which explains that it does not), so strip
    // comments before asserting.
    const shadowCode = shadowSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(shadowCode).not.toContain("combineWithStatic");
    expect(shadowSrc).not.toMatch(/from "\.\/s1-wire\.js"/);
    // Scope to the dispatch tool block: the wiring call is a plain records-only fire.
    const dispatchToolSrc = dispatchSrc.slice(
      dispatchSrc.indexOf("name: \"fleet_dispatch\""),
      dispatchSrc.indexOf("name: \"fleet_resume\""),
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(dispatchToolSrc).toContain("recordDispatchShadow");
    expect(dispatchToolSrc).not.toContain("combineWithStatic");
  });
});