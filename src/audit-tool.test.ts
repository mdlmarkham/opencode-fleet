import { afterEach, describe, expect, it } from "vitest";
import { loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { upsertRun } from "./ledger.js";

const entry = await loadEntry();

it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the fleet_run_report tool tests really ran", () => {
  expect(entry).toBeDefined();
});

describe.skipIf(!entry)("fleet_run_report (tool level)", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false } } };
  const seed = (over: Record<string, unknown> = {}) =>
    upsertRun(p!.rootDir, { runId: "r1", node: "dev2", cwd: "/w", prompt: "fix it", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "completed", spec: { goal: "g", acceptance: ["a"] }, summary: "done", ...over } as never);

  it("asks the node for the report, and returns the manifest plus the ledger's spec", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES, config: CFG,
      invoke: () => nodeReply({ ok: true, runId: "r1", finishedAt: "2026-01-01T00:01:00Z", alive: false, manifest: { manifestVersion: 1, runId: "r1", filesChanged: [], exitCode: 0 } }),
    });
    await seed();
    const r = await p.call("fleet_run_report", { node: "dev2", runId: "r1" });
    expect(p.invokes[0].params).toMatchObject({ prompt: "__RUN_STATUS__", runId: "r1", report: true });
    expect(r).toMatchObject({ ok: true, runId: "r1", manifest: { filesChanged: [], exitCode: 0 }, run: { spec: { goal: "g" }, summary: "done" } });
  });
  it("redacts secrets in the manifest and the ledger summary on the way out", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES, config: CFG,
      invoke: () => nodeReply({ ok: true, runId: "r1", finishedAt: "2026-01-01T00:01:00Z", manifest: { commands: [{ tool: "bash", input: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' x" }] } }),
    });
    await seed({ summary: "token ghp_" + "Z".repeat(36) });
    const r = await p.call("fleet_run_report", { node: "dev2", runId: "r1" });
    const text = JSON.stringify(r);
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("ZZZZZZZZ");
  });
  it("a run that has not finished yields no manifest and says why, not an empty one", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => nodeReply({ ok: true, runId: "r1", alive: true, state: "running" }) });
    await seed({ state: "running" });
    const r = await p.call("fleet_run_report", { node: "dev2", runId: "r1" });
    expect(r).toMatchObject({ ok: false, status: "running" });
    expect("manifest" in r).toBe(false);
  });
  it("a node that predates the audit trail is reported as such (manifest: null), not as an empty run", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => nodeReply({ ok: true, runId: "r1", finishedAt: "2026-01-01T00:01:00Z", exitCode: 0 }) });
    await seed();
    const r = await p.call("fleet_run_report", { node: "dev2", runId: "r1" });
    expect(r).toMatchObject({ ok: true, manifest: null });
    expect(r.note).toMatch(/predates the audit trail/);
  });
  it("a run the node has no record of is reported with the node's status", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => nodeReply({ ok: false, status: "cleaned", error: "no run state (script/log present, state cleaned)" }) });
    const r = await p.call("fleet_run_report", { node: "dev2", runId: "gone" });
    expect(r).toMatchObject({ ok: false, status: "cleaned" });
  });
  it("an unknown node is reported and nothing is invoked", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => nodeReply({}) });
    expect(String(await p.call("fleet_run_report", { node: "nope", runId: "r" }))).toMatch(/not found/);
    expect(p.invokes).toHaveLength(0);
  });
});
