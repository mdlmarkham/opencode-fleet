/**
 * Issue #256 regression guards.
 *
 * Right after a node service restart, the FIRST detached launch can be refused
 * with "Device pairing authority requires a current worker publication" — a
 * transient; a retry seconds later succeeds. The manager retries that SPECIFIC
 * launch ONCE after a bounded wait, but ONLY after probing (the transient does
 * not prove nothing launched). Nothing else is ever retried.
 *
 * Review-fixed (independent review):
 *   (1) the phrase can arrive on EITHER channel — a node-returned {ok:false,error}
 *       OR a relay THROW turned into {invokeTimedOut,message}; both must match.
 *   (2) before a second __RUN_START__, PROBE the runId: `confirmed` adopts the
 *       live run (no second launch); only `absent` retries; `inconclusive` never.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { isWorkerPublicationTransient } from "./recovery.js";

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

  const starts = () => p!.invokes.filter((c) => c.params.prompt === "__RUN_START__");

  it("(a) the payload-shaped transient (probe absent) retries once and records the run", async () => {
    let launches = 0;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c: { params: { prompt?: string } }) => {
        if (c.params.prompt === "__RUN_STATUS__") return nodeReply({ ok: false, status: "never-started" });
        launches += 1;
        return launches === 1 ? nodeReply({ ok: false, error: TRANSIENT }) : nodeReply({ ok: true, detached: true, runId: "r", pid: 4321 });
      },
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(2);
    expect(starts()[1].params.realPrompt).toBe("x");
    expect(starts()[1].params.runId).toBe(starts()[0].params.runId);
    expect(r.dev2).toMatchObject({ detached: true, pid: 4321 });
  });

  it("(b) the RELAY-channel transient (a throw, payload {}) also retries — review finding 1", async () => {
    let launches = 0;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c: { params: { prompt?: string } }) => {
        if (c.params.prompt === "__RUN_STATUS__") return nodeReply({ ok: false, status: "never-started" });
        launches += 1;
        if (launches === 1) throw new Error(`relay: ${TRANSIENT}`);
        return nodeReply({ ok: true, detached: true, runId: "r", pid: 9 });
      },
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(2);
    expect(r.dev2).toMatchObject({ detached: true, pid: 9 });
  });

  it("(c) the transient with a LIVE run adopts it and does NOT relaunch — review finding 2", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c: { params: { prompt?: string } }) => {
        if (c.params.prompt === "__RUN_STATUS__") return nodeReply({ ok: true, pid: 55, state: "running" });
        return nodeReply({ ok: false, error: TRANSIENT });
      },
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(1); // adopted, never relaunched
    expect(r.dev2).toMatchObject({ ok: true, recoveredFromTransient: true, pid: 55 });
  });

  it("(d) the transient with an INCONCLUSIVE probe never relaunches", async () => {
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c: { params: { prompt?: string } }) => {
        // probe throws => inconclusive
        if (c.params.prompt === "__RUN_STATUS__") throw new Error("probe relay error");
        return nodeReply({ ok: false, error: TRANSIENT });
      },
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(1); // no relaunch when a run may be live
    expect(r.dev2).toMatchObject({ ok: false });
  });

  it("(e) an unrelated launch error is NOT retried", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: () => nodeReply({ ok: false, error: "no such cwd" }) });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(1);
    expect(r.dev2).toMatchObject({ ok: false, error: expect.stringContaining("launch failed: no such cwd") });
  });

  it("(f) the match is narrow: other publication wording is not retried", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: CFG, invoke: () => nodeReply({ ok: false, error: "worker publication subsystem missing" }) });
    await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" });
    expect(starts()).toHaveLength(1);
  });

  it("(g) the exact phrase matches case-insensitively", async () => {
    let launches = 0;
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: CFG,
      invoke: (c: { params: { prompt?: string } }) => {
        if (c.params.prompt === "__RUN_STATUS__") return nodeReply({ ok: false, status: "never-started" });
        launches += 1;
        return launches === 1
          ? nodeReply({ ok: false, error: "device pairing authority requires a CURRENT Worker Publication" })
          : nodeReply({ ok: true, detached: true, runId: "r", pid: 7 });
      },
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "x" })) as Record<string, any>;
    expect(starts()).toHaveLength(2);
    expect(r.dev2).toMatchObject({ detached: true, pid: 7 });
  });
});

describe("#256: narrow matcher", () => {
  it("matches only the exact transient phrase, case-insensitively", () => {
    expect(isWorkerPublicationTransient(TRANSIENT)).toBe(true);
    expect(isWorkerPublicationTransient(`boom: ${TRANSIENT.toUpperCase()}`)).toBe(true);
    expect(isWorkerPublicationTransient(undefined)).toBe(false);
    expect(isWorkerPublicationTransient("")).toBe(false);
    expect(isWorkerPublicationTransient("worker publication stale")).toBe(false);
    expect(isWorkerPublicationTransient("noSuchError")).toBe(false);
  });
});
