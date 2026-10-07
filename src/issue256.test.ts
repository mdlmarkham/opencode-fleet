import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { isWorkerPublicationTransient } from "./tools/dispatch.js";

/**
 * Issue #256 regression guards.
 *
 * Right after a node service restart, the FIRST detached launch can be
 * refused with "Device pairing authority requires a current worker
 * publication" — a transient (the worker publication is not ready yet); a
 * retry ~1 min later succeeds. The manager now retries that SPECIFIC launch
 * ONCE after a short bounded wait. Nothing else is ever retried:
 *
 *   (a) the transient triggers exactly one retry, and a successful retry
 *       records the run;
 *   (b) an unrelated launch error is NOT retried;
 *   (c) a second transient failure records the original failure.
 */

const TRANSIENT = "Device pairing authority requires a current worker publication";
const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false } } };

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the dispatch tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#256: one bounded retry of the post-restart publication transient", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  it("(a) the transient triggers exactly one retry and a successful retry records the run", async () => {
    let first = true;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c) =>
        c.params.prompt === "__RUN_STATUS__" ? nodeReply({ ok: false, status: "never-started" }) :
        first
          ? (first = false, nodeReply({ ok: false, error: TRANSIENT }))
          : nodeReply({ ok: true, detached: true, runId: "r", pid: 4321 }),
    });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    const launches = p.invokes.filter((c) => c.params.prompt === "__RUN_START__");
    expect(launches).toHaveLength(2);
    // The SAME launch is retried, not a different task.
    expect(launches[1].params.realPrompt).toBe("x");
    expect(launches[1].params.runId).toBe(launches[0].params.runId);
    expect(r.dev2).toMatchObject({ detached: true, pid: 4321 });
    const ledger = await import("./ledger.js").then((m) => m.loadLedger(p!.rootDir));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ state: "running", node: "dev2", pid: 4321 });
  });

  it("(b) an unrelated launch error is NOT retried", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: () => nodeReply({ ok: false, error: "no such cwd" }),
    });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(1);
    expect(r.dev2).toMatchObject({ ok: false, error: expect.stringContaining("launch failed: no such cwd") });
    const ledger = await import("./ledger.js").then((m) => m.loadLedger(p!.rootDir));
    expect(ledger[0]).toMatchObject({ state: "failed", summary: "launch failed: no such cwd" });
  });

  it("(c) a second transient failure records the original failure", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c) => c.params.prompt === "__RUN_STATUS__" ? nodeReply({ ok: false, status: "never-started" }) : nodeReply({ ok: false, error: TRANSIENT }),
    });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(2);
    expect(r.dev2).toMatchObject({ ok: false, error: `launch failed: ${TRANSIENT}` });
    const ledger = await import("./ledger.js").then((m) => m.loadLedger(p!.rootDir));
    expect(ledger[0]).toMatchObject({ state: "failed", summary: `launch failed: ${TRANSIENT}` });
  });

  it("(d) the match is narrow: an error merely mentioning publication machinery is not retried", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: () => nodeReply({ ok: false, error: "worker publication subsystem missing" }),
    });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" });
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(1);
  });

  it("(e) the exact phrase matches case-insensitively", async () => {
    let first = true;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c) =>
        c.params.prompt === "__RUN_STATUS__" ? nodeReply({ ok: false, status: "never-started" }) :
        first
          ? (first = false, nodeReply({ ok: false, error: "device pairing authority requires a CURRENT Worker Publication" }))
          : nodeReply({ ok: true, detached: true, runId: "r", pid: 7 }),
    });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(p.invokes.filter((c) => c.params.prompt === "__RUN_START__")).toHaveLength(2);
    expect(r.dev2).toMatchObject({ detached: true, pid: 7 });
  });
});

describe.skipIf(!loaded)("#312: both error channels, and no blind resend", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const starts = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_START__");
  const probes = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_STATUS__");
  const absent = () => nodeReply({ ok: false, status: "never-started" });

  it("a REJECTED invoke carrying the phrase (the relay channel) is recognised, probed, and retried once", async () => {
    let first = true;
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: (c) => {
      if (c.params.prompt === "__RUN_STATUS__") return absent();
      if (first) { first = false; throw new Error(TRANSIENT); }
      return nodeReply({ ok: true, detached: true, runId: "r", pid: 11 });
    } });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(starts()).toHaveLength(2);
    expect(probes()).toHaveLength(1);
    expect(r.dev2).toMatchObject({ detached: true, pid: 11 });
  });

  it("the run already exists (the error was spurious): it is ADOPTED, with no second launch", async () => {
    let first = true;
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: (c) => {
      if (c.params.prompt === "__RUN_STATUS__") return nodeReply({ ok: true, state: "running", pid: 4242, alive: true });
      if (first) { first = false; return nodeReply({ ok: false, error: TRANSIENT }); }
      throw new Error("a second __RUN_START__ must never be sent");
    } });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(starts()).toHaveLength(1);
    expect(r.dev2).toMatchObject({ detached: true, pid: 4242, ackPending: false, recoveredFromPublicationTransient: true });
    const ledger = await import("./ledger.js").then((m) => m.loadLedger(p!.rootDir));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ state: "running", pid: 4242 });
  });

  it("an inconclusive probe never resends: the launch is reported as unconfirmed, not failed and not duplicated", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: (c) => {
      if (c.params.prompt === "__RUN_STATUS__") throw new Error("relay down");
      return nodeReply({ ok: false, error: TRANSIENT });
    } });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(starts()).toHaveLength(1);
    expect(JSON.stringify(r.dev2)).toMatch(/not (acknowledged|confirmed)|ackPending|inconclusive|unconfirmed/i);
    expect(r.dev2.ok === true && r.dev2.runId === undefined).toBe(false);
  });

  it("probe absent, then a second transient: one resend, fails with the transient; no third launch", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: (c) => c.params.prompt === "__RUN_STATUS__" ? absent() : nodeReply({ ok: false, error: TRANSIENT }) });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" }) as Record<string, any>;
    expect(starts()).toHaveLength(2);
    expect(probes()).toHaveLength(1);
    expect(r.dev2).toMatchObject({ ok: false, error: `launch failed: ${TRANSIENT}` });
  });

  it("an unrelated rejection is neither probed nor retried", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: () => { throw new Error("relay exploded"); } });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" });
    expect(starts()).toHaveLength(1);
    expect(probes().length).toBeLessThanOrEqual(1); // only the existing ack-timeout probe, never the transient path
  });
});

describe("#256: narrow matcher", () => {
  it("matches only the exact transient phrase, case-insensitively", () => {
    expect(isWorkerPublicationTransient(TRANSIENT)).toBe(true);
    expect(isWorkerPublicationTransient(`boom: ${TRANSIENT.toUpperCase()}`)).toBe(true);
    expect(isWorkerPublicationTransient(undefined)).toBe(false);
    expect(isWorkerPublicationTransient("")).toBe(false);
    expect(isWorkerPublicationTransient("current worker publication".slice(0, 11))).toBe(false);
    expect(isWorkerPublicationTransient("worker publication stale")).toBe(false);
    expect(isWorkerPublicationTransient("noSuchError")).toBe(false);
  });
});