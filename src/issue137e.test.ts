import { afterEach, describe, expect, it } from "vitest";
import { checkPiVersion, compareVersions } from "./pi-version.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

describe("#137: Pi minimum version", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.73.1", "0.73.1")).toBe(0);
    expect(compareVersions("0.9.0", "0.73.1")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.100.0", "0.73.1")).toBe(1);
  });
  it("passes at or above the minimum, refuses below, and fails closed when unreadable", () => {
    expect(checkPiVersion("pi 0.74.0\n", "0.73.1")).toEqual({ ok: true, version: "0.74.0" });
    expect(checkPiVersion("0.73.1", "0.73.1").ok).toBe(true);
    expect(checkPiVersion("pi 0.70.2", "0.73.1")).toMatchObject({ ok: false, error: expect.stringContaining("older than the required 0.73.1") });
    expect(checkPiVersion("", "0.73.1")).toMatchObject({ ok: false, error: expect.stringContaining("could not read") });
    expect(checkPiVersion("bash: pi: command not found", "0.73.1").ok).toBe(false);
    expect(checkPiVersion("0.74.0", "banana").ok).toBe(false);
  });
});

describe("#137: fleet_dispatch enforces dispatch.piMinVersion", () => {
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const setup = async (sshOut: string, min: string | undefined) => {
    restore = fakeSsh(`FLEET_CWD=ok ${sshOut}`);
    p = loadPlugin((await loadEntry())!, { nodes: NODES, config: { piDefaultModel: "m", nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(min ? { dispatch: { piMinVersion: min } } : {}) }, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
  };
  const run = (h = "pi") => p!.call("fleet_dispatch", { cwd: "/w/proj", node: "dev2", prompt: "do", harness: h }) as Promise<Record<string, any>>;
  const starts = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_START__");

  it("refuses an older Pi before launching anything", async () => {
    await setup("pi 0.70.0", "0.73.1");
    expect((await run()).dev2).toMatchObject({ ok: false, error: expect.stringContaining("older than the required 0.73.1") });
    expect(starts()).toHaveLength(0);
  });
  it("refuses when the version cannot be read", async () => {
    await setup("nothing useful", "0.73.1");
    expect((await run()).dev2).toMatchObject({ ok: false, error: expect.stringContaining("could not read") });
    expect(starts()).toHaveLength(0);
  });
  it("launches at or above the minimum; opencode runs and unconfigured gateways are untouched", async () => {
    await setup("pi 0.74.0", "0.73.1");
    await run();
    expect(starts()).toHaveLength(1);
    p!.dispose(); restore!();
    await setup("pi 0.1.0", "0.73.1");
    await run("opencode");
    expect(starts()).toHaveLength(1);
    p!.dispose(); restore!();
    await setup("pi 0.1.0", undefined);
    await run();
    expect(starts()).toHaveLength(1);
  });
});
