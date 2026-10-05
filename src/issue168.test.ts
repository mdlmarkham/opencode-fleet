import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noFreeSlot, pickNode, targetMode, type NodeSlots } from "./targeting.js";
import { DEFAULT_RUN_TIMEOUT_MS, buildOpenCodeCommand, endedByOf, parseOpenCodeOutput, parsePiOutput } from "./opencode.js";
import { loadLedger } from "./ledger.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const slot = (node: string, free: number | null, limit: number | null = free): NodeSlots => ({ node, free, limit });
const FLEET = [slot("dev2", 1), slot("dev3", 2)];

describe("#168: targetMode (pure)", () => {
  it("an unnamed target is refused with the nodes and their free slots", () => {
    const m = targetMode({ fleet: FLEET });
    expect(m).toMatchObject({ mode: "refuse" });
    expect(m.mode === "refuse" && m.error).toContain("dev2 (1 free)");
    expect(m.mode === "refuse" && m.error).toContain('nodes: "all"');
    expect(m.mode === "refuse" && m.error).toContain('pick: "any"');
  });
  it("explicit names, nodes:all, the operator default and a one-node fleet are accepted", () => {
    expect(targetMode({ node: "dev2", fleet: FLEET })).toEqual({ mode: "explicit", names: ["dev2"] });
    expect(targetMode({ nodes: ["dev2", "dev3"], fleet: FLEET })).toEqual({ mode: "explicit", names: ["dev2", "dev3"] });
    expect(targetMode({ nodes: "all", fleet: FLEET })).toEqual({ mode: "all" });
    expect(targetMode({ defaultTarget: "all", fleet: FLEET })).toEqual({ mode: "all" });
    expect(targetMode({ fleet: [slot("only", null)] })).toEqual({ mode: "explicit", names: ["only"] });
  });
  it("an explicit name beats the operator fan-out default", () => {
    expect(targetMode({ node: "dev2", defaultTarget: "all", fleet: FLEET })).toEqual({ mode: "explicit", names: ["dev2"] });
  });
  it("pick:any chooses among the fleet or the named nodes; bad values are errors", () => {
    expect(targetMode({ pick: "any", fleet: FLEET })).toEqual({ mode: "pick", among: "fleet" });
    expect(targetMode({ pick: "any", nodes: ["dev3"], fleet: FLEET })).toEqual({ mode: "pick", among: ["dev3"] });
    expect(targetMode({ pick: "some", fleet: FLEET })).toMatchObject({ mode: "invalid" });
    expect(targetMode({ nodes: "every", fleet: FLEET })).toMatchObject({ mode: "invalid" });
    expect(targetMode({ nodes: [1], fleet: FLEET })).toMatchObject({ mode: "invalid" });
    expect(targetMode({ pick: "any", nodes: "all", fleet: FLEET })).toMatchObject({ mode: "invalid" });
  });
  it("pickNode prefers the limited node with most room, then an unlimited one, and is undefined when all are full", () => {
    expect(pickNode([slot("a", 1), slot("b", 3), slot("c", null)])?.node).toBe("b");
    expect(pickNode([slot("a", 0, 1), slot("c", null)])?.node).toBe("c");
    expect(pickNode([slot("a", 0, 1), slot("b", 0, 2)])).toBeUndefined();
    expect(noFreeSlot([slot("a", 0, 1)])).toMatchObject({ ok: false, retryable: true, reason: "no-capacity" });
  });
});

