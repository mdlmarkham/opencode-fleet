import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WATCH_TIMEOUT_MS } from "./opencode.js";
import { loadEntry, loadPlugin, nodeReply, type InvokeCall, type Loaded } from "./testkit/plugin.js";

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the fleet_watch tests really ran", () => { expect(loaded).toBeDefined(); });

describe("#190: the watch default", () => {
  it("is 10 minutes, not the old 5", () => { expect(DEFAULT_WATCH_TIMEOUT_MS).toBe(600_000); });
});

describe.skipIf(!loaded)("#190: fleet_watch names the limit that ended the run", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = { nodes: { dev2: { roles: ["worker"], ssh: false } } };
  const isRun = (c: InvokeCall) => c.params.prompt !== "__ACTIVITY__";
  const watch = (args: Record<string, unknown> = {}) => p!.call("fleet_watch", { node: "dev2", cwd: "/w", prompt: "do it", ...args }) as Promise<Record<string, any>>;

  it("sends the 10-minute default to the node, and an explicit timeoutMs wins", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: (c) => nodeReply(isRun(c) ? { ok: true, summary: "done" } : { activity: [] }) });
    await watch({ pollMs: 60_000 });
    expect(p.invokes.find(isRun)!.params.timeoutMs).toBe(600_000);
    await watch({ timeoutMs: 45_000, pollMs: 60_000 });
    expect(p.invokes.filter(isRun)[1]!.params.timeoutMs).toBe(45_000);
  });

  it("a wall-clock kill reports endedBy, says it was fleet_watch's own timeoutMs (and whether it was the default), and points at the fix", async () => {
    const killed = { ok: false, summary: "", error: "opencode run timed out at the wall-clock limit (exit 124)", endedBy: "wall-clock" };
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: (c) => nodeReply(isRun(c) ? killed : { activity: [] }) });
    const dflt = await watch({ pollMs: 60_000 });
    expect(dflt).toMatchObject({ ok: false, endedBy: "wall-clock", timeoutMs: 600_000 });
    expect(dflt.error).toContain("fleet_watch's own timeoutMs: 600s, the default");
    expect(dflt.hint).toContain("fleet_await");
    const explicit = await watch({ timeoutMs: 90_000, pollMs: 60_000 });
    expect(explicit.error).toContain("timeoutMs: 90s");
    expect(explicit.error).not.toContain("the default");
  });

  it("an idle-watchdog kill reports its own endedBy and is not blamed on the watch timeout", async () => {
    const stuck = { ok: false, summary: "", error: "opencode run killed by watchdog: [stuck: no output for 120s]", endedBy: "idle-watchdog" };
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: (c) => nodeReply(isRun(c) ? stuck : { activity: [] }) });
    const r = await watch({ pollMs: 60_000 });
    expect(r).toMatchObject({ ok: false, endedBy: "idle-watchdog" });
    expect(r.error).not.toContain("fleet_watch's own timeoutMs");
    expect(r.timeoutMs).toBeUndefined();
  });

  it("a relay failure before the node reports is endedBy watch-relay, may still be running, and does not throw", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: (c) => { if (isRun(c)) throw new Error("node channel closed"); return nodeReply({ activity: [] }); } });
    const r = await watch({ pollMs: 60_000 });
    expect(r).toMatchObject({ ok: false, endedBy: "watch-relay", mayStillBeRunning: true });
    expect(r.error).toContain("node channel closed");
  });

  it("a successful watch adds none of the new fields", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg, invoke: (c) => nodeReply(isRun(c) ? { ok: true, summary: "done" } : { activity: [] }) });
    const r = await watch({ pollMs: 60_000 });
    expect(r).toMatchObject({ done: true, ok: true });
    expect(r.endedBy).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });
});
