/**
 * Issue #282: dispatch/activity must not blame the NODE when the real fault is
 * the GATEWAY.
 *
 * Observed live 2026-10-06: with the gateway's websocket admission closed
 * (`HTTP 503`), `fleet_dispatch` reported `dev2 (not an opencode node)` and
 * `fleet_activity` reported `not an opencode node (no opencode.run command)`,
 * while the node's own log showed it advertising `opencode.run` and failing to
 * RE-REGISTER. The manager was serving a stale capability snapshot; the error
 * named the node for a gateway fault.
 *
 * Contract:
 *   1. A node that is `connected: false` and lacks `opencode.run` in its cached
 *      command list is reported as STALE (a gateway admission fault), never
 *      "not an opencode node".
 *   2. A node that IS connected and genuinely lacks the command still reports
 *      "not an opencode node" (the accurate message is kept).
 *   3. A dispatch with no dispatchable target but stale nodes returns a
 *      retryable `gateway-not-connected` result naming them, not a silent skip.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const entry = await loadEntry();

describe.skipIf(!entry)("#282: a stale snapshot is not a node fault", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false }, dev3: { roles: ["worker"], ssh: false } } };

  it("fleet_activity: a disconnected node with no cached command is STALE, not 'not an opencode node'", async () => {
    p = loadPlugin(entry!, {
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: false, invocableCommands: [] }],
      config: CFG,
      invoke: () => nodeReply({}),
    });
    const r = (await p.call("fleet_activity", {})) as Record<string, { skipped?: string; stale?: boolean; reason?: string }>;
    expect(r.dev2.stale).toBe(true);
    expect(r.dev2.reason).toBe("gateway-not-connected");
    expect(String(r.dev2.skipped)).not.toContain("not an opencode node");
    expect(String(r.dev2.skipped)).toMatch(/STALE|gateway/i);
  });

  it("fleet_activity: a CONNECTED node genuinely lacking the command still reports 'not an opencode node'", async () => {
    p = loadPlugin(entry!, {
      nodes: [{ nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["system.run"] }],
      config: CFG,
      invoke: () => nodeReply({}),
    });
    const r = (await p.call("fleet_activity", { nodes: ["dev3"] })) as Record<string, { skipped?: string; stale?: boolean }>;
    expect(r.dev3.skipped).toContain("not an opencode node");
    expect(r.dev3.stale).toBeUndefined();
  });

  it("fleet_dispatch: no dispatchable target + a stale node yields a retryable gateway fault, not a silent skip", async () => {
    p = loadPlugin(entry!, {
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: false, invocableCommands: [] }],
      config: CFG,
      invoke: () => nodeReply({}),
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w", prompt: "do it" })) as { ok?: boolean; retryable?: boolean; reason?: string; error?: string };
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.reason).toBe("gateway-not-connected");
    expect(String(r.error)).toMatch(/gateway/i);
    expect(String(r.error)).toMatch(/not connected/i);
  });
});
