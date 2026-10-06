import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkToolAllow, renderAllowReport } from "./tool-allow.js";

const REG = ["fleet_dispatch", "fleet_status", "fleet_mission_run"];
const cfg = (allow: unknown, extra: Record<string, unknown> = {}) => ({ agents: { entries: { main: { tools: { allow } }, ...extra } } });

describe("#261: tool allow arrays vs registered tools", () => {
  it("passes when an agent allows every registered tool", () => {
    expect(checkToolAllow(cfg([...REG, "read"]), REG).ok).toBe(true);
  });
  it("reports a registered tool the allow array predates (the invisible-tool incident)", () => {
    const r = checkToolAllow(cfg(["fleet_dispatch", "fleet_status"]), REG);
    expect(r.ok).toBe(false);
    expect(r.agents[0]).toMatchObject({ agent: "main", missing: ["fleet_mission_run"], unknown: [] });
    expect(renderAllowReport(r)).toContain("fleet_mission_run");
  });
  it("reports an entry naming a removed tool (the other direction)", () => {
    const r = checkToolAllow(cfg([...REG, "fleet_gone"]), REG);
    expect(r.agents[0]!.unknown).toEqual(["fleet_gone"]);
    expect(r.ok).toBe(false);
  });
  it("leaves non-fleet agents alone and honours wildcards", () => {
    const r = checkToolAllow(cfg(["fleet_*"], { other: { tools: { allow: ["read", "write"] } }, bare: {} }), REG);
    expect(r.ok).toBe(true);
    expect(r.skipped.sort()).toEqual(["bare", "other"]);
  });
  it("tolerates a config with no agents section", () => {
    expect(checkToolAllow({}, REG)).toEqual({ ok: true, agents: [], skipped: [] });
  });
  it("holds against the real manifest: the shipped tool list is non-empty and fleet_-prefixed", () => {
    const m = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { contracts: { tools: string[] } };
    expect(m.contracts.tools.length).toBeGreaterThan(20);
    expect(m.contracts.tools.every((t) => t.startsWith("fleet_"))).toBe(true);
    expect(checkToolAllow(cfg(m.contracts.tools), m.contracts.tools).ok).toBe(true);
    expect(checkToolAllow(cfg(m.contracts.tools.slice(1)), m.contracts.tools).ok).toBe(false);
  });
});
