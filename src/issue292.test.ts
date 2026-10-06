/**
 * Issue #292: fleet_capacity used to report `limit: null` and `free: null` for a node with no
 * concurrency limit configured, which reads as "unknown" rather than "unlimited". Now it reports
 * the clear string "unlimited" for both. A CONFIGURED limit (node `maxConcurrent` or
 * `capacity.maxConcurrentPerNode`) keeps the exact numeric `limit` and `free` it always had.
 * This is display-only: capacity enforcement (reserveRun, liveRuns, staleAfter) is untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertRun, type LedgerEntry } from "./ledger.js";
import { fakeSsh, loadEntry, loadPlugin, type Loaded } from "./testkit/plugin.js";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({ runId: "r1", node: "dev2", cwd: "/w", prompt: "p", startedAt: "2026-10-04T11:59:00Z", updatedAt: "2026-10-04T11:59:00Z", state: "running", ...over });

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the capacity tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#292: fleet_capacity slot reporting", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [
    { nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] },
    { nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] },
  ];
  const cfg = (extra: Record<string, unknown> = {}, node2: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false, ...node2 }, dev3: { roles: ["worker"], ssh: false } }, ...extra });
  const capacity = () => p!.call("fleet_capacity", {}) as Promise<{ nodes: Array<{ node: string; limit?: number | string; free?: number | string; configError?: string }> }>;

  it("a configured limit keeps the exact numeric limit and free it always had", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 3 } }, { maxConcurrent: 2 }), invoke: () => undefined });
    await upsertRun(p.rootDir, entry({ runId: "live", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
    const r = await capacity();
    const dev2 = r.nodes.find((n) => n.node === "dev2")!;
    expect(dev2).toMatchObject({ limit: 2, free: 1 });
    expect(r.nodes.find((n) => n.node === "dev3")).toMatchObject({ limit: 3, free: 3 });
    expect(typeof dev2.limit).toBe("number");
    expect(typeof dev2.free).toBe("number");
  });

  it("no limit configured: the clear string 'unlimited', not null", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg(), invoke: () => undefined });
    await upsertRun(p.rootDir, entry({ runId: "live", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
    const r = await capacity();
    for (const n of r.nodes) {
      expect(n.limit).toBe("unlimited");
      expect(n.free).toBe("unlimited");
      expect(n.limit).not.toBeNull();
      expect(n.free).not.toBeNull();
    }
  });

  it("a run holding a slot is still reported alongside 'unlimited', and a config error still surfaces", async () => {
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ capacity: { maxConcurrentPerNode: 0 } }), invoke: () => undefined });
    await upsertRun(p.rootDir, entry({ runId: "live", updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
    const r = await capacity();
    expect(r.nodes.find((n) => n.node === "dev2")).toMatchObject({ configError: expect.stringContaining("maxConcurrentPerNode") });
  });
});