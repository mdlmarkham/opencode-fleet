/**
 * Issue #296: the fleet_design_check tool's objections must surface the gate's
 * suggestion text — the caller gets the remedy, not just the complaint.
 *
 * The gate builds suggestions today and the tool spread `...gate.result` happened
 * to carry them, but the tool layer did not own that contract: an objection handed
 * back with an empty suggestion would have shipped verbatim as `suggestion: ""`.
 * The tool now maps every objection to carry the suggestion explicitly, omitting
 * the field entirely when it is empty (never emitting an empty string), and keeps
 * every existing field (id, severity, message, evidence, acknowledged) unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSsh, loadEntry, loadPlugin, type Loaded } from "./testkit/plugin.js";
import type { GateResult } from "./design-gate.js";
import { evaluateDesignGate } from "./design-gate.js";
import type { TaskSpec } from "./spec.js";

const entry = await loadEntry();
const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
const cfgNode = () => ({ nodes: { dev2: { roles: ["worker"], ssh: false } } });

const BARE: TaskSpec = { goal: "g" };
// spec.no-verify fires on this spec; spec.no-acceptance and spec.no-scope fire on BARE.
const NO_VERIFY: TaskSpec = { goal: "g", acceptance: ["x works"], scope: { files: ["src/x/"] } };

interface ObjectionLike {
  id: string;
  severity: string;
  message: string;
  evidence: string;
  suggestion?: string;
  acknowledged?: string;
}

// Disarmed (default): the real gate runs. Armed: one objection leaves the gate with
// an EMPTY suggestion, to prove the tool omits the field rather than emitting "".
const gateCtl = vi.hoisted(() => ({ armed: false }));

vi.mock("./design-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./design-gate.js")>();
  return {
    ...actual,
    evaluateDesignGate: (...args: unknown[]) => {
      const r = (actual.evaluateDesignGate as (...a: unknown[]) => { ok: boolean; result?: GateResult; error?: string })(...args);
      if (gateCtl.armed && r.ok && r.result) {
        r.result = {
          ...r.result,
          objections: r.result.objections.map((o, i) => (i === 0 ? { ...o, suggestion: "" } : o)),
        };
      }
      return r;
    },
  };
});

describe.skipIf(!entry)("#296: fleet_design_check output carries each objection's suggestion", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); gateCtl.armed = false; });

  it("a spec with no verify gate surfaces its suggestion text in the tool output", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode() });
    const r = await p.call("fleet_design_check", { spec: NO_VERIFY }) as { ok: boolean; verdict: string; objections: ObjectionLike[] };
    expect(r.ok).toBe(true);
    const nv = r.objections.find((o) => o.id === "spec.no-verify");
    expect(nv).toBeDefined();
    expect(typeof nv!.suggestion).toBe("string");
    expect(nv!.suggestion!.length).toBeGreaterThan(0);
    // the remedy names the field the caller should add
    expect(nv!.suggestion).toContain("verify.command");
  });

  it("every objection keeps all existing fields and carries a non-empty suggestion", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode() });
    const r = await p.call("fleet_design_check", { spec: BARE }) as { verdict: string; objections: ObjectionLike[] };
    expect(r.verdict).toBe("accept-with-nudges");
    expect(r.objections.length).toBeGreaterThan(0);
    for (const o of r.objections) {
      expect(Object.prototype.hasOwnProperty.call(o, "id")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(o, "severity")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(o, "message")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(o, "evidence")).toBe(true);
      expect(typeof o.suggestion).toBe("string");
      expect(o.suggestion!.trim()).not.toBe("");
    }
    const ids = r.objections.map((o) => o.id);
    expect(ids).toContain("spec.no-acceptance");
    expect(ids).toContain("spec.no-verify");
    expect(ids).toContain("spec.no-scope");
  });

  it("an objection whose suggestion is empty omits the field rather than emitting ''", async () => {
    gateCtl.armed = true;
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode() });
    const r = await p.call("fleet_design_check", { spec: BARE }) as { ok: boolean; verdict: string; objections: ObjectionLike[] };
    expect(r.ok).toBe(true);
    // the mocked gate hands back objection[0] with suggestion ""; the tool layer
    // must drop the key entirely, never ship an empty string.
    expect(r.objections[0]!.id).toBe("spec.no-acceptance");
    expect(Object.prototype.hasOwnProperty.call(r.objections[0], "suggestion")).toBe(false);
    // the other objections keep theirs
    expect(r.objections.slice(1).every((o) => typeof o.suggestion === "string" && o.suggestion.length > 0)).toBe(true);
    // the raw value never reaches the wire as ""
  });

  it("the wire payload parses objections with suggestion present (and omits empty)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfgNode() });
    const tool = p.tools.get("fleet_design_check")!;
    const res = await tool.execute("issue296", { spec: NO_VERIFY }) as { content: Array<{ text?: string }> };
    const wire = JSON.parse(res.content[0]!.text!) as { objections: ObjectionLike[] };
    const nv = wire.objections.find((o) => o.id === "spec.no-verify");
    expect(nv).toBeDefined();
    expect(nv!.suggestion).toContain("verify.command");
    expect(wire.objections.every((o) => !Object.prototype.hasOwnProperty.call(o, "suggestion") || o.suggestion!.length > 0)).toBe(true);
  });
});

describe("#296: gate source of truth", () => {
  it("every built-in objection leaves evaluateDesignGate with a non-empty suggestion", () => {
    const r = evaluateDesignGate(BARE, { inFlight: [{ runId: "r1", node: "dev2", cwd: "/w" }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.result.objections.length).toBeGreaterThan(0);
    for (const o of r.result.objections) expect(o.suggestion.trim()).not.toBe("");
  });
});