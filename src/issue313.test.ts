import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseRules, parseYaml } from "./project.js";

describe("#313: an unquoted ' #' must not silently truncate a value", () => {
  it("flags a plain scalar whose comment swallows the tail, naming the dropped text", () => {
    const r = parseYaml("- text (the #263 incident).\n", "f.yml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/silently drops "#263 incident\)\."/);
  });
  it("quoted and escaped forms parse whole", () => {
    expect(parseYaml('- "text (the #263 incident)."\n', "f").ok).toBe(true);
    const q = parseYaml("k: 'a #1 b'\n", "f");
    expect(q).toMatchObject({ ok: true, value: { k: "a #1 b" } });
  });
  it("an ordinary spaced comment is still a comment", () => {
    expect(parseYaml("k: v # note\n# whole line\nj: 1\n", "f")).toMatchObject({ ok: true, value: { k: "v", j: 1 } });
  });
  it("a rules file with a swallowed citation fails validation; this repo's own rules.yml is clean", () => {
    const bad = 'schemaVersion: 1\nrules:\n  - id: a\n    severity: nudge\n    message: see the #1 incident\n    match: {keywords: [x]}\n';
    expect(parseRules(bad, "rules.yml").errors.length).toBeGreaterThan(0);
    expect(parseRules(readFileSync(".fleet/rules.yml", "utf8"), "rules.yml").errors).toEqual([]);
  });
});

describe("#313: the existing strictness is unchanged", () => {
  it("aliases and duplicate keys are still rejected", () => {
    expect(parseYaml("a: &x 1\nb: *x\n", "f").ok).toBe(false);
    expect(parseYaml("a: 1\na: 2\n", "f").ok).toBe(false);
  });
});
