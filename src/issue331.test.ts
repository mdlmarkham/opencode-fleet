/**
 * Issue #331 regression guards: the fleet_sync auto-commit must never stage
 * the plugin runtime dir.
 *
 * A run that exercises shadow points (or anything else the plugin writes)
 * leaves runtime state under `.opencode-fleet/` in the worker's checkout;
 * the next fleet_sync auto-committed the ENTIRE working tree (`git add -A`),
 * so that runtime state rode the sync into the worker branch — a near-miss
 * shipped a runtime log toward master.
 *
 * Two parts, mirroring the fix:
 *  1. `.gitignore` pins the runtime dir (docs/readFileSync pattern like
 *     src/issue324c.test.ts) so a tracked-by-default runtime log can no
 *     longer exist.
 *  2. Defence in depth at the sync itself: the untracked/staged-path filter
 *     (src/syncfilter.ts, the REAL functions both auto-commit paths use via
 *     `syncAddCommand`) excludes `.opencode-fleet/` paths; the generated
 *     staging line carries the exclusion pathspec, so a runtime path can
 *     never be staged even before .gitignore existed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterSyncPaths, isRuntimePath, RUNTIME_DIR, syncAddCommand } from "./syncfilter.js";

const here = dirname(fileURLToPath(import.meta.url));
const gitignore = readFileSync(join(here, "..", ".gitignore"), "utf8");

describe("issue #331: .gitignore pins the plugin runtime dir", () => {
  it("contains the .opencode-fleet/ entry", () => {
    expect(gitignore).toContain(".opencode-fleet/");
  });

  it("carries it with the one-line comment style near the other runtime/log entries", () => {
    const lines = gitignore.split("\n").map((l) => l.trim());
    const i = lines.indexOf(".opencode-fleet/");
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toBe("# Plugin runtime dir (issue #331): decision logs, shadow state — never tracked");
    // Near the `# Logs` block, same neighborhood as the other runtime/log entries.
    expect(lines.indexOf("# Logs")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("# Logs")).toBeLessThan(i);
  });
});

describe("issue #331: the sync untracked-path filter excludes the runtime dir", () => {
  it("keeps the normal file and drops the runtime-dir path from what would be staged", () => {
    const untracked = [
      "src/index.ts",
      ".opencode-fleet/s1-shadow.jsonl",
      "docs/operators.md",
      ".opencode-fleet/missions/m1/journal.jsonl",
    ];
    const kept = filterSyncPaths(untracked);
    expect(kept).toEqual(["src/index.ts", "docs/operators.md"]);
  });

  it("is fail-safe over the runtime-dir name forms a status line can carry", () => {
    for (const p of [".opencode-fleet", ".opencode-fleet/", "./.opencode-fleet/x.jsonl", ".opencode-fleet//nested/y"]) {
      expect(isRuntimePath(p), p).toBe(true);
    }
    // Never overmatch: the tracked project record and lookalikes stay.
    for (const p of ["fleet/.opencode-fleet-keep.txt", "x.opencode-fleet/", "src/.opencode-fleet-reader.ts", "opencode-fleet/"]) {
      expect(isRuntimePath(p), p).toBe(false);
    }
  });

  it("the exported dir constant matches the runtime dir the plugin writes (s1-shadow)", () => {
    expect(RUNTIME_DIR).toBe(".opencode-fleet");
  });

  it("the generated staging line stages -A but only ever DE-selects the runtime dir", () => {
    const cmd = syncAddCommand();
    expect(cmd).toContain("git add -A");
    expect(cmd).toContain(":(exclude).opencode-fleet");
    // A non-runtime path is never excluded... and there is no include pathspec
    // that could re-admit a runtime path: exclusions only.
    expect(cmd).not.toMatch(/include\)/);
  });
});