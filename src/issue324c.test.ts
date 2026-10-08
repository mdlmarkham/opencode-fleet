/**
 * Task #324c (issue #324 part 2): the gate names an environmental failure
 * (`verified: null` + `endedBy: "gate-unavailable"`, issue #324b / PR #328) and
 * its messages and the ledger's sync refusal all point the operator at
 * "Bootstrapping a clone" in docs/operators.md (src/tools/dispatch.ts
 * verifiedNote, src/tools/runs.ts, src/ledger.ts). Until part 2 landed, that
 * pointer dangled — a fresh clone has no node_modules (provisioning installs
 * nothing), so every npm-based gate died at `tsc: not found` (127).
 *
 * Docs-consistency pins, readFileSync pattern like issue34.test.ts:
 * - operators.md carries the exact heading the code pointers name, with the
 *   shipped `scripts/bootstrap.sh` pattern (`setup: "scripts/bootstrap.sh"`,
 *   `npm ci --ignore-scripts`).
 * - the SKILL carries the same guidance briefly.
 * The checkSetup repo-relative allowance this guidance relies on is behavior:
 * already pinned by src/issue34.test.ts and src/issue67.test.ts — not
 * duplicated here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const operators = readFileSync(join(here, "..", "docs", "operators.md"), "utf8");
const skill = readFileSync(join(here, "..", "skills", "opencode-fleet", "SKILL.md"), "utf8");

describe("issue #324c: bootstrapping a clone docs", () => {
  it("operators.md has the exact heading the dispatch/run/ledger pointers name", () => {
    expect(operators).toContain('## Bootstrapping a clone');
  });

  it("that section carries the shipped setup-script pattern", () => {
    const section = operators.slice(operators.indexOf('## Bootstrapping a clone'));
    expect(section).toContain("scripts/bootstrap.sh");
    expect(section).toContain("npm ci --ignore-scripts");
    expect(section).toContain('setup: "scripts/bootstrap.sh"');
  });

  it("that section says setup runs as the SSH principal (often root), never 'the worker principal'", () => {
    const section = operators.slice(operators.indexOf('## Bootstrapping a clone'));
    expect(section).toContain("SSH principal");
    expect(section).not.toContain("runs as the worker principal");
  });

  it("the SKILL carries the same guidance", () => {
    expect(skill).toContain("scripts/bootstrap.sh");
    expect(skill).toContain("--ignore-scripts");
  });
});
