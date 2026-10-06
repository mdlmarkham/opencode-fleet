import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskFreeCommand, diskHeadroom, parseFreeKb } from "./capacity.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

describe("#105: disk headroom", () => {
  it("parses the probe and never reads a missing number as plenty", () => {
    expect(parseFreeKb("FREE_KB=2097152\n")).toBe(2097152);
    expect(parseFreeKb("")).toBeNull();
    expect(parseFreeKb("FREE_KB=\n")).toBeNull();
    expect(diskFreeCommand("'/w/p'")).toContain("df -Pk -- '/w/p'");
  });
  it("passes above the floor, refuses below it, fails closed when unmeasured, and is a no-op without a floor", () => {
    expect(diskHeadroom("n", 10 * 1024 * 1024, 5)).toEqual({ ok: true });
    expect(diskHeadroom("n", 2 * 1024 * 1024, 5)).toMatchObject({ ok: false, retryable: true, reason: "no-disk", freeGb: 2, floorGb: 5, error: expect.stringContaining("2 GB free") });
    expect(diskHeadroom("n", null, 5)).toMatchObject({ ok: false, reason: "no-disk", freeGb: null, error: expect.stringContaining("could not measure") });
    expect(diskHeadroom("n", null, 0)).toEqual({ ok: true });
    expect(diskHeadroom("n", 0, 0)).toEqual({ ok: true });
  });
});

describe("#105: fleet_dispatch honours capacity.minFreeDiskGb for isolated runs", () => {
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const setup = async (freeLine: string, capacity: Record<string, unknown> | undefined) => {
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no", ...(freeLine ? [freeLine] : [])]);
    p = loadPlugin((await loadEntry())!, { nodes: NODES, config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(capacity ? { capacity } : {}) }, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    return p;
  };
  const dispatch = (args: Record<string, unknown> = {}) => p!.call("fleet_dispatch", { cwd: "/w/proj", node: "dev2", prompt: "do it", isolation: "clone", ...args }) as Promise<Record<string, any>>;
  const starts = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_START__");

  it("refuses an isolated run on a node below the floor, retryably, and starts nothing", async () => {
    await setup("FREE_KB=1048576", { minFreeDiskGb: 5 });
    const r = await dispatch();
    expect(r.dev2).toMatchObject({ ok: false, retryable: true, reason: "no-disk", freeGb: 1 });
    expect(starts()).toHaveLength(0);
  });
  it("fails closed when free space cannot be measured", async () => {
    await setup("", { minFreeDiskGb: 5 });
    expect((await dispatch()).dev2).toMatchObject({ ok: false, reason: "no-disk", freeGb: null });
    expect(starts()).toHaveLength(0);
  });
  it("launches above the floor; and without the config, or without isolation, nothing is checked", async () => {
    await setup("FREE_KB=20971520", { minFreeDiskGb: 5 });
    await dispatch();
    expect(starts()).toHaveLength(1);
    p!.dispose(); restore!();
    await setup("FREE_KB=1048576", undefined);
    await dispatch();
    expect(starts()).toHaveLength(1);
    p!.dispose(); restore!();
    await setup("FREE_KB=1048576", { minFreeDiskGb: 5 });
    const r = await dispatch({ isolation: "none" });
    expect(r.dev2?.reason).toBeUndefined();
    expect(starts()).toHaveLength(1);
  });
});
