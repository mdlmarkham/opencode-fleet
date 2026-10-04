import { afterEach, describe, expect, it } from "vitest";
import { syncGate, upsertRun, loadLedger, type LedgerEntry } from "./ledger.js";
import { loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const run = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  runId: "r1", node: "dev2", cwd: "/w/p", prompt: "x", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "completed",
  spec: { goal: "g", scope: { files: ["src/a/"] } }, verified: true, ...over,
});
const on = { blockOnScopeViolation: true };

describe("#104: scope policy in syncGate", () => {
  it("off by default: violations are advisory and never block", () => {
    expect(syncGate(run({ scopeViolations: ["x.ts"] }), {}).allow).toBe(true);
    expect(syncGate(run({ scopeViolations: ["x.ts"] }), { allowScopeViolations: false }).allow).toBe(true);
  });
  it("on: a clean scoped run passes silently, with the same shape as before", () => {
    expect(syncGate(run({ scopeViolations: [] }), on)).toEqual({ allow: true, verified: true, runId: "r1" });
  });
  it("on: violations refuse, naming the run and the files (at most five, then ellipsis)", () => {
    const g = syncGate(run({ scopeViolations: ["a", "b", "c", "d", "e", "f", "g"] }), on);
    expect(g).toMatchObject({ allow: false, runId: "r1" });
    expect(g.reason).toMatch(/7 file\(s\) outside its declared scope: a, b, c, d, e, \.\.\./);
    expect(g.reason).toContain("allowScopeViolations");
  });
  it("on: unknown is a refusal, never treated as clean (never observed vs node could not report)", () => {
    expect(syncGate(run(), on)).toMatchObject({ allow: false, reason: expect.stringContaining("never checked") });
    expect(syncGate(run({ scopeViolations: null }), on)).toMatchObject({ allow: false, reason: expect.stringContaining("could not report") });
  });
  it("on: a run with no declared scope, or no recorded run, is out of the policy's reach", () => {
    expect(syncGate(run({ spec: { goal: "g" } }), on).allow).toBe(true);
    expect(syncGate(run({ spec: undefined }), on).allow).toBe(true);
    expect(syncGate(undefined, on).allow).toBe(true);
  });
  it("the caller can override, and the override is recorded in the reason", () => {
    const g = syncGate(run({ scopeViolations: ["x.ts"] }), { ...on, allowScopeViolations: true });
    expect(g.allow).toBe(true);
    expect(g.reason).toMatch(/overridden \(allowScopeViolations\): run r1 changed 1 file/);
  });
  it("the scope override never bypasses a failed verification gate, and verification is reported first", () => {
    const failed = run({ verified: false, scopeViolations: ["x.ts"] });
    expect(syncGate(failed, { ...on, allowScopeViolations: true })).toMatchObject({ allow: false, verified: false, reason: expect.stringContaining("failed its verification gate") });
    expect(syncGate(failed, { ...on, allowScopeViolations: true, allowUnverified: true })).toMatchObject({ allow: true });
  });
  it("an unverified-but-allowed run still gets scope-checked", () => {
    expect(syncGate(run({ verified: undefined, scopeViolations: ["x.ts"] }), on).allow).toBe(false);
  });
});

const entry = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the scope-policy tool tests really ran", () => { expect(entry).toBeDefined(); });

describe.skipIf(!entry)("#104: tools", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = (sync?: Record<string, unknown>) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(sync ? { sync } : {}) });

  it("fleet_run_status persists what the node reported so fleet_sync can decide later", async () => {
    p = loadPlugin(entry!, {
      nodes: NODES, config: cfg(),
      invoke: () => nodeReply({ ok: true, state: "finished", alive: false, finishedAt: "2026-01-01T00:05:00Z", exitCode: 0, verified: true, scopeViolations: ["outside.ts"], changedFiles: ["src/a/x.ts", "outside.ts"] }),
    });
    await upsertRun(p.rootDir, run({ state: "running", verified: undefined }));
    const r = await p.call("fleet_run_status", { node: "dev2", runId: "r1", includeOutput: false }) as { scopeViolations?: string[] };
    expect(r.scopeViolations).toEqual(["outside.ts"]);
    expect((await loadLedger(p.rootDir))[0]).toMatchObject({ state: "completed", scopeViolations: ["outside.ts"] });
  });
  it("a node that cannot report is persisted as null, not as clean", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => nodeReply({ ok: true, state: "finished", alive: false, finishedAt: "2026-01-01T00:05:00Z", exitCode: 0 }) });
    await upsertRun(p.rootDir, run({ state: "running", verified: undefined }));
    await p.call("fleet_run_status", { node: "dev2", runId: "r1", includeOutput: false });
    expect((await loadLedger(p.rootDir))[0].scopeViolations).toBeNull();
  });
  it("fleet_sync refuses with the policy on, before touching the node; the override is a per-call parameter", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ blockOnScopeViolation: true }), invoke: () => nodeReply({ ok: false, error: "stop here" }) });
    await upsertRun(p.rootDir, run({ scopeViolations: ["outside.ts"] }));
    const refused = await p.call("fleet_sync", { node: "dev2", cwd: "/w/p", repo: "o/r" }) as { ok: boolean; error: string };
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("outside its declared scope") });
    expect(p.invokes).toHaveLength(0);
    const overridden = await p.call("fleet_sync", { node: "dev2", cwd: "/w/p", repo: "o/r", allowScopeViolations: true }) as { error?: string };
    expect(overridden.error ?? "").not.toContain("declared scope");
    expect(p.invokes.length).toBeGreaterThan(0);
  });
  it("with the policy off (the default) the same run is not refused for scope", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => nodeReply({ ok: false, error: "stop here" }) });
    await upsertRun(p.rootDir, run({ scopeViolations: ["outside.ts"] }));
    const r = await p.call("fleet_sync", { node: "dev2", cwd: "/w/p", repo: "o/r" }) as { error?: string };
    expect(r.error ?? "").not.toContain("declared scope");
  });
});
