import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { latestRunFor, recipeSuccess, syncGate, type LedgerEntry } from "./ledger.js";

const run = (runId: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  runId, node: "dev2", cwd: "/w/p", prompt: "x", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "completed", ...over,
} as LedgerEntry);

describe("#65: latestRunFor", () => {
  it("picks the newest run for the node and checkout, ignoring stored order, other nodes/dirs and discarded runs", () => {
    const a = run("a", { startedAt: "2026-01-01T00:00:00Z" });
    const b = run("b", { startedAt: "2026-01-03T00:00:00Z" });
    const c = run("c", { startedAt: "2026-01-09T00:00:00Z", node: "dev3" });
    const d = run("d", { startedAt: "2026-01-09T00:00:00Z", cwd: "/w/other" });
    const e = run("e", { startedAt: "2026-01-09T00:00:00Z", state: "discarded" });
    expect(latestRunFor([a, b, c, d, e], ["dev2"], "/w/p")?.runId).toBe("b");
    expect(latestRunFor([b, a], ["dev2"], "/w/p")?.runId).toBe("b");
    expect(latestRunFor([c], ["dev2"], "/w/p")).toBeUndefined();
  });
});

describe("#65: syncGate", () => {
  it("refuses a failed gate unless overridden, and says which run", () => {
    for (const e of [run("r1", { verified: false }), run("r2", { state: "failed-verification" })]) {
      const g = syncGate(e, {});
      expect(g.allow).toBe(false);
      expect(g.verified).toBe(false);
      expect(g.runId).toBe(e.runId);
      expect(g.reason).toMatch(/failed its verification gate/);
      const o = syncGate(e, { allowUnverified: true });
      expect(o.allow).toBe(true);
      expect(o.reason).toMatch(/overridden/);
    }
  });
  it("allows a verified run silently", () => {
    expect(syncGate(run("ok", { verified: true }), { requireVerified: true })).toEqual({ allow: true, verified: true, runId: "ok" });
  });
  it("treats unknown as unknown: allowed with a caution by default, refused under requireVerified, overridable", () => {
    const none = run("n");
    const d = syncGate(none, {});
    expect(d).toMatchObject({ allow: true, verified: null });
    expect(d.reason).toMatch(/unverified/);
    expect(syncGate(none, { requireVerified: true }).allow).toBe(false);
    expect(syncGate(none, { requireVerified: true, allowUnverified: true }).allow).toBe(true);
    expect(syncGate(undefined, {})).toMatchObject({ allow: true, verified: null });
    expect(syncGate(undefined, { requireVerified: true }).allow).toBe(false);
  });
});

describe("#65: recipe success derives from the run", () => {
  it("self-reported success is overridden for a failed gate or failed process", () => {
    expect(recipeSuccess(true, run("a", { verified: false }))).toEqual({ success: false, overridden: true });
    expect(recipeSuccess(true, run("b", { state: "failed-verification" }))).toEqual({ success: false, overridden: true });
    expect(recipeSuccess(true, run("c", { state: "failed" }))).toEqual({ success: false, overridden: true });
  });
  it("is unchanged otherwise: a verified or unknown run keeps its report, and a reported failure stays a failure", () => {
    expect(recipeSuccess(true, run("a", { verified: true }))).toEqual({ success: true, overridden: false });
    expect(recipeSuccess(true, run("b"))).toEqual({ success: true, overridden: false });
    expect(recipeSuccess(true, undefined)).toEqual({ success: true, overridden: false });
    expect(recipeSuccess(false, run("c", { verified: false }))).toEqual({ success: false, overridden: false });
  });
});

describe("#65: wiring", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  it("fleet_sync consults the gate before any publish path, and recipe_record uses runId", () => {
    const sync = src.slice(src.indexOf('name: "fleet_sync"'), src.indexOf('name: "fleet_cleanup"'));
    expect(sync.indexOf("syncGate(")).toBeGreaterThan(-1);
    expect(sync.indexOf("syncGate(")).toBeLessThan(sync.indexOf("syncFromNode("));
    expect(sync).toContain("allowUnverified");
    const rec = src.slice(src.indexOf('name: "fleet_recipe_record"'), src.indexOf('name: "fleet_recipe_list"'));
    expect(rec).toContain("recipeSuccess(");
  });
  it("requireVerified is declared in the manifest config", () => {
    const sync = manifest.configSchema?.properties?.sync?.properties ?? manifest.configSchema?.sync?.properties;
    expect(JSON.stringify(manifest)).toContain("requireVerified");
    expect(sync === undefined || sync.requireVerified?.type === "boolean").toBe(true);
  });
});
