import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFromNode } from "./provision.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

/** Real git: bare origin, a worker clone on a feature branch with one commit, and its base64 bundle. */
function harness() {
  const base = mkdtempSync(join(tmpdir(), "fleet177-"));
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worker = join(base, "worker");
  git(base, "init", "-q", "--bare", origin);
  git(base, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "README.md"), "hi\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(base, "clone", "-q", "--branch", "main", origin, worker);
  git(worker, "checkout", "-q", "-b", "feature/x");
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, "a.txt"), "x\n");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "reviewed work");
  const reviewed = git(worker, "rev-parse", "HEAD");
  // A later, unreviewed commit lands on the same branch before the sync.
  writeFileSync(join(worker, "b.txt"), "unreviewed\n");
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "unreviewed work");
  const tip = git(worker, "rev-parse", "HEAD");
  const bundle = join(base, "w.bundle");
  git(worker, "bundle", "create", bundle, "--all");
  const b64 = readFileSync(bundle).toString("base64");
  const originRef = (b: string) => { try { return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; } };
  const run = (expectedHead?: string) =>
    syncFromNode("local", worker, origin, "main", { mode: "from-base64", base64: b64, branch: "main", workerBranch: "feature/x" }, undefined, undefined, expectedHead ? { expectedHead } : undefined);
  return { reviewed, tip, originRef, run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("#177: fleet_sync publishes only the reviewed head (real git)", () => {
  it("a bundle whose tip is NOT the reviewed sha is refused and nothing is pushed", async () => {
    const h = harness();
    try {
      const r = await h.run(h.reviewed);
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("head-mismatch");
      expect(r.error).toContain("unreviewed commits");
      expect(r.error).toContain(h.tip.slice(0, 12));
      expect(h.originRef("feature/x")).toBe("");
    } finally { h.cleanup(); }
  });

  it("a bundle whose tip is exactly the reviewed sha is published (case-insensitive)", async () => {
    const h = harness();
    try {
      const r = await h.run(h.tip.toUpperCase());
      expect(r.ok).toBe(true);
      expect(r.synced).toBe(true);
      expect(h.originRef("feature/x")).toBe(h.tip);
    } finally { h.cleanup(); }
  });

  it("without an expected head the behaviour is unchanged (publishes the tip)", async () => {
    const h = harness();
    try {
      const r = await h.run();
      expect(r.ok).toBe(true);
      expect(h.originRef("feature/x")).toBe(h.tip);
    } finally { h.cleanup(); }
  });
});
