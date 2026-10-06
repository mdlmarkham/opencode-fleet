import { describe, expect, it } from "vitest";
import { toolAllowForDeploy } from "./tool-allow.js";
import { gatewaySrc } from "./testkit/src.js";

const manifest = JSON.stringify({ contracts: { tools: ["fleet_dispatch", "fleet_status"] } });
const files = (cfg: unknown, m: string = manifest): ((p: string) => Promise<string>) => async (p) => {
  if (p.endsWith("openclaw.json")) { if (cfg === undefined) throw new Error("ENOENT"); return JSON.stringify(cfg); }
  return m;
};
const cfg = (allow: string[]) => ({ agents: { entries: { main: { tools: { allow } } } } });

describe("#289: the deploy report carries the tool-allow parity", () => {
  it("surfaces drift: a registered tool missing from an allow array", async () => {
    const r = await toolAllowForDeploy("/h/openclaw.json", "/p/openclaw.plugin.json", files(cfg(["fleet_dispatch"])));
    expect(r).toMatchObject({ checked: true, ok: false });
    expect(r.checked && r.agents[0]).toMatchObject({ agent: "main", missing: ["fleet_status"] });
    expect(r.checked && r.summary).toContain("fleet_status");
  });
  it("reports clean when every registered tool is allowed", async () => {
    expect(await toolAllowForDeploy("/h/openclaw.json", "/p/openclaw.plugin.json", files(cfg(["fleet_dispatch", "fleet_status"])))).toMatchObject({ checked: true, ok: true });
  });
  it("an absent or unreadable config is 'not checked', never a throw", async () => {
    const r = await toolAllowForDeploy("/h/openclaw.json", "/p/openclaw.plugin.json", files(undefined));
    expect(r).toMatchObject({ checked: false, reason: expect.stringContaining("cannot read") });
  });
  it("a manifest without contracts.tools is 'not checked'", async () => {
    expect(await toolAllowForDeploy("/h/openclaw.json", "/p/openclaw.plugin.json", files(cfg([]), "{}"))).toMatchObject({ checked: false });
    expect(await toolAllowForDeploy("/h/openclaw.json", "/p/openclaw.plugin.json", files(cfg([]), "not json"))).toMatchObject({ checked: false });
  });
  it("fleet_deploy attaches it to the result without changing what it deploys", () => {
    const src = gatewaySrc();
    expect(src).toContain("toolAllowForDeploy(");
    expect(src).toContain("jsonResult({ ...(r as object), toolAllow })");
  });
});
