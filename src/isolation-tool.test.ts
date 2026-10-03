import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { loadLedger } from "./ledger.js";

const entry = await loadEntry();

it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the isolation tool tests really ran", () => {
  expect(entry).toBeDefined();
});

describe.skipIf(!entry)("fleet_dispatch isolation (tool level)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = (extra: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...extra });
  const ack = (over: Record<string, unknown> = {}) =>
    nodeReply({ ok: true, detached: true, runId: "r", pid: 42, isolation: "clone", runCwd: "/w/.fleet-runs/r/repo", branch: "fleet/r", sourceDirty: false, ...over });

  it("sends isolation:clone on the wire, and surfaces + records the clone path and branch from the ack", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it", isolation: "clone" });
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect(start!.params.isolation).toBe("clone");
    // the dispatch result is built after the ack; wait for the ledger to carry the clone
    const end = Date.now() + 3000;
    let entryRow = (await loadLedger(p.rootDir))[0];
    while (!entryRow?.runCwd && Date.now() < end) { await new Promise((r) => setTimeout(r, 25)); entryRow = (await loadLedger(p.rootDir))[0]; }
    expect(entryRow).toMatchObject({ cwd: "/w/proj", runCwd: "/w/.fleet-runs/r/repo", branch: "fleet/r" });
    expect(JSON.stringify(res)).toBeDefined();
  });
  it("a plain dispatch sends no isolation field", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it" });
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect("isolation" in start!.params).toBe(false);
  });
  it("the config default applies, and an explicit isolation:none overrides it", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ isolation: "clone" }), invoke: () => ack() });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "a" });
    expect((await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__"))!.params.isolation).toBe("clone");
    p.dispose();
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ isolation: "clone" }), invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "b", isolation: "none" });
    expect("isolation" in (await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__"))!.params).toBe(false);
  });
  it("refuses isolation on a non-detached run before touching the node", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x", isolation: "clone", async: false });
    expect(JSON.stringify(r)).toMatch(/needs a detached run/);
    expect(p.invokes).toHaveLength(0);
  });
  it("fleet_cleanup passes discardUnsyncedClones only when asked", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => nodeReply({ ok: true, removedRuns: [], removedClones: [], keptUnsynced: [] }) });
    await p.call("fleet_cleanup", { nodes: ["dev2"] });
    await p.call("fleet_cleanup", { nodes: ["dev2"], discardUnsyncedClones: true });
    const prunes = p.invokes.filter((c) => c.params.op === "state.prune");
    expect(prunes).toHaveLength(2);
    expect("discardUnsyncedClones" in prunes[0].params).toBe(false);
    expect(prunes[1].params.discardUnsyncedClones).toBe(true);
  });
});
