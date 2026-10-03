import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { upsertRun, loadLedger } from "./ledger.js";

const entry = await loadEntry();
const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { contracts: { tools: string[] } };

// Locally on an unsupported Node these skip; in CI they must not (a silent skip would
// hide a regression of the Node pin), so CI asserts the entry actually loaded.
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the tool-level tests below really ran", () => {
  expect(entry).toBeDefined();
});

describe.skipIf(!entry)("tool-level tests (the real plugin entry against a fake host)", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false } } };

  it("registers exactly the tools the manifest declares, each with a description, schema and execute", () => {
    p = loadPlugin(entry!, { nodes: NODES, config: CFG });
    expect([...p.tools.keys()].sort()).toEqual([...manifest.contracts.tools].sort());
    for (const t of p.tools.values()) {
      expect(typeof t.execute, t.name).toBe("function");
      expect(typeof t.description, t.name).toBe("string");
      expect((t.parameters as { type?: string }).type, t.name).toBe("object");
    }
    expect(p.policies.length).toBeGreaterThan(0); // the opencode.run invoke policy
  });

  describe("fleet_abort", () => {
    const seed = async (runs: Array<Record<string, unknown>>) => {
      for (const r of runs) {
        await upsertRun(p!.rootDir, { runId: "x", node: "dev2", cwd: "/w", prompt: "t", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "completed", ...r } as never);
      }
    };
    const aborted = nodeReply({ ok: true, aborted: true, confirmed: true });

    it("passes an explicit runId straight to the node", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => aborted });
      await p.call("fleet_abort", { node: "dev2", runId: "run-1" });
      expect(p.invokes).toHaveLength(1);
      expect(p.invokes[0].params).toMatchObject({ prompt: "__ABORT__", runId: "run-1" });
    });
    it("resolves a sessionId to the NEWEST in-flight run on that node, ignoring other nodes and sessions", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => aborted });
      await seed([
        { runId: "old-done", sessionId: "s1", state: "completed", startedAt: "2026-01-01T00:00:00Z" },
        { runId: "live-1", sessionId: "s1", state: "running", startedAt: "2026-01-02T00:00:00Z" },
        { runId: "live-2", sessionId: "s1", state: "running", startedAt: "2026-01-03T00:00:00Z" },
        { runId: "other-node", sessionId: "s1", state: "running", node: "dev3", startedAt: "2026-01-09T00:00:00Z" },
        { runId: "other-session", sessionId: "s2", state: "running", startedAt: "2026-01-09T00:00:00Z" },
      ]);
      await p.call("fleet_abort", { node: "dev2", sessionId: "s1" });
      expect(p.invokes[0].params).toMatchObject({ runId: "live-2", sessionId: "s1" });
    });
    it("with neither a usable runId nor a known session it refuses WITHOUT calling the node", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => aborted });
      const none = await p.call("fleet_abort", { node: "dev2" });
      const unknown = await p.call("fleet_abort", { node: "dev2", sessionId: "never-seen" });
      for (const r of [none, unknown]) expect(r).toMatchObject({ ok: false, aborted: false, error: expect.stringMatching(/runId required/) });
      expect(p.invokes).toHaveLength(0);
    });
    it("an unknown node is reported, and nothing is invoked", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => aborted });
      const r = await p.call("fleet_abort", { node: "nope", runId: "r" });
      expect(String(r)).toMatch(/not found/);
      expect(p.invokes).toHaveLength(0);
    });
  });

  describe("fleet_dispatch with a structured spec", () => {
    let restoreSsh: (() => void) | undefined;
    beforeEach(() => { restoreSsh = fakeSsh("FLEET_CWD=ok"); });
    afterEach(() => restoreSsh?.());
    const ack = nodeReply({ ok: true, detached: true, runId: "r", pid: 4242, pidSource: "script" });
    it("renders goal + acceptance + scope into the engine prompt and sends scope and the verify gate on the wire", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => ack });
      await p.call("fleet_dispatch", {
        node: "dev2", cwd: "/w/proj", async: true,
        spec: { goal: "fix the parser", acceptance: ["tests pass"], scope: { files: ["src/**"] }, verify: { files: ["out.txt"] } },
      });
      const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
      expect(start, JSON.stringify(p.invokes.map((i) => i.params.prompt))).toBeDefined();
      expect(start!.params.realPrompt).toBe("fix the parser\n\nAcceptance criteria:\n- tests pass\n\nScope (keep your changes within these paths):\n- src/**");
      expect(start!.params.scope).toEqual({ files: ["src/**"] });
      expect(start!.params.expect).toMatchObject({ files: ["out.txt"] });
      const ledger = await loadLedger(p.rootDir);
      expect(ledger[0].spec?.scope).toEqual({ files: ["src/**"] });
    });
    it("a plain prompt is sent verbatim, with no scope or expect", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => ack });
      await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "just do it", async: true });
      const start = (await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__"))!;
      expect(start.params.realPrompt).toBe("just do it");
      expect("scope" in start.params).toBe(false);
    });
    it("refuses a malformed spec, and a call with neither prompt nor spec, before touching any node", async () => {
      p = loadPlugin(entry!, { nodes: NODES, config: CFG, invoke: () => ack });
      expect(await p.call("fleet_dispatch", { node: "dev2", cwd: "/w", spec: { goal: "g", scope: { files: ["../x"] } } })).toMatchObject({ ok: false, error: expect.stringMatching(/spec\.scope/) });
      expect(await p.call("fleet_dispatch", { node: "dev2", cwd: "/w" })).toMatchObject({ ok: false, error: expect.stringMatching(/no task given/) });
      expect(p.invokes).toHaveLength(0);
    });
  });

  describe("fleet_run_status reconciliation", () => {
    it("records the exit code and surfaces scope violations, using the node's report", async () => {
      p = loadPlugin(entry!, {
        nodes: NODES, config: CFG,
        invoke: (c) => c.params.prompt === "__RUN_STATUS__"
          ? nodeReply({ ok: true, runId: "r1", pid: 9, alive: false, state: "finished", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z", exitCode: 0, verified: true, changedFiles: ["src/a.ts", "package.json"], scopeViolations: ["package.json"] })
          : nodeReply({ ok: true, result: "done" }),
      });
      await upsertRun(p.rootDir, { runId: "r1", node: "dev2", cwd: "/w", prompt: "t", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "running", spec: { goal: "g", scope: { files: ["src/**"] } } } as never);
      const r = await p.call("fleet_run_status", { node: "dev2", runId: "r1" });
      expect(r).toMatchObject({ runId: "r1", exitCode: 0, verified: true, scopeViolations: ["package.json"], changedFiles: ["src/a.ts", "package.json"] });
      expect(r.scopeWarning).toMatch(/1 changed file/);
      const l = (await loadLedger(p.rootDir)).find((x) => x.runId === "r1")!;
      expect(l).toMatchObject({ state: "completed", exitCode: 0 });
    });
    it("reports scopeViolations: null (unknown), never an empty list, when the node did not report", async () => {
      p = loadPlugin(entry!, {
        nodes: NODES, config: CFG,
        invoke: (c) => c.params.prompt === "__RUN_STATUS__"
          ? nodeReply({ ok: true, runId: "r2", pid: 9, alive: false, state: "finished", finishedAt: "2026-01-01T00:05:00Z", exitCode: 0 })
          : nodeReply({ ok: true, result: "done" }),
      });
      await upsertRun(p.rootDir, { runId: "r2", node: "dev2", cwd: "/w", prompt: "t", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "running", spec: { goal: "g", scope: { files: ["src/**"] } } } as never);
      const r = await p.call("fleet_run_status", { node: "dev2", runId: "r2" });
      expect(r.scopeViolations).toBeNull();
    });
    it("a failed verification gate reconciles to failed-verification, not completed", async () => {
      p = loadPlugin(entry!, {
        nodes: NODES, config: CFG,
        invoke: (c) => c.params.prompt === "__RUN_STATUS__"
          ? nodeReply({ ok: true, runId: "r3", pid: 9, alive: false, state: "finished", finishedAt: "2026-01-01T00:05:00Z", exitCode: 0, verified: false, verifyDetails: { files: [{ path: "x", ok: false }] } })
          : nodeReply({ ok: true, result: "done" }),
      });
      await upsertRun(p.rootDir, { runId: "r3", node: "dev2", cwd: "/w", prompt: "t", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "running" } as never);
      const r = await p.call("fleet_run_status", { node: "dev2", runId: "r3" });
      expect(r.verified).toBe(false);
      expect(r.verifiedNote).toMatch(/VERIFICATION GATE FAILED/);
      expect((await loadLedger(p.rootDir)).find((x) => x.runId === "r3")!.state).toBe("failed-verification");
    });
  });
});
