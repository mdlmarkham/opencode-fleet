import { afterEach, describe, expect, it } from "vitest";
import { upsertRun } from "./ledger.js";
import { loadEntry, loadPlugin, nodeReply, type InvokeCall, type Loaded } from "./testkit/plugin.js";

// Issue #191: a `plugins reload` of the active plugin never settled. These pin what THIS repo can
// guarantee about quiescence, so a future change cannot quietly make the hang more likely: the gateway
// side registers nothing long-lived, and its long blocking calls end when the host aborts them.

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the quiescence tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#191: the plugin leaves nothing running at load", () => {
  it("registers only tools and a node invoke policy (no services, widgets, gateway methods, CLI), and holds no new handle", () => {
    const touched = new Set<string>();
    const target: Record<string, unknown> = {
      pluginConfig: {},
      rootDir: "/tmp/fleet-191",
      registerTool: () => undefined,
      registerNodeInvokePolicy: () => undefined,
      runtime: { nodes: { list: async () => ({ nodes: [] }), invoke: async () => ({}) } },
    };
    const api = new Proxy(target, { get: (t, k: string) => { touched.add(k); return k in t ? t[k] : () => undefined; } });
    const before = process.getActiveResourcesInfo().filter((r) => r !== "CloseReq").length;
    loaded!.register(api);
    const after = process.getActiveResourcesInfo().filter((r) => r !== "CloseReq").length;
    const registrars = [...touched].filter((k) => /^(register|on|add|subscribe|set)[A-Z]/.test(k)).sort();
    // If this list grows, think about drain: a long-lived registration is what could hold a reload open (#191).
    expect(registrars).toEqual(["registerNodeInvokePolicy", "registerTool"]);
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe.skipIf(!loaded)("#191: long blocking calls end when the host aborts them", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = { nodes: { dev2: { roles: ["worker"], ssh: false } } };
  const run = (tool: string, params: Record<string, unknown>, ctl: AbortController) =>
    p!.tools.get(tool)!.execute("t", params, ctl.signal).then((r) => (r as { details?: unknown }).details ?? r) as Promise<Record<string, any>>;

  it("fleet_await returns promptly on abort instead of waiting out its timeout", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: () => nodeReply({ ok: true, alive: true, state: "running", startedAt: "s" }) });
    await upsertRun(p.rootDir, { runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "running" });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const t0 = Date.now();
    const r = await run("fleet_await", { runIds: ["r1"], timeoutMs: 600_000, pollMs: 60_000 }, ctl);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: true, allTerminal: false, aborted: true });
  });

  it("fleet_watch returns promptly when its node call is aborted, saying the relay ended it", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: cfg,
      invoke: (c: InvokeCall) =>
        c.params.prompt === "__ACTIVITY__"
          ? nodeReply({ activity: [] })
          : new Promise((_, reject) => { (c as unknown as { signal?: AbortSignal }).signal?.addEventListener("abort", () => reject(new Error("aborted by host"))); }),
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const t0 = Date.now();
    const r = await run("fleet_watch", { node: "dev2", cwd: "/w", prompt: "do it", timeoutMs: 600_000, pollMs: 60_000 }, ctl);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: false, endedBy: "watch-relay", mayStillBeRunning: true });
  });
});
