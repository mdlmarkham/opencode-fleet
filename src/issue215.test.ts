import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// Operator-only tools that a working session never needs to see in SKILL.md,
// described in the guide instead. Keep this tiny; the fix for an undocumented
// user-facing tool is to add it to SKILL.md, not to allowlist it.
const OPERATOR_ONLY = ["fleet_deploy", "fleet_provision"];

describe("SKILL.md tool-coverage drift guard (#215)", () => {
  const src = readFileSync(resolve(here, "index.ts"), "utf8");
  const skill = readFileSync(resolve(here, "../skills/opencode-fleet/SKILL.md"), "utf8");

  const registered = [...src.matchAll(/name: "(fleet_[a-z0-9_]+)"/g)].map((m) => m[1]);

  it("parses a non-trivial number of registered tool names (>= 25)", () => {
    expect(registered.length, "expected >= 25 `name: \"fleet_*\"` tool registrations in src/index.ts").toBeGreaterThanOrEqual(25);
  });

  it("every registered tool is named in SKILL.md or explicitly allowlisted", () => {
    const missing = registered.filter((t) => !skill.includes(t) && !OPERATOR_ONLY.includes(t));
    expect(
      missing,
      `tools registered in src/index.ts but neither documented in skills/opencode-fleet/SKILL.md nor in OPERATOR_ONLY ${JSON.stringify(OPERATOR_ONLY)}`,
    ).toEqual([]);
  });
});