describe("#168: timeout defaults and the limit that ended a run", () => {
  it("the default wall-clock limit is 30 minutes, in the node command too", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(1_800_000);
    expect(buildOpenCodeCommand({ prompt: "p", cwd: "/w", transport: "http" })).toContain("timeout 1800");
    expect(buildOpenCodeCommand({ prompt: "p", cwd: "/w", transport: "http", timeoutMs: 60_000 })).toContain("timeout 60");
  });
  it("endedBy says which limit ended the run (and nothing when neither did)", () => {
    expect(endedByOf("", { exitCode: 124 })).toBe("wall-clock");
    expect(endedByOf("[timeout]", {})).toBe("wall-clock");
    expect(endedByOf("[stuck: no output for 120s]", {})).toBe("idle-watchdog");
    expect(endedByOf("", { stuck: true })).toBe("idle-watchdog");
    expect(endedByOf("fine", { exitCode: 0 })).toBeUndefined();
    const good = '{"type":"text","part":{"text":"done"}}';
    expect(parseOpenCodeOutput(good, { exitCode: 124 })).toMatchObject({ ok: false, endedBy: "wall-clock" });
    expect(parseOpenCodeOutput(good, { stuck: true })).toMatchObject({ ok: false, endedBy: "idle-watchdog" });
    expect(parseOpenCodeOutput(good, { exitCode: 124 }).error).toMatch(/timed out at the wall-clock limit/);
    expect(parseOpenCodeOutput(good, { exitCode: 0 }).endedBy).toBeUndefined();
    expect(parsePiOutput("x", { exitCode: 124 })).toMatchObject({ ok: false, endedBy: "wall-clock" });
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the dispatch default tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#168: fleet_dispatch defaults (tool level)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [
    { nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] },
    { nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] },
  ];
  const cfg = (extra: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false }, dev3: { roles: ["worker"], ssh: false } }, ...extra });
  const ok = () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
  const dispatch = (args: Record<string, unknown> = {}) => p!.call("fleet_dispatch", { cwd: "/w/proj", prompt: "do it", ...args }) as Promise<Record<string, any>>;
  const starts = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_START__");

  it("no node named in a two-node fleet: refused, lists the nodes, starts nothing", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 2 } }), invoke: ok });
    const r = await dispatch();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("no target node given") });
    expect(r.nodes.map((n: { node: string; free: number }) => [n.node, n.free])).toEqual([["dev2", 2], ["dev3", 2]]);
    expect(starts()).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toHaveLength(0);
  });

  it('nodes:"all" fans out, and dispatch.defaultTarget:"all" restores the old default', async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg(), invoke: ok });
    await dispatch({ nodes: "all" });
    expect(starts()).toHaveLength(2);
    p.dispose();
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ dispatch: { defaultTarget: "all" } }), invoke: ok });
    await dispatch();
    expect(starts()).toHaveLength(2);
  });

  it("a single-node fleet needs no node name", async () => {
    p = loadPlugin(loaded!, { nodes: [NODES[0]!], config: { nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: ok });
    await dispatch();
    expect(starts()).toHaveLength(1);
  });

  it('pick:"any" runs on exactly one node with a free slot, skipping a full one', async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 1 } }), invoke: ok });
    await dispatch({ node: "dev2" });
    const r = await dispatch({ pick: "any" });
    expect(r.dev3?.reason).toBeUndefined();
    expect(r.dev2).toBeUndefined();
    const led = await loadLedger(p.rootDir);
    expect(led.filter((e) => e.node === "dev3")).toHaveLength(1);
    expect(led.filter((e) => e.node === "dev2")).toHaveLength(1);
  });

  it('pick:"any" with every node full returns a retryable no-capacity and starts nothing', async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 1 } }), invoke: ok });
    await dispatch({ node: "dev2" });
    await dispatch({ node: "dev3" });
    const before = starts().length;
    const r = await dispatch({ pick: "any" });
    expect(r).toMatchObject({ ok: false, retryable: true, reason: "no-capacity" });
    expect(starts().length).toBe(before);
  });

  it("the launch carries a 30-minute timeout by default; the operator default and a per-call value override it", async () => {
    p = loadPlugin(loaded!, { nodes: [NODES[0]!], config: { nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: ok });
    await dispatch();
    expect(starts()[0]!.params.timeoutMs).toBe(1_800_000);
    p.dispose();
    p = loadPlugin(loaded!, { nodes: [NODES[0]!], config: { defaultTimeoutMs: 900_000, nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: ok });
    await dispatch();
    expect(starts()[0]!.params.timeoutMs).toBe(900_000);
    await dispatch({ timeoutMs: 60_000 });
    expect(starts()[1]!.params.timeoutMs).toBe(60_000);
  });

  it("a short timeout on a multi-criterion spec warns; the default does not", async () => {
    p = loadPlugin(loaded!, { nodes: [NODES[0]!], config: { nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: ok });
    const spec = { goal: "g", acceptance: ["a", "b"], verify: { command: "scripts/check.sh" }, scope: { files: ["src/"] } };
    const short = await p.call("fleet_dispatch", { cwd: "/w/proj", spec, timeoutMs: 120_000 });
    expect(short.warnings?.[0]).toContain("under 10 minutes");
    const dflt = await p.call("fleet_dispatch", { cwd: "/w/proj", spec });
    expect(dflt.warnings).toBeUndefined();
  });

  const one = (project?: Record<string, unknown>) => loadPlugin(loaded!, { nodes: [NODES[0]!], config: { ...(project ? { project } : {}), nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: ok });

  it("a prompt-only dispatch says verification is none under advise (default); nothing under off", async () => {
    p = one();
    expect((await dispatch()).verification).toMatchObject({ gate: "none" });
    p.dispose();
    p = one({ gate: "off" });
    expect((await dispatch()).verification).toBeUndefined();
  });

  it("enforce refuses a dispatch with no verify gate; a gate (expect or spec.verify) is accepted without the note", async () => {
    p = one({ gate: "enforce" });
    expect(await dispatch()).toMatchObject({ ok: false, error: expect.stringContaining("no verification gate") });
    expect(starts()).toHaveLength(0);
    const gated = await dispatch({ expect: { files: ["out.txt"] } });
    expect(gated.verification).toBeUndefined();
    expect(gated.dev2?.ok === false).toBe(false);
    p.dispose();
    p = one();
    expect((await dispatch({ expect: { files: ["out.txt"] } })).verification).toBeUndefined();
  });
});
