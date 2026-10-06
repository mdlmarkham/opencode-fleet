import { describe, expect, it } from "vitest";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

// Issue #171: the tool schemas are paid for by the calling agent on every session. This measures them and
// fails above a budget, so growth is a visible decision. RATCHET the budget DOWN when you trim; raise it
// only deliberately, in the PR that adds the tool or parameter, and say why.
// Raised 37_500 -> 39_900 across #116/#120/#123: fleet_project_start (intake), fleet_project_upkeep (proposal-only), fleet_mission_show (read-only). Merged actual 39_863.
// Ratcheted down to 39_200 in #239; raised to 39800 in #132: fleet_mission_project and the projection config block.
// Ratcheted down to 39_200 in #239; raised in #124: fleet_mission_abort (kill switch).
// Combined in #132 merge: projection additions over #124's autonomy additions. Merged actual PENDING.
export const SCHEMA_BUDGET_CHARS = 39800;
// Per tool: no single tool may balloon unnoticed.
export const PER_TOOL_BUDGET_CHARS = 10_000;

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the schema budget test really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#171: tool-schema footprint", () => {
  const p = loadPlugin(loaded!);
  const sizes = [...p.tools.values()].map((t) => ({ name: t.name, chars: JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length }));
  const total = sizes.reduce((n, t) => n + t.chars, 0);

  it("the serialized schemas of all tools stay within the budget", () => {
    expect(total, `total ${total} chars; biggest: ${[...sizes].sort((a, b) => b.chars - a.chars).slice(0, 4).map((s) => `${s.name}=${s.chars}`).join(", ")}`).toBeLessThanOrEqual(SCHEMA_BUDGET_CHARS);
  });

  it("no single tool exceeds its budget (fleet_dispatch is the largest)", () => {
    for (const s of sizes) expect(s.chars, s.name).toBeLessThanOrEqual(PER_TOOL_BUDGET_CHARS);
  });

  it("descriptions carry no issue numbers: they do nothing for the model (history belongs in the docs)", () => {
    const text = JSON.stringify([...p.tools.values()].map((t) => [t.description, t.parameters]));
    expect(text.match(/\b[Ii]ssues? #\d+/g) ?? []).toEqual([]);
  });

  it("every tool has a non-empty description and a schema", () => {
    for (const t of p.tools.values()) {
      expect((t.description ?? "").length, t.name).toBeGreaterThan(20);
      expect(t.parameters, t.name).toBeDefined();
    }
  });
});
