import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ownershipCommand } from "./provision.js";

const me = userInfo().username;
const isRoot = process.getuid?.() === 0;
const run = (cmd: string) => spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "fleet71-"));

describe("#71: provisioned checkout ownership", () => {
  it("passes (and leaves no probe file) when the checkout belongs to the worker user", () => {
    const d = tmp();
    try {
      const cwd = join(d, "repo");
      mkdirSync(cwd);
      const r = run(ownershipCommand(cwd, me));
      expect(r.status).toBe(0);
      expect(existsSync(join(cwd, ".fleet-write-test"))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("defaults the expected owner to the parent directory's owner", () => {
    const d = tmp();
    try {
      const cwd = join(d, "repo");
      mkdirSync(cwd);
      expect(run(ownershipCommand(cwd)).status).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("FAILS loudly (exit 68) when the worker user does not exist, instead of silently skipping", () => {
    const d = tmp();
    try {
      const cwd = join(d, "repo");
      mkdirSync(cwd);
      const r = run(ownershipCommand(cwd, "no_such_fleet_user_xyz"));
      expect(r.status).toBe(68);
      expect(r.stderr).toContain("FLEET_ERROR");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(!isRoot)("as root, hands a root-owned checkout (nested files too) to the worker user", () => {
    let nobody = "";
    try { nobody = execFileSync("id", ["-un", "65534"], { encoding: "utf8" }).trim(); } catch { return; }
    const d = tmp();
    try {
      const cwd = join(d, "repo");
      mkdirSync(join(cwd, "sub"), { recursive: true });
      writeFileSync(join(cwd, "sub", "f"), "x");
      expect(statSync(cwd).uid).toBe(0);
      const r = run(ownershipCommand(cwd, nobody));
      expect(r.status).toBe(0);
      expect(statSync(cwd).uid).toBe(65534);
      expect(statSync(join(cwd, "sub", "f")).uid).toBe(65534);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(isRoot)("as a non-root principal it cannot chown, so a wrong owner is a failure, not a pass", () => {
    const d = tmp();
    try {
      const cwd = join(d, "repo");
      mkdirSync(cwd);
      // root exists on every node but is skipped by design; pick another existing user if any
      let other = "";
      try { other = execFileSync("id", ["-un", "65534"], { encoding: "utf8" }).trim(); } catch { return; }
      if (other === me) return;
      expect(run(ownershipCommand(cwd, other)).status).toBe(68);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("rejects a hostile serviceUser before it reaches a shell", () => {
    for (const bad of ["a;rm -rf /", "$(id)", "x y", "", "-rf", "a'b"]) {
      expect(() => ownershipCommand("/tmp/x", bad), bad).toThrow(/invalid serviceUser/);
    }
  });

  it("a hostile cwd is quoted, not executed", () => {
    const d = tmp();
    try {
      const marker = join(d, "pwned");
      const cwd = join(d, "r'; touch pwned; '");
      mkdirSync(cwd);
      spawnSync("bash", ["-c", ownershipCommand(cwd, me)], { cwd: d });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
