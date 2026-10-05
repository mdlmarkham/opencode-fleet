import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/check-hygiene.sh", import.meta.url));

const gitAvailable = (() => {
  try { execFileSync("git", ["--version"], { stdio: "pipe" }); return true; } catch { return false; }
})();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

type Entry = string | { link: string };

/** A real git repo in a temp dir with every given file/symlink committed. */
function repoWith(entries: Record<string, Entry>): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet159-"));
  git(dir, "init", "-q");
  for (const [path, e] of Object.entries(entries)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof e === "string") {
      writeFileSync(target, e);
    } else {
      symlinkSync(e.link, target);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** Runs the guard against a repo dir; never throws, so violations are assertable. */
function runGuard(repoDir: string): { status: number; output: string } {
  try {
    const stdout = execFileSync("bash", [scriptPath, repoDir], { encoding: "utf8", timeout: 30000 });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe.skipIf(!gitAvailable)("#159: check-hygiene", () => {
  it("a clean repo passes", () => {
    const repo = repoWith({ "README.md": "hi\n" });
    try {
      const r = runGuard(repo);
      expect(r.status).toBe(0);
      expect(r.output).toContain("hygiene: ok");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("a committed absolute symlink fails and names the path", () => {
    const repo = repoWith({ node_modules: { link: "/tmp/fleet159-outside" } });
    try {
      const r = runGuard(repo);
      expect(r.status).not.toBe(0);
      expect(r.output).toContain("node_modules");
      expect(r.output).toContain("/tmp/fleet159-outside");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("a symlink that escapes the repo fails", () => {
    const repo = repoWith({ link: { link: "../../outside" } });
    try {
      const r = runGuard(repo);
      expect(r.status).not.toBe(0);
      expect(r.output).toContain("link");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("a relative in-repo symlink is allowed", () => {
    const repo = repoWith({ "README.md": "hi\n", "docs/x": { link: "../README.md" } });
    try {
      const r = runGuard(repo);
      expect(r.status).toBe(0);
      expect(r.output).toContain("hygiene: ok");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("a tracked file under node_modules/ fails", () => {
    const repo = repoWith({ "node_modules/pkg/index.js": "module.exports = 1;\n" });
    try {
      const r = runGuard(repo);
      expect(r.status).not.toBe(0);
      expect(r.output).toContain("node_modules/pkg/index.js");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("a tracked TASK-*.md brief fails; a non-matching lookalike passes", () => {
    const bad = repoWith({ "TASK-999.md": "brief\n" });
    try {
      const r = runGuard(bad);
      expect(r.status).not.toBe(0);
      expect(r.output).toContain("TASK-999.md");
    } finally { rmSync(bad, { recursive: true, force: true }); }

    const ok = repoWith({ "NOTES-TASK.md": "notes\n" });
    try {
      expect(runGuard(ok).status).toBe(0);
    } finally { rmSync(ok, { recursive: true, force: true }); }
  });
});