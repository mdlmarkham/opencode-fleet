/**
 * Issue #249: materialize the mission design as reviewable artifact FILES.
 *
 * The design phase's output lived only in the mission record/journal, so an
 * operator approving at `awaiting-approval` reviewed a chat summary, not a
 * reviewable artifact set — and nothing pinned WHAT was approved.
 *
 * Contract:
 *   1. `materializeDesign(repoDir, id)` writes `.fleet/missions/<id>/plan.md`
 *      and `tasks.md` into the checkout, from the record (no model calls).
 *   2. It returns the sha256 of each file, so approval can pin the revision.
 *   3. It refuses a `.fleet`/missions path that is a symlink (the mirror guard).
 *   4. plan.md carries the goal, specs and risks; tasks.md carries one row per
 *      spec with its deps, scope, acceptance and verify.
 *   5. Re-materializing is idempotent for the same record (same bytes, same sha).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMission, materializeDesign } from "./mission-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet249-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const specs = [
  { id: "a", goal: "add the parser", deps: [] as string[], task: { acceptance: ["parses x"], verify: { command: "./scripts/check.sh" }, scope: { files: ["src/a.ts"] } } },
  { id: "b", goal: "wire it up", deps: ["a"], task: { acceptance: ["wired"], verify: { command: "./scripts/check.sh" }, scope: { files: ["src/b.ts"] } } },
];

describe("#249: design materialization writes plan.md + tasks.md with pinned hashes", () => {
  it("writes both files under .fleet/missions/<id>/ and returns their sha256", async () => {
    await createMission(root, "m1", specs as never, { charterRef: ".fleet/charter.md", target: { cwd: root } });
    const r = await materializeDesign(root, "m1");
    expect(r).toMatchObject({ ok: true, written: [".fleet/missions/m1/plan.md", ".fleet/missions/m1/tasks.md"] });
    if (!r.ok) return;
    const plan = readFileSync(join(root, ".fleet", "missions", "m1", "plan.md"), "utf8");
    const tasks = readFileSync(join(root, ".fleet", "missions", "m1", "tasks.md"), "utf8");
    expect(plan).toContain("# Mission plan — m1");
    expect(plan).toContain("add the parser");
    expect(plan).toContain(".fleet/charter.md");
    expect(tasks).toContain("| id | goal | deps | scope | acceptance | verify |");
    expect(tasks).toContain("src/a.ts");
    expect(tasks).toContain("./scripts/check.sh");
    // the returned hashes are the real content hashes
    expect(r.planSha).toBe(sha(plan));
    expect(r.tasksSha).toBe(sha(tasks));
  });

  it("is idempotent: same record yields the same bytes and the same sha", async () => {
    await createMission(root, "m1", specs as never, { target: { cwd: root } });
    const first = await materializeDesign(root, "m1");
    const second = await materializeDesign(root, "m1");
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) {
      expect(second.planSha).toBe(first.planSha);
      expect(second.tasksSha).toBe(first.tasksSha);
    }
  });

  it("refuses a symlinked .fleet/missions path (the mirror guard)", async () => {
    await createMission(root, "m1", specs as never, { target: { cwd: root } });
    // a checkout whose .fleet is a symlink must be refused, never followed
    const fake = mkdtempSync(join(tmpdir(), "fleet249-link-"));
    symlinkSync(fake, join(root, ".fleet"), "dir");
    const r = await materializeDesign(root, "m1");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("symlink") });
    rmSync(fake, { recursive: true, force: true });
  });

  it("reports a missing mission rather than writing anything", async () => {
    mkdirSync(join(root, ".fleet"), { recursive: true });
    expect(await materializeDesign(root, "ghost")).toMatchObject({ ok: false });
  });
});
