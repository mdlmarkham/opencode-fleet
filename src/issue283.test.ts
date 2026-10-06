/**
 * Issue #283: install a spec's references INTO the run's clone.
 *
 * #262 landed the CONTRACT: a `references` field rendered in the prompt. But
 * naming a reference only TELLS the worker it exists — if the file is not in the
 * clone, the worker is pointed at something it cannot read. This half makes a
 * named reference actually present.
 *
 * Contract of `installReferences(runCwd, paths)`:
 *   1. A repo-relative path that EXISTS in the clone is reported `installed`.
 *   2. An absolute path, a `~` path, or one that escapes the clone via `..` is
 *      REFUSED (reported in `skipped` with a reason), never followed.
 *   3. A destination that is a SYMLINK is refused, never followed.
 *   4. A path not present in the clone is reported skipped with a reason — never
 *      an implied success.
 *   5. An empty list is a no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installReferences } from "./node/runtime.js";

let clone: string;
beforeEach(() => {
  clone = mkdtempSync(join(tmpdir(), "fleet283-"));
  mkdirSync(join(clone, "docs"), { recursive: true });
  writeFileSync(join(clone, "docs", "CONVENTIONS.md"), "# conventions\n");
  mkdirSync(join(clone, ".opencode", "skill", "probe"), { recursive: true });
  writeFileSync(join(clone, ".opencode", "skill", "probe", "SKILL.md"), "---\nname: probe\n---\n");
});
afterEach(() => rmSync(clone, { recursive: true, force: true }));

describe("#283: installReferences equips the clone", () => {
  it("a repo-relative path present in the clone is reported installed", async () => {
    const r = await installReferences(clone, ["docs/CONVENTIONS.md", ".opencode/skill/probe/SKILL.md"]);
    expect(r.installed.sort()).toEqual([".opencode/skill/probe/SKILL.md", "docs/CONVENTIONS.md"]);
    expect(r.skipped).toEqual([]);
  });

  it("an absolute path is refused, never followed", async () => {
    const r = await installReferences(clone, ["/etc/passwd"]);
    expect(r.installed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ path: "/etc/passwd", reason: expect.stringMatching(/absolute/i) });
  });

  it("a path escaping the clone via .. is refused", async () => {
    const r = await installReferences(clone, ["../outside.txt", "docs/../../etc/hosts"]);
    expect(r.installed).toEqual([]);
    expect(r.skipped.map((s) => s.path)).toEqual(["../outside.txt", "docs/../../etc/hosts"]);
    expect(r.skipped.every((s) => /escapes the clone/.test(s.reason))).toBe(true);
  });

  it("a symlinked destination is refused, never followed", async () => {
    symlinkSync("/etc/hostname", join(clone, "linked"));
    const r = await installReferences(clone, ["linked"]);
    expect(r.installed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ path: "linked", reason: expect.stringMatching(/symlink/i) });
  });

  it("a path not present in the clone is skipped with a reason, not reported as success", async () => {
    const r = await installReferences(clone, ["docs/MISSING.md"]);
    expect(r.installed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ path: "docs/MISSING.md", reason: expect.stringMatching(/not present/i) });
  });

  it("an empty list is a no-op", async () => {
    expect(await installReferences(clone, [])).toEqual({ installed: [], skipped: [] });
  });

  it("a blank path is skipped with a reason, never silently dropped", async () => {
    const r = await installReferences(clone, ["  "]);
    expect(r.installed).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/empty/i);
  });
});
