import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIsolationLevels, parseIsolationFacts, detectNodeCapabilities } from "./capabilities.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { loadLedger } from "./ledger.js";

/**
 * Issue #105 — capability-probe slice ONLY.
 *
 * Scope enforced by the task: report supported ISOLATION levels per node in
 * fleet_capabilities, and have fleet_dispatch REFUSE an isolation level the
 * node cannot honour BEFORE launching. No bwrap wrapping/sandbox policy here
 * (held for an owner decision); no policy change.
 *
 * Structure mirrors issue51b.test.ts (same fake-ssh testkit approach, no real
 * git, no network):
 *   1. PURE level-derivation helper (no nodes).
 *   2. Pure parse of the probe transcript.
 *   3. detectNodeCapabilities surfaces the three fields from the one probe pass.
 *   4. fleet_dispatch refuses an unsupported `isolation` (hard, no launch).
 *   5. fleet_dispatch with no `isolation` behaves exactly as before.
 */

const entry = await loadEntry();

const CAPS_FACTS = [
  "CPU=8", "MEM=31", "DISK=90", "GPU=none",
  "TOOLS=node,npm,python3", "OPENCODE=1.18.26",
  "PYVER=Python 3.12.3", "PYVENV=yes", "PYPEP668=yes", "PIPUSER=yes",
];

describe("#105: pure isolation-level derivation (deriveIsolationLevels)", () => {
  it("git present + bwrap usable => [\"clone\",\"bwrap\"]", () => {
    expect(deriveIsolationLevels(true, true)).toEqual(["clone", "bwrap"]);
  });
  it("git present + bwrap absent => [\"clone\"]", () => {
    expect(deriveIsolationLevels(true, false)).toEqual(["clone"]);
  });
  it("bwrap present but non-zero exit (unusable) => [\"clone\"]", () => {
    // "Present but broken" IS git-yes/bwrap-no for the derivation: the probe
    // maps a failing `bwrap --version` to bwrap=false, and the level list
    // must not include bwrap for it.
    expect(deriveIsolationLevels(true, false)).toEqual(["clone"]);
  });
  it("no usable git but usable bwrap => [\"bwrap\"] only", () => {
    expect(deriveIsolationLevels(false, true)).toEqual(["bwrap"]);
  });
  it("nothing usable => []", () => {
    expect(deriveIsolationLevels(false, false)).toEqual([]);
  });
});

describe("#105: probe echo parsing (parseIsolationFacts)", () => {
  it("yes on both lines => both capabilities true", () => {
    expect(parseIsolationFacts("GITCLONE=yes\nBWRAP=yes\n")).toEqual({ gitClone: true, bwrap: true });
  });
  it("no echoes => both false", () => {
    expect(parseIsolationFacts("GITCLONE=no\nBWRAP=no\n")).toEqual({ gitClone: false, bwrap: false });
  });
  it("a missing echo counts as unsupported (never assumed usable)", () => {
    expect(parseIsolationFacts("GITCLONE=yes\n")).toEqual({ gitClone: true, bwrap: false });
    expect(parseIsolationFacts("")).toEqual({ gitClone: false, bwrap: false });
  });
  it("anything but the yes sentinel is false (empty value, garbage, whitespace)", () => {
    expect(parseIsolationFacts("GITCLONE=\nBWRAP=maybe\n")).toEqual({ gitClone: false, bwrap: false });
    expect(parseIsolationFacts("  GITCLONE=yes  \n BWRAP=yes\n")).toEqual({ gitClone: true, bwrap: true });
  });
});

