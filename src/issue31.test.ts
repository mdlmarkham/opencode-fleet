import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedRoots, checkCwd, guardCwd, taskUsesCwd, validateId, validateTaskIds } from "./guard.js";

describe("issue #31: ids used in file paths", () => {
  it("accepts gateway-generated ids", () => {
    for (const id of ["run-1759400000000-ab12cd", "sync-1759400000000", "1759400000000", "t"]) {
      expect(validateId("id", id).ok).toBe(true);
    }
  });
  it("rejects traversal, separators, shell metacharacters, empty and overlong", () => {
    for (const id of ["../etc", "a/b", "a b", "x;rm", "$(id)", "", "a".repeat(65), "..", "a\0b"]) {
      expect(validateId("id", id).ok).toBe(false);
    }
    expect(validateId("id", 42).ok).toBe(false);
  });
  it("validateTaskIds checks runId and transferId only when present", () => {
    expect(validateTaskIds({})).toBeUndefined();
    expect(validateTaskIds({ runId: "run-1-a", transferId: "t" })).toBeUndefined();
    expect(validateTaskIds({ transferId: "../../etc" })).toMatch(/transferId/);
    expect(validateTaskIds({ runId: "a/b" })).toMatch(/runId/);
  });
});

describe("issue #31: cwd confinement", () => {
  const roots = ["/home/svcuser/fleet", "/home/svcuser"];
  it("allows strict descendants of a root", () => {
    expect(checkCwd("/home/svcuser/fleet/ohm", roots).ok).toBe(true);
    expect(checkCwd("/home/svcuser/proj", roots).ok).toBe(true);
  });
  it("refuses roots themselves, '/', and anything outside", () => {
    for (const c of ["/", "/home/svcuser", "/root/x", "/etc", "/home/other/x"]) {
      expect(checkCwd(c, roots).ok).toBe(false);
    }
    expect(checkCwd("/home/svcuser/fleet", ["/home/svcuser/fleet"]).ok).toBe(false);
  });
  it("refuses relative, empty and NUL-containing paths", () => {
    for (const c of ["", ".", "fleet/x", "/a\0b"]) expect(checkCwd(c, roots).ok).toBe(false);
  });
  it("normalizes '..' so traversal cannot escape a root", () => {
    expect(checkCwd("/home/svcuser/fleet/../../../etc", ["/home/svcuser/fleet"]).ok).toBe(false);
  });
  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(checkCwd("/home/svcuser/fleet-evil/x", ["/home/svcuser/fleet"]).ok).toBe(false);
  });
});

describe("issue #31: symlink escape and env roots", () => {
  it("refuses a symlink inside the root that points outside", async () => {
    const base = await mkdtemp(join(tmpdir(), "fleet31-"));
    try {
      const root = join(base, "ws");
      const outside = join(base, "outside");
      await mkdir(root);
      await mkdir(outside);
      await symlink(outside, join(root, "link"));
      expect((await guardCwd(join(root, "link", "x"), [root])).ok).toBe(false);
      expect((await guardCwd(join(root, "newdir"), [root])).ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it("FLEET_ALLOWED_ROOTS overrides the defaults; relative entries are dropped", () => {
    expect(allowedRoots({ FLEET_ALLOWED_ROOTS: "/srv/work:rel:/data" }, "/h")).toEqual(["/srv/work", "/data"]);
    expect(allowedRoots({}, "/home/u")).toContain("/home/u");
  });
});

describe("issue #31: which messages are cwd-checked", () => {
  it("exempts control messages that send '/' as filler", () => {
    for (const p of ["__RECEIVE__", "__SEND_CHUNK__", "__RECEIVE_CLEAN__", "__ABORT__", "__RUN_STATUS__"]) {
      expect(taskUsesCwd(p)).toBe(false);
    }
  });
  it("checks destructive ops and ordinary prompts", () => {
    for (const p of ["__UNPACK__", "__BUNDLE__", "__DIFF__", "__STATUS__", "__RUN_START__", "fix the bug"]) {
      expect(taskUsesCwd(p)).toBe(true);
    }
  });
});
