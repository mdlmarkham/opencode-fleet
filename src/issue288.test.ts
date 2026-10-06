/**
 * Issue #288: a mixed fan-out must not silently drop stale or skipped nodes.
 *
 * PR #284 fixed the stale-node diagnostic but introduced two regressions:
 *   1. Mixed fan-out {stale, healthy}: `staleNodes` is collected but surfaced ONLY
 *      in the all-stale early return — in a mixed fan-out the stale node vanishes
 *      from the result entirely (pre-#284 it was at least visible in `skipped`).
 *   2. All-stale early return: a genuinely non-opencode node in the SAME fan-out
 *      is no longer reported at all — `skippedNodes` is discarded.
 *
 * Contract:
 *   1. When dispatch proceeds (>=1 dispatchable target), the result reports
 *      `staleNodes` AND the skipped nodes — no silent drop.
 *   2. Dispatch "all" over [non-opencode node + stale node] reports BOTH
 *      (`staleNodes` + `skippedNodes`) and keeps the retryable gateway-fault error.
 *   3. The all-stale early return includes `skippedNodes` alongside `staleNodes`.
 *
 * #284's accurate stale message and the fail-closed retryable error stay intact.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const entry = await loadEntry();

describe.skipIf(!entry)("#288: mixed fan-out must not silently drop stale and skipped nodes", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const CFG = { nodes: { dev2: { roles: ["worker"], ssh: false }, dev3: { roles: ["worker"], ssh: false } } };

  it("mixed dispatch {stale, healthy}: the stale node is reported AND the healthy one is dispatched", async () => {
    const restore = fakeSsh("FLEET_CWD=ok");
    try {
      p = loadPlugin(entry!, {
        nodes: [
          { nodeId: "n-dev2", displayName: "dev2", connected: false, invocableCommands: [] },
          { nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] },
        ],
        config: CFG,
        invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 4242 }),
      });
      const r = (await p.call("fleet_dispatch", { nodes: ["dev2", "dev3"], cwd: "/w/proj", prompt: "do it", async: true })) as {
        staleNodes?: string[];
        skipped?: string[];
        dev3?: { runId?: string; detached?: boolean };
      };
      // The stale node is visible again (not silently dropped).
      expect(Array.isArray(r.staleNodes)).toBe(true);
      expect(r.staleNodes).toContain("dev2");
      expect(JSON.stringify(r.staleNodes)).not.toContain("not an opencode node");
      // The healthy node was really dispatched (launch invoked, handle returned).
      expect(r.dev3).toBeDefined();
      expect(r.dev3?.detached).toBe(true);
      expect(String(r.dev3?.runId)).toMatch(/^run-/);
      const start = await p!.waitForInvoke((c) => c.params.prompt === "__RUN_START__" && c.nodeId === "n-dev3");
      expect(start).toBeDefined();
      // Nothing was dispatched to the stale node.
      expect(p!.invokes.some((c) => c.nodeId === "n-dev2")).toBe(false);
    } finally {
      restore();
    }
  });

  it(`dispatch "all" over [non-opencode node + stale node]: BOTH reported, retryable error retained`, async () => {
    p = loadPlugin(entry!, {
      nodes: [
        { nodeId: "n-dev2", displayName: "dev2", connected: false, invocableCommands: [] },
        { nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["system.run"] },
      ],
      config: CFG,
      invoke: () => nodeReply({}),
    });
    const r = (await p.call("fleet_dispatch", { nodes: "all", cwd: "/w/proj", prompt: "do it" })) as {
      ok?: boolean;
      retryable?: boolean;
      reason?: string;
      error?: string;
      staleNodes?: string[];
      skippedNodes?: string[];
    };
    // #284's fail-closed retryable gateway fault is intact.
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.reason).toBe("gateway-not-connected");
    expect(String(r.error)).toMatch(/gateway/i);
    expect(String(r.error)).toMatch(/not connected/i);
    // Both the stale node AND the genuinely non-opencode node are reported.
    expect(r.staleNodes).toContain("dev2");
    expect(Array.isArray(r.skippedNodes)).toBe(true);
    expect(r.skippedNodes!.some((s) => s.includes("dev3") && s.includes("not an opencode node"))).toBe(true);
    // Nothing was dispatched (fail-closed).
    expect(p.invokes).toHaveLength(0);
  });

  it("all-stale path: skippedNodes is present alongside staleNodes", async () => {
    p = loadPlugin(entry!, {
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: false, invocableCommands: [] }],
      config: CFG,
      invoke: () => nodeReply({}),
    });
    const r = (await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it" })) as {
      ok?: boolean;
      retryable?: boolean;
      reason?: string;
      staleNodes?: string[];
      skippedNodes?: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.reason).toBe("gateway-not-connected");
    expect(r.staleNodes).toEqual(["dev2"]);
    // Present (possibly empty) — the discarded-by-#284 field is surfaced again.
    expect(Array.isArray(r.skippedNodes)).toBe(true);
  });
});