describe("#105: detectNodeCapabilities surfaces the isolation fields (fake ssh, one probe pass)", () => {
  it("a git+bwrap capable node reports gitClone, bwrap and both levels", async () => {
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=yes"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "iso-node", "svcuser");
      expect(caps.error).toBeUndefined();
      expect(caps.gitClone).toBe(true);
      expect(caps.bwrap).toBe(true);
      expect(caps.isolationLevels).toEqual(["clone", "bwrap"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("git present + bwrap absent => gitClone true, bwrap false, levels [\"clone\"]", async () => {
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=no"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "clone-only", "svcuser");
      expect(caps.gitClone).toBe(true);
      expect(caps.bwrap).toBe(false);
      expect(caps.isolationLevels).toEqual(["clone"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("bwrap present but unusable (non-zero exit) => BWRAP=no => levels [\"clone\"]", async () => {
    // The probe command itself encodes "usable": a failing `bwrap --version`
    // collapses to the BWRAP=no echo, so a present-but-broken binary is
    // reported exactly like an absent one — and bwrap never lands in levels.
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=no"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "broken-bwrap", "svcuser");
      expect(caps.bwrap).toBe(false);
      expect(caps.gitClone).toBe(true);
      expect(caps.isolationLevels).toEqual(["clone"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("the isolation facts ride the SAME single probe pass (no second round-trip)", async () => {
    // The full-fleet probe command is ONE `cmd` array joined into a single
    // `&&` shell chain with every fact echo; GITCLONE/BWRAP sit inline with
    // CPU/MEM/etc. The other GITCLONE/BWRAP occurrences are the standalone
    // dispatcher probe helper and its pure parse keys.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./capabilities.ts", import.meta.url), "utf8");
    expect(src).toContain('`echo "GITCLONE=$(git --version >/dev/null 2>&1 && echo yes || echo no)"`');
    expect(src).toContain('`echo "BWRAP=$(bwrap --version >/dev/null 2>&1 && echo yes || echo no)"`');
    // The single chain: between `const cmd = [` and its `].join(" && ")` sit
    // BOTH the pre-existing fact echoes AND the isolation echoes — one probe
    // command, so the isolation facts add no round-trip.
    const fullPass = src.slice(
      src.indexOf("const cmd = [") + "const cmd = [".length,
      src.indexOf('].join(" && ");'),
    );
    for (const key of ["CPU=$", "TOOLS=$", "OPENCODE=$", "PYVER=$", "GITCLONE=$", "BWRAP=$"]) {
      expect(fullPass.includes(key), key).toBe(true);
    }
  });
});

describe.skipIf(!process.env.CI)("#105 CI: the plugin entry loads, so the tool-level tests really ran", () => {
  it("entry", () => {
    expect(entry).toBeDefined();
  });
});

describe("#105: fleet_dispatch refuses an unsupported isolation level (tool level, fake ssh + fake node)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  // Fake node channel: would ack any launch — proving the gate stops the run
  // BEFORE the node is ever invoked.
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = (extra: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...extra });
  const ack = () =>
    nodeReply({ ok: true, detached: true, runId: "r", pid: 42, isolation: "clone", runCwd: "/w/.fleet-runs/r/repo", branch: "fleet/r", sourceDirty: false });
  const dispatch = (args: Record<string, unknown>) =>
    p!.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it", ...args });
  const nodeRes = (res: Record<string, unknown>): Record<string, unknown> => (res.dev2 ?? res["n-dev2"]) as Record<string, unknown>;

  beforeEach(() => { restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  it("isolation on a node that cannot honour it is REFUSED with a clear error and NOTHING is launched (ledger untouched)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "bwrap" }));
    expect(res.ok, String(res.error)).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "bwrap"/);
    // Hard refusal: no node invoke, no ledger record — not a downgrade.
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("isolation:clone on a git-less node is REFUSED the same way (the probe, not the enum, decides)", async () => {
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=no", "BWRAP=no"]);
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    expect(res.ok, String(res.error)).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "clone"/);
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("unsupported level is not silently downgraded: the error names the supported levels", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "bwrap" }));
    expect(String(res.error)).toMatch(/supported levels: clone/);
    expect(String(res.error)).toMatch(/No run was launched/);
  }, 30_000);

  it("a probe failure fails CLOSED (a node whose capabilities cannot be probed never gets the run)", async () => {
    // The cwd check succeeds but the isolation probe call fails non-zero with
    // no output (models an unreachable/partially-broken node): levels [] =>
    // refuse, never assume support.
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok"], { failOn: "GITCLONE=" });
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "clone"/);
    expect(String(res.error)).toMatch(/capability probe failed/);
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("an isolation level the node CAN honour launches exactly as before (the gate is additive)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect(start!.params.isolation).toBe("clone");
    // A detached ack result reports the run handle (ok:true is only added on
    // failure rows, so assert the handle fields, as isolation-tool.test.ts does).
    expect(res).toMatchObject({ runId: expect.anything(), detached: true, pid: 42, runCwd: "/w/.fleet-runs/r/repo" });
  }, 30_000);

  it("no isolation param => no change: today's behavior, even against a git-less node with a config default", async () => {
    // Only an EXPLICIT isolation is gated (scope: isolation absent => exactly
    // today). A config default of clone plus a git-less node still dispatches
    // — the node-side #41 machinery remains its backstop.
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=no", "BWRAP=no"]);
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ isolation: "clone" }), invoke: () => ack() });
    await dispatch({});
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect(start!.params.isolation).toBe("clone");
  }, 30_000);
});

describe("#105: fleet_capabilities surfaces the new fields per node (tool level)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  it("each node's result carries gitClone, bwrap and isolationLevels", async () => {
    if (!entry) return;
    restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes"]); // no BWRAP echo => absent
    p = loadPlugin(entry, {
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", remoteIp: "node.example", connected: true }],
    });
    const res = await p.call("fleet_capabilities", {});
    expect(res.dev2).toMatchObject({
      node: "dev2",
      gitClone: true,
      bwrap: false,
      isolationLevels: ["clone"],
    });
  }, 30_000);
});