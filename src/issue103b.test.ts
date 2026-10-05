/**
 * Issue #103 (group b): the fleet_sync secret scan must inspect the range
 * base..tip COMMIT BY COMMIT, not only the net diff. A secret added in an
 * intermediate commit and removed before the tip survives in the pushed
 * history, so the policy must refuse it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFromNode } from "./provision.js";
import { secretsInCommits } from "./syncpolicy.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" }).toString().trim();

function commit(repo: string, file: string, content: string, msg: string) {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

/**
 * Real-git harness: bare origin, a worker clone with an arbitrary commit
 * sequence on top of main, and the worker branch bundled for sync.
 */
function harness(commits: Array<{ file: string; content: string; msg: string }>, opts: { workerBranch?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "fleet103b-"));
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
  if (opts.workerBranch) git(worker, "checkout", "-q", "-b", opts.workerBranch);
  for (const c of commits) commit(worker, c.file, c.content, c.msg);
  const bundle = join(base, "w.bundle");
  git(worker, "bundle", "create", bundle, "--all");
  const b64 = readFileSync(bundle).toString("base64");
  const originRef = (b: string) => {
    try { return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; }
  };
  const run = () =>
    syncFromNode("local", worker, origin, "main", { mode: "from-base64", base64: b64, branch: "main", workerBranch: opts.workerBranch ?? "main", destBranch: undefined }, undefined);
  return { base, origin, worker, originRef, run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("issue #103b: per-commit secret scan in fleet_sync", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet103b-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses when a secret is added in one commit and removed in a later one (net diff is clean)", async () => {
    const h = harness([
      { file: "cfg.env", content: `TOKEN=${SECRET}\n`, msg: "add config" },
      { file: "cfg.env", content: "TOKEN=ok\n", msg: "clean it up" },
      { file: "n.txt", content: "n\n", msg: "more work" },
    ], { workerBranch: "feature/leak" });
    try {
      const r = await h.run();
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(h.originRef("feature/leak")).toBe("");
    } finally { h.cleanup(); }
  });

  it("passes a clean range through unchanged", async () => {
    const h = harness([
      { file: "a.txt", content: "a\n", msg: "a" },
      { file: "b.txt", content: "b\n", msg: "b" },
    ], { workerBranch: "feature/clean" });
    try {
      const r = await h.run();
      expect(r.ok).toBe(true);
      expect(r.synced).toBe(true);
      expect(h.originRef("feature/clean")).not.toBe("");
    } finally { h.cleanup(); }
  });

  it("still refuses a secret present at the tip (net diff case)", async () => {
    const h = harness([
      { file: "a.txt", content: "a\n", msg: "a" },
      { file: "cfg.env", content: `TOKEN=${SECRET}\n`, msg: "leak at tip" },
    ], { workerBranch: "feature/tip" });
    try {
      const r = await h.run();
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(h.originRef("feature/tip")).toBe("");
    } finally { h.cleanup(); }
  });

  it("secretsInCommits scans each commit and reports the offender", async () => {
    const seed = join(dir, "r");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "f.txt", "one\n", "c1");
    commit(seed, "f.txt", `${SECRET}\n`, "c2");
    commit(seed, "f.txt", "three\n", "c3");
    const head = git(seed, "rev-parse", "HEAD");
    const root = git(seed, "rev-list", "--max-parents=0", "HEAD");
    await expect(secretsInCommits(seed, root, head)).rejects.toThrow(/credential-shaped/);
    // The pre-fix net diff would read clean here:
    const net = execFileSync("git", ["-C", seed, "diff", "--text", "--unified=0", `${root}..${head}`], { stdio: "pipe" }).toString();
    expect(net).not.toContain("+TOKEN=");
  });

  it("secretsInCommits passes a clean range silently", async () => {
    const seed = join(dir, "c");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "f.txt", "one\n", "c1");
    commit(seed, "f.txt", "two\n", "c2");
    const head = git(seed, "rev-parse", "HEAD");
    const root = git(seed, "rev-list", "--max-parents=0", "HEAD");
    await expect(secretsInCommits(seed, root, head)).resolves.toBeUndefined();
  });
});