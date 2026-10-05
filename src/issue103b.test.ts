/**
 * Issue #103 (group b): the fleet_sync secret scan must inspect the range
 * base..tip COMMIT BY COMMIT, not only the net diff. A secret added in an
 * intermediate commit and removed before the tip survives in the pushed
 * history, so the policy must refuse it. The per-commit scan must also catch
 * a secret introduced ONLY by a MERGE commit's resolution (the combined diff
 * and both branch heads read clean) and one in the range's PARENTLESS root
 * commit (`commit^!` diffs nothing there).
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
  const run = (base?: string) =>
    syncFromNode("local", worker, origin, base ?? "main", { mode: "from-base64", base64: b64, branch: base ?? "main", workerBranch: opts.workerBranch ?? "main", destBranch: undefined }, undefined);
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

  it("NEW merge-resolution: a secret added only in the merge commit's resolution is refused", async () => {
    const h = harness([{ file: "seed.txt", content: "s\n", msg: "seed" }], { workerBranch: "feature/merge" });
    try {
      const worker = h.worker;
      // Build the bypass on a dedicated branch whose TIP is the merge commit,
      // so syncFromNode scans base..that-tip and must see the merge.
      git(worker, "checkout", "-q", "-b", "side", "main");
      commit(worker, "side.txt", "b\n", "side work");
      git(worker, "checkout", "-q", "feature/merge");
      commit(worker, "main.txt", "a\n", "main work");
      git(worker, "merge", "--no-commit", "--no-ff", "side");
      writeFileSync(join(worker, "secret.txt"), `TOKEN=${SECRET}\n`);
      git(worker, "add", "-A");
      git(worker, "commit", "-q", "-m", "merge with resolution");
      const merge = git(worker, "rev-parse", "HEAD");
      // Sanity: this really is a two-parent commit, and the merge tip IS
      // feature/merge's tip — the range main..feature/merge contains the merge.
      expect(git(worker, "rev-list", "--parents", "--max-count=1", merge).split(" ").length - 1).toBe(2);
      expect(git(worker, "rev-parse", "feature/merge").trim()).toBe(merge);
      // The bypass shape: the merge's per-parent diffs DO reveal the secret
      // (which is why per-parent scanning closes it), while the NET diff from
      // the base reads clean, so the old net-diff scan missed it.
      const perParentReveals = [1, 2].some((p) => {
        const d = execFileSync("git", ["-C", worker, "diff", "--text", "--unified=0", `${merge}^${p}`, merge], { stdio: "pipe" }).toString();
        return d.includes(SECRET);
      });
      expect(perParentReveals).toBe(true);
      const net = execFileSync("git", ["-C", worker, "diff", "--text", "--unified=0", "main...feature/merge"], { stdio: "pipe" }).toString();
      expect(net).not.toContain(SECRET);
      // Now the bundle must be rebuilt to include the merge commit.
      git(worker, "bundle", "create", join(h.base, "w.bundle"), "--all");
      const r = await h.run("main");
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(h.originRef("feature/merge")).toBe("");
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally { h.cleanup(); }
  });

  it("NEW root-commit: a secret in the range's parentless root commit is refused", async () => {
    const seed = join(dir, "r");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    // The range root IS the repo's parentless first commit: `commit^!` diffs
    // nothing there, so the empty-tree diff must cover it.
    commit(seed, "cfg.env", `TOKEN=${SECRET}\n`, "root leak");
    commit(seed, "f.txt", "one\n", "c2");
    const head = git(seed, "rev-parse", "HEAD");
    const root = git(seed, "rev-list", "--max-parents=0", "HEAD");
    expect(root.split("\n").length).toBe(1);
    // Pre-fix behavior would swallow the root's diff failure and pass:
    await expect(secretsInCommits(seed, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head)).rejects.toThrow(/credential-shaped/);
  });

  it("NEW root-commit end-to-end: bundle whose range root carries a secret is refused", async () => {
    // Worker history STARTS at a parentless commit (orphan branch), i.e. the
    // scanned range has a root with no parent at all.
    const base = mkdtempSync(join(tmpdir(), "fleet103b-"));
    const originGit = join(base, "origin.git");
    const seed = join(base, "seed");
    const worker = join(base, "worker");
    git(base, "init", "-q", "--bare", originGit);
    git(base, "clone", "-q", originGit, seed);
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(base, "clone", "-q", "--branch", "main", originGit, worker);
    // An ORPHAN branch: its first commit has no parent — the range root.
    git(worker, "checkout", "-q", "--orphan", "feature/orphan-root");
    git(worker, "rm", "-q", "-rf", "--", ".");
    commit(worker, "cfg.env", `TOKEN=${SECRET}\n`, "orphan root carries a secret");
    commit(worker, "n.txt", "n\n", "more work");
    const bundle = join(base, "w.bundle");
    git(worker, "bundle", "create", bundle, "--all");
    const b64 = readFileSync(bundle).toString("base64");
    const originRef = (b: string) => { try { return git(originGit, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; } };
    try {
      // Scan against the EMPTY TREE so the parentless root of the orphan
      // branch is INSIDE the scanned range (main..orphan excludes nothing
      // useful, and the root has no parent to diff against otherwise).
      const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const r = await syncFromNode("local", worker, originGit, EMPTY_TREE, { mode: "from-base64", base64: b64, branch: EMPTY_TREE, workerBranch: "feature/orphan-root", destBranch: undefined }, undefined);
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(originRef("feature/orphan-root")).toBe("");
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally { rmSync(base, { recursive: true, force: true }); }
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
    await expect(secretsInCommits(seed, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head)).rejects.toThrow(/credential-shaped/);
    // The pre-fix net diff would read clean here:
    const net = execFileSync("git", ["-C", seed, "diff", "--text", "--unified=0", `${root}..${head}`], { stdio: "pipe" }).toString();
    expect(net).not.toContain(SECRET); // net diff reads clean
  });

  it("secretsInCommits catches the merge-resolution case at the helper level too", async () => {
    const seed = join(dir, "m");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "base.txt", "0\n", "c0");
    git(seed, "checkout", "-q", "-b", "side");
    commit(seed, "side.txt", "b\n", "side");
    git(seed, "checkout", "-q", "master");
    commit(seed, "main.txt", "a\n", "main");
    git(seed, "merge", "--no-commit", "--no-ff", "side");
    git(seed, "checkout", "-q", "--", "base.txt", "side.txt", "main.txt"); // keep resolution minimal
    writeFileSync(join(seed, "secret.txt"), `TOKEN=${SECRET}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "leaky merge resolution");
    const head = git(seed, "rev-parse", "HEAD");
    const merge = git(seed, "rev-parse", head);
    const base0 = git(seed, "rev-parse", `${merge}^1`);
    // The merge's per-parent diffs DO reveal the secret (which is why a
    // per-parent scan closes the hole) while a `--no-merges` walk never
    // visits the merge, so the old per-commit scan read clean:
    expect(git(seed, "rev-list", "--no-merges", `${base0}..${head}`)).not.toContain(merge);
    const perParent = git(seed, "diff", "--text", "--unified=0", `${merge}^1`, merge);
    expect(perParent).toContain(SECRET);
    // ...but the fixed helper counts it:
    await expect(secretsInCommits(seed, base0, head)).rejects.toThrow(/credential-shaped/);
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

  it("secretsInCommits passes a clean history WITH merges through unchanged", async () => {
    const seed = join(dir, "cm");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "f.txt", "one\n", "c1");
    git(seed, "checkout", "-q", "-b", "side");
    commit(seed, "side.txt", "b\n", "side");
    git(seed, "checkout", "-q", "master");
    commit(seed, "main.txt", "a\n", "main");
    git(seed, "merge", "-q", "--no-edit", "side");
    const head = git(seed, "rev-parse", "HEAD");
    const root = git(seed, "rev-list", "--max-parents=0", "HEAD");
    await expect(secretsInCommits(seed, root, head)).resolves.toBeUndefined();
  });

  it("git failures are fatal (fail closed), not swallowed", async () => {
    const seed = join(dir, "x");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "f.txt", "one\n", "c1");
    // A bogus range must THROW (the old code returned "" on rev-list failure).
    await expect(secretsInCommits(seed, "does-not-exist", "HEAD")).rejects.toThrow();
  });
});