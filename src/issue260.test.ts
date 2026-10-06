import { afterEach, describe, expect, it } from "vitest";
import { evaluateDesignGate, normalizeGoal, type InFlightRun } from "./design-gate.js";
import { ledgerToInFlight } from "./capacity.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

const spec = (goal: string) => ({ goal, acceptance: ["it works"], verify: { command: "./v.sh" }, scope: { files: ["src/x.ts"] } });
const run = (o: Partial<InFlightRun> & { runId: string }): InFlightRun => ({ node: "dev2", cwd: "/w/p", ...o });
const gate = (g: string, ctx: Parameters<typeof evaluateDesignGate>[1], acks = []) => { const r = evaluateDesignGate(spec(g) as never, ctx, acks); if (!r.ok) throw new Error(r.error); return r.result; };

describe("#260: the same task cannot be claimed twice", () => {
  it("normalizes whitespace and case only", () => {
    expect(normalizeGoal("  Fix   THE bug\n")).toBe("fix the bug");
    expect(normalizeGoal("fix the bug")).not.toBe(normalizeGoal("fix the other bug"));
  });
  it("an identical goal already running (on ANY node) is rejected, naming the holder", () => {
    const r = gate("Fix the bug", { liveAnywhere: [run({ runId: "r1", node: "dev3", goal: "fix  the BUG" })] });
    expect(r.verdict).toBe("reject-with-reason");
    const o = r.objections.find((x) => x.id === "overlap.duplicate-goal")!;
    expect(o.severity).toBe("block-candidate");
    expect(o.evidence).toContain("r1 (dev3)");
  });
  it("a different goal, or no live run, or a run with no recorded goal is not a duplicate", () => {
    expect(gate("Fix the bug", { liveAnywhere: [run({ runId: "r1", goal: "fix another bug" })] }).objections.some((x) => x.id === "overlap.duplicate-goal")).toBe(false);
    expect(gate("Fix the bug", { liveAnywhere: [] }).objections.some((x) => x.id === "overlap.duplicate-goal")).toBe(false);
    expect(gate("Fix the bug", { liveAnywhere: [run({ runId: "r1" })] }).objections.some((x) => x.id === "overlap.duplicate-goal")).toBe(false);
  });
  it("a deliberate rerun is acknowledged with a reason, and the verdict relaxes", () => {
    const r = gate("Fix the bug", { liveAnywhere: [run({ runId: "r1", goal: "fix the bug" })] }, [{ objectionId: "overlap.duplicate-goal", reason: "rerun after a config change" }] as never);
    expect(r.objections.find((x) => x.id === "overlap.duplicate-goal")!.acknowledged).toContain("rerun");
    expect(r.verdict).not.toBe("reject-with-reason");
  });
  it("the ledger entry's spec goal (else its prompt) rides into the in-flight shape", () => {
    expect(ledgerToInFlight({ runId: "r", node: "n", cwd: "/w", prompt: "p", spec: { goal: "G" } } as never).goal).toBe("G");
    expect(ledgerToInFlight({ runId: "r", node: "n", cwd: "/w", prompt: "just a prompt" } as never).goal).toBe("just a prompt");
  });
});

describe("#260: fleet_dispatch refuses a duplicate claim end to end", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  it("a second identical spec dispatch is refused before launch; an acknowledged one proceeds", async () => {
    const loaded = await loadEntry();
    if (!loaded) return;
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
    const t = loadPlugin(loaded, { nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }], config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, project: { gate: "enforce" } }, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    try {
      const args = { cwd: "/w/p", node: "dev2", isolation: "clone", spec: spec("Add the widget") };
      await t.call("fleet_dispatch", args);
      const starts = () => t.invokes.filter((c) => c.params.prompt === "__RUN_START__").length;
      expect(starts()).toBe(1);
      const again = await t.call("fleet_dispatch", args) as Record<string, unknown>;
      expect(JSON.stringify(again)).toContain("overlap.duplicate-goal");
      expect(starts()).toBe(1);
      await t.call("fleet_dispatch", { ...args, acknowledge: [{ objectionId: "overlap.duplicate-goal", reason: "deliberate rerun" }] });
      expect(starts()).toBe(2);
    } finally { t.dispose(); }
  });
});
