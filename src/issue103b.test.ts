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
  // Every test in this file drives several REAL git invocations and full sync
  // flows; when the suite runs in parallel the OS-level git spawns slow down,
  // so the runner's 5s default flakily kills these tests. Give each test a
  // generous explicit timeout (the assertions themselves are unchanged).
  const T = 30_000;
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
  }, T);

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
  }, T);

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
  }, T);

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
      // The merge tip IS feature/merge's tip, and it has 2 parents — the range
      // main..feature/merge ends at the merge commit.
      expect(git(worker, "rev-list", "--parents", "--max-count=1", merge).split(" ").length - 1).toBe(2);
      expect(git(worker, "rev-parse", "feature/merge").trim()).toBe(merge);
      // The bypass shape: the secret is introduced ONLY by the merge commit's
      // resolution — no linear commit carries it, so a scan that walks only
      // non-merge commits (`--no-merges`) never visits the sole offender.
      expect(git(worker, "rev-list", "--no-merges", `main..${merge}`)).not.toContain(merge);
      // And the merge's per-parent diffs DO reveal the added secret (the
      // resolution adds it against each parent), which is why per-parent
      // scanning closes the hole.
      for (const p of [1, 2]) {
        const perParent = execFileSync("git", ["-C", worker, "diff", "--text", "--no-textconv", "--no-ext-diff", "--unified=0", `${merge}^${p}`, merge], { stdio: "pipe" }).toString();
        expect(perParent).toContain(`+TOKEN=${SECRET}`);
      }
      // Reroute syncFromNode through the merge branch: the harness's run()
      // seeds the bundle from its opts.workerBranch, and syncFromNode scans
      // origin/<clone-base>...refs/remotes/bundler/<workerBranch> — so the
      // range must END at the merge commit for the scan to visit it.
      git(worker, "bundle", "create", join(h.base, "w.bundle"), "--all");
      const b64 = readFileSync(join(h.base, "w.bundle")).toString("base64");
      const r = await syncFromNode("local", worker, h.origin, "main", { mode: "from-base64", base64: b64, branch: "main", workerBranch: "feature/merge", destBranch: undefined }, undefined);
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(r.synced).toBe(false);
      expect(h.originRef("feature/merge")).toBe("");
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally { h.cleanup(); }
  }, T);

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
  }, T);

  it("NEW root-commit end-to-end: bundle whose range root carries a secret is refused", async () => {
    // syncFromNode's 4th argument is the CLONE base (a branch that must exist
    // on origin), so an EMPTY TREE cannot be handed to it directly. To keep a
    // genuine e2e refusal WHILE making the range's parentless root real, give
    // the orphan history a main-descended ANCHOR commit and merge the orphan
    // chain into the synced branch: the range origin/main..feature/orphan-root
    // then contains a commit with no parents at all (the old `commit^!` scan
    // diffs nothing for it), while the TIP tree stays clean (the secret is
    // added at the orphan root and removed before the tip).
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
    // Anchor on an ordinary main-descended branch, then graft a PARENTLESS
    // history onto it. The orphan chain's FIRST commit has no parent — the
    // range root.
    git(worker, "checkout", "-q", "-b", "feature/orphan-root");
    commit(worker, "a.txt", "a\n", "anchor");
    git(worker, "checkout", "-q", "--orphan", "chain");
    git(worker, "rm", "-q", "-rf", "--", ".");
    commit(worker, "cfg.env", `TOKEN=${SECRET}\n`, "orphan root carries a secret");
    commit(worker, "cfg.env", "TOKEN=ok\n", "clean it up");
    git(worker, "checkout", "-q", "feature/orphan-root");
    git(worker, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "chain");
    const head = git(worker, "rev-parse", "HEAD");
    const bundle = join(base, "w.bundle");
    git(worker, "bundle", "create", bundle, "--all");
    const b64 = readFileSync(bundle).toString("base64");
    const originRef = (b: string) => { try { return git(originGit, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; } };
    try {
      // Premise: the scanned range origin/main..head contains a PARENTLESS
      // commit (a real range root — `commit^!` diffs nothing against it),
      // and the tip's tree reads clean, so ONLY the per-commit scan can
      // catch the root's secret here.
      const rows = git(worker, "rev-list", "--parents", `origin/main..${head}`).split("\n").filter((l) => l.trim());
      expect(rows.filter((r) => r.split(" ").length === 1).length).toBe(1);
      const tipClean = execFileSync("git", ["-C", worker, "diff", "--text", "--no-textconv", "--no-ext-diff", "--unified=0", "origin/main...HEAD"], { stdio: "pipe" }).toString();
      expect(tipClean).not.toContain(SECRET);
      const r = await syncFromNode("local", worker, originGit, "main", { mode: "from-base64", base64: b64, branch: "main", workerBranch: "feature/orphan-root", destBranch: undefined }, undefined);
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(r.synced).toBe(false);
      expect(originRef("feature/orphan-root")).toBe("");
      expect(JSON.stringify(r)).not.toContain(SECRET);
      // The 4th-argument route for a parentless range (an ORPHAN worker branch:
      // syncFromNode would fail at `git clone --branch <branch>` before any
      // scan) is covered by the helper directly: with the EMPTY TREE as the
      // scanned base the parentless root IS inside base..tip and rejects.
      await expect(secretsInCommits(worker, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head)).rejects.toThrow(/credential-shaped/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, T);

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
  }, T);

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
  }, T);

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
  }, T);

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
  }, T);

  it("git failures are fatal (fail closed), not swallowed", async () => {
    const seed = join(dir, "x");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    commit(seed, "f.txt", "one\n", "c1");
    // A bogus range must THROW (the old code returned "" on rev-list failure).
    await expect(secretsInCommits(seed, "does-not-exist", "HEAD")).rejects.toThrow();
  }, T);
});
describe("issue #103b follow-up: a merge is judged by its own resolution", () => {
  it("merging a base that already contains a fixture token passes; a token only in the resolution is still refused", async () => {
    const base = mkdtempSync(join(tmpdir(), "fleet103m-"));
    try {
      const repo = join(base, "r");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      commit(repo, "a.txt", "a\n", "init");
      git(repo, "checkout", "-q", "-b", "worker");
      commit(repo, "w.txt", "w\n", "worker work");
      git(repo, "checkout", "-q", "main");
      commit(repo, "fixture.txt", `TOKEN=${SECRET}\n`, "main gains a fixture token");
      const baseTip = git(repo, "rev-parse", "main");
      git(repo, "checkout", "-q", "worker");
      git(repo, "merge", "-q", "--no-edit", "main");
      await expect(secretsInCommits(repo, baseTip, "worker")).resolves.toBeUndefined();
      // A resolution that adds a NEW token is still caught: it is new against both parents.
      git(repo, "checkout", "-q", "-b", "worker2", "worker~1");
      commit(repo, "w2.txt", "w2\n", "more work");
      git(repo, "merge", "--no-commit", "--no-ff", "main");
      writeFileSync(join(repo, "new.txt"), "TOKEN=ghp_zyxwvutsrqponmlkjihgfedcba9876543210\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "merge with new secret");
      await expect(secretsInCommits(repo, baseTip, "worker2")).rejects.toThrow(/credential-shaped/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
