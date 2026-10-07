import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_POINTS, pointById, shadowPoint } from "./builtin-points.js";
import { costClassOf } from "./cost-class.js";
import { effectiveMode } from "./decision-points.js";
import { gatewaySrc } from "./testkit/src.js";
import { fakeSshMultiline, loadEntry, loadPlugin } from "./testkit/plugin.js";

describe("#259 slice 2: dispatch.heavy is a shadow point with the cost classifier as its baseline", () => {
  it("is declared, shadow-only, with a safe default that keeps the caller's model", () => {
    const p = pointById("dispatch.heavy")!;
    expect(p).toBeDefined();
    expect(BUILTIN_POINTS.map((x) => x.id)).toContain("dispatch.heavy");
    expect(effectiveMode(p)).toBe("shadow");
    expect(p.safeDefault).toBe("keep-requested-model");
  });

  it("a shadow run logs S1's probability next to the classifier's verdict, and never throws or acts", async () => {
    const records: object[] = [];
    const decider = async () => ({ ok: true, answers: { "dispatch.heavy": { type: "boolean", probabilityTrue: 0.9 } } });
    const heavy = { goal: "Rework guard.ts confinement", acceptance: ["a", "b"] };
    const d = await shadowPoint({}, "dispatch.heavy", { text: "spec" }, costClassOf(heavy) === "heavy", undefined, { decider: decider as never, sink: (e) => { records.push(e); } });
    expect(d).toBeDefined();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toMatch(/dispatch\.heavy/);
    expect(costClassOf(heavy)).toBe("heavy"); // "guard" is a sensitive surface
  });

  it("is wired only behind `s1` config and only in shadow (the default path loads nothing from S1)", () => {
    const src = gatewaySrc();
    expect(src).toMatch(/if \(bp && specCheck\.spec\) \{[\s\S]{0,400}shadowPoint\(cfg\.s1, "dispatch\.heavy"/);
    expect(src).toContain("if (cfg.s1 != null) {");
  });
});

describe("#259: fleet_design_check reports the cost class (advisory)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  it("returns costClass for a spec: trivial, standard, heavy", async () => {
    const loaded = await loadEntry();
    if (!loaded) return;
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    const t = loadPlugin(loaded, { nodes: [], config: {} });
    try {
      const run = (goal: string, acceptance: string[], files: string[]) => t.call("fleet_design_check", { spec: { goal, acceptance, verify: { command: "./scripts/verify.sh" }, scope: { files } } }) as Promise<Record<string, any>>;
      expect((await run("Fix typo in src/a.ts", ["typo fixed"], ["src/a.ts"])).costClass).toBe("trivial");
      expect((await run("Add a field to src/a.ts and src/b.ts", ["a", "b", "c"], ["src/a.ts", "src/b.ts"])).costClass).toBe("standard");
      expect((await run("Rework the ssh provisioning in src/provision.ts", ["a"], ["src/provision.ts"])).costClass).toBe("heavy");
    } finally { t.dispose(); }
  });
});
