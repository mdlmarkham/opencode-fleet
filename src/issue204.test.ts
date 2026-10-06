import { describe, expect, it } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

const node = [{ nodeId: "n1", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] }];
const spec = { goal: "make the file", acceptance: ["file exists"], scope: { files: ["e2e-smoke.txt"] } };
const reply = () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
const run = async (args: Record<string, unknown>) => {
  const restore = fakeSsh("FLEET_CWD=ok");
  const t = loadPlugin((await loadEntry())!, { nodes: node, config: { nodes: { dev3: { roles: ["worker"], ssh: false } } }, invoke: reply });
  try {
    const r = (await t.call("fleet_dispatch", { cwd: "/w/proj", node: "dev3", ...args })) as Record<string, any>;
    return { r, params: t.invokes.map((i) => i.params as Record<string, any>).filter((x) => x.prompt === "__RUN_START__") };
  } finally { t.dispose(); restore(); }
};

describe("#204: a file gate with a spec", () => {
  it("spec.verify.files is accepted and reaches the node as the gate", async () => {
    const { r, params } = await run({ spec: { ...spec, verify: { files: ["e2e-smoke.txt"] } } });
    expect(r.error).toBeUndefined();
    expect(params.some((p) => p.expect?.files?.[0] === "e2e-smoke.txt")).toBe(true);
  });
  it("a flat expect.files alongside a spec WITHOUT verify is honoured, not dropped", async () => {
    const { r, params } = await run({ spec, expect: { files: ["e2e-smoke.txt"] } });
    expect(r.error).toBeUndefined();
    expect(params.some((p) => p.expect?.files?.[0] === "e2e-smoke.txt")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("spec.no-verify");
    expect(r.verification?.gate).not.toBe("none");
  });
  it("giving both spec.verify and expect is refused, never guessed", async () => {
    const { r, params } = await run({ spec: { ...spec, verify: { files: ["a"] } }, expect: { files: ["b"] } });
    expect(r.error).toMatch(/once/);
    expect(params).toHaveLength(0);
  });
  it("a spec with no gate at all still gets the nudge, and it names only fields the schema allows", async () => {
    const { r } = await run({ spec });
    expect(JSON.stringify(r)).toContain("spec.no-verify");
    expect(r.verification?.gate).toBe("none");
  });
});
