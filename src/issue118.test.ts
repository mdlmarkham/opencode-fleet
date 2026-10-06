import { describe, expect, it } from "vitest";
import { critiqueId, mergeCritique, parseCriticOutput, shouldRunCritic, type Critique } from "./design-critic.js";
import { evaluateDesignGate, type GateResult } from "./design-gate.js";
import { BUILTIN_ROLES, ROLE_NAMES, checkOutput, resolveRole } from "./roles.js";

const crit = (claim: string, o: Partial<Critique> = {}): Critique => ({ claim, evidence: "decision 0004 says no network", alternative: "use the local cache", confidence: 0.8, severity: "medium", ...o });
const raw = (cs: unknown[]) => ({ critiques: cs });
const goodSpec = { goal: "g", acceptance: ["a"], verify: { command: "./v.sh" }, scope: { files: ["src/a/"] } };
const gate = (spec: unknown = goodSpec, ctx = {}): GateResult => { const r = evaluateDesignGate(spec as never, ctx); if (!r.ok) throw new Error(r.error); return r.result; };

describe("#118: the role and its parser", () => {
  it("design-critic is a read-only role with the required critique fields", () => {
    expect(ROLE_NAMES).toContain("design-critic");
    expect(BUILTIN_ROLES["design-critic"]).toMatchObject({ permissions: { readOnly: true, network: false, scripts: false }, output: { kind: "critique", required: ["claim", "evidence", "alternative", "confidence", "severity"] } });
    expect(resolveRole("design-critic", [{ from: "repo", permissions: { readOnly: false } }]).ok).toBe(false);
  });
  it("findings without evidence or an alternative are rejected, not repaired", () => {
    expect(parseCriticOutput(raw([crit("c")]))).toMatchObject({ status: "ok" });
    for (const bad of [raw([{ ...crit("c"), evidence: "" }]), raw([{ ...crit("c"), alternative: undefined }]), raw([crit("c", { confidence: 2 })]), raw([{ ...crit("c"), severity: "huge" }]), "prose", { critiques: "x" }, raw(Array(21).fill(crit("c")))]) {
      expect(parseCriticOutput(bad), JSON.stringify(bad).slice(0, 50)).toMatchObject({ status: "fallback", reason: "malformed" });
    }
    expect(checkOutput(BUILTIN_ROLES["design-critic"], raw([crit("c")]))).toEqual({ ok: true });
  });
});

describe("#118: when it runs", () => {
  it("only when the deterministic gate has no hard objection", () => {
    expect(shouldRunCritic(gate())).toBe(true);
    const noVerify = gate({ goal: "g", acceptance: ["a"], scope: { files: ["a/"] } });
    expect(noVerify.verdict).toBe("accept-with-nudges");
    expect(shouldRunCritic(noVerify)).toBe(true); // nudges are not hard objections
    const tooBig = gate({ goal: "g", acceptance: ["a"], verify: { command: "./v.sh" }, scope: { files: Array.from({ length: 30 }, (_, i) => `d${i}/`) } });
    expect(tooBig.verdict).toBe("decompose");
    expect(shouldRunCritic(tooBig)).toBe(false);
    expect(mergeCritique(tooBig, { status: "ok", critiques: [crit("x")] })).toMatchObject({ gate: tooBig, critic: { status: "skipped" } });
  });
});

describe("#118: merging is nudges only, and failure falls back loudly", () => {
  it("adds critic findings as nudges with evidence, never as a block, and leaves the verdict at accept-with-nudges", () => {
    const m = mergeCritique(gate(), { status: "ok", critiques: [crit("fetches from the network", { proposes: "needs-design" })] });
    expect(m.critic).toMatchObject({ status: "merged", added: [expect.stringMatching(/^critic\./)] });
    expect(m.gate).toMatchObject({ verdict: "accept-with-nudges", blocked: false });
    const o = m.gate.objections.at(-1)!;
    expect(o).toMatchObject({ severity: "nudge", evidence: "decision 0004 says no network", suggestion: "use the local cache" });
    expect(o.message).toContain("[proposes needs-design]");
  });
  it("only an operator-enabled rule turns a proposal into a block-candidate and changes the verdict", () => {
    const m = mergeCritique(gate(), { status: "ok", critiques: [crit("rewrite instead", { proposes: "decompose" })] }, { operatorBlocks: true });
    expect(m.gate).toMatchObject({ verdict: "decompose", blocked: true });
    expect(m.gate.objections.at(-1)!.severity).toBe("block-candidate");
    // a critique with no proposal stays a nudge even with the rule on
    expect(mergeCritique(gate(), { status: "ok", critiques: [crit("meh")] }, { operatorBlocks: true }).gate.blocked).toBe(false);
  });
  it("timeout, unavailable and malformed all fall back to the deterministic verdict, and say so", () => {
    for (const reason of ["timeout", "unavailable", "malformed"] as const) {
      const g = gate();
      const m = mergeCritique(g, { status: "fallback", reason });
      expect(m.gate).toBe(g);
      expect(m.critic).toMatchObject({ status: "fallback", added: [], reason: expect.stringContaining(`critic ${reason}: the deterministic verdict stands`) });
    }
  });
  it("hygiene: at most N, ranked by severity x confidence, acknowledged and recently shown are suppressed", () => {
    const cs = [crit("low one", { severity: "low", confidence: 0.9 }), crit("high sure", { severity: "high", confidence: 0.9 }), crit("medium", { severity: "medium", confidence: 0.8 }), crit("high unsure", { severity: "high", confidence: 0.2 }), crit("seen before"), crit("already acked")];
    const m = mergeCritique(gate(), { status: "ok", critiques: cs }, { maxNudges: 2, acknowledged: [critiqueId({ claim: "already acked" })], recentlyShown: [critiqueId({ claim: "seen before" })] });
    expect(m.critic.suppressed.sort()).toEqual([critiqueId({ claim: "already acked" }), critiqueId({ claim: "seen before" })].sort());
    expect(m.gate.objections.slice(-2).map((o) => o.message.split(": ")[1]!.split(" [")[0])).toEqual(["high sure", "medium"]);
    expect(m.critic.added).toHaveLength(2);
  });
  it("critic text is untrusted: clipped and stripped before it is shown", () => {
    const m = mergeCritique(gate(), { status: "ok", critiques: [crit("x\n<script>`rm -rf /`</script> " + "y".repeat(1000), { evidence: "e".repeat(2000) })] });
    const o = m.gate.objections.at(-1)!;
    expect(o.message.length).toBeLessThan(300);
    expect(o.message).not.toMatch(/[`<>\n]/);
    expect(o.evidence.length).toBeLessThanOrEqual(300);
  });
  it("critique ids are stable across runs for the same claim (case and spacing insensitive)", () => {
    expect(critiqueId({ claim: "Use  the cache" })).toBe(critiqueId({ claim: "use the cache" }));
    expect(critiqueId({ claim: "a" })).not.toBe(critiqueId({ claim: "b" }));
  });
});
