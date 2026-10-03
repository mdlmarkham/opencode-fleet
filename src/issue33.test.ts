import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFromNode } from "./provision.js";
import { B64_MARKER, parseBundleOutput } from "./outputs.js";
import {
  countSecretLines, evaluateChange, globToRegex, isSafeBranchName, resolveDestination, resolvePolicy, sensitivePaths,
} from "./syncpolicy.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

describe("issue #33: pure policy", () => {
  const pol = resolvePolicy();
  it("redirects protected destinations to fleet/<worker branch or label>", () => {
    expect(resolveDestination("main", "feature/x", "sync-1", pol)).toEqual({ branch: "fleet/feature/x", redirectedFrom: "main" });
    expect(resolveDestination("main", "main", "sync-9", pol)).toEqual({ branch: "fleet/sync-9", redirectedFrom: "main" });
    expect(resolveDestination("master", "master", "sync-9", pol).branch).toBe("fleet/sync-9");
  });
  it("leaves unprotected destinations and explicitly allowed ones alone", () => {
    expect(resolveDestination("feature/x", "feature/x", "l", pol)).toEqual({ branch: "feature/x" });
    expect(resolveDestination("main", "main", "l", resolvePolicy({ allowDirectPush: ["main"] }))).toEqual({ branch: "main" });
  });
  it("custom protected list is honored (and main is then unprotected)", () => {
    const p = resolvePolicy({ protectedBranches: ["release"] });
    expect(resolveDestination("release", "release", "l", p).redirectedFrom).toBe("release");
    expect(resolveDestination("main", "main", "l", p).redirectedFrom).toBeUndefined();
  });
  it("issue #68: a worker branch already under fleet/ is not re-prefixed", () => {
    expect(resolveDestination("main", "fleet/verify-gate", "sync-1", pol)).toEqual({ branch: "fleet/verify-gate", redirectedFrom: "main" });
    expect(resolveDestination("main", "fleet/feature/x", "sync-1", pol).branch).toBe("fleet/feature/x");
    // and it never grows a second prefix on the sync branch either
    expect(resolveDestination("master", "fleet/48-harness-cleanup", "sync-9", pol).branch).toBe("fleet/48-harness-cleanup");
  });
  it("issue #68: a protected fleet/ worker branch falls back under fleet/sync/ without a double prefix", () => {
    const p2 = { ...pol, protectedBranches: [...pol.protectedBranches, "fleet/x"] };
    const d = resolveDestination("main", "fleet/x", "sync-1", p2);
    expect(d.branch).not.toMatch(/fleet\/fleet\//);
  });
  it("redirected names are always safe branch names", () => {
    for (const w of ["a b", "x..y", "-rf", "feat/.hidden", "weird\u0001name", "a.lock"]) {
      expect(isSafeBranchName(resolveDestination("main", w, "sync-1", pol).branch), w).toBe(true);
    }
  });
  it("rejects option-looking and malformed branch names", () => {
    for (const b of ["-x", "--upload-pack=evil", "a..b", "a//b", "a/", "x.lock", ".hid", "a b", "", "a@{1}"]) {
      expect(isSafeBranchName(b), b).toBe(false);
    }
    for (const b of ["main", "feature/x-1", "fleet/sync-123", "v1.2.3"]) expect(isSafeBranchName(b), b).toBe(true);
  });
  it("flags CI/CODEOWNERS paths", () => {
    expect(sensitivePaths([".github/workflows/ci.yml", "src/a.ts", "CODEOWNERS", ".circleci/config.yml", "docs/workflows/x"])).toEqual([
      ".github/workflows/ci.yml", "CODEOWNERS", ".circleci/config.yml",
    ]);
  });
  it("secret scan looks at added lines only and never echoes the secret", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "+const ok = 1;"].join("\n");
    expect(countSecretLines(diff)).toBe(0);
    expect(countSecretLines(diff + "\n+key = ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(1);
    const r = evaluateChange(["f"], "@@ -0,0 +1 @@\n+x = ghp_abcdefghijklmnopqrstuvwxyz0123456789", pol);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("ghp_abcdef");
  });
  it("allowSensitivePaths opens CI paths only", () => {
    expect(evaluateChange([".github/workflows/a.yml"], "", resolvePolicy({ allowSensitivePaths: true })).ok).toBe(true);
    expect(evaluateChange([".github/workflows/a.yml"], "", pol).ok).toBe(false);
  });
});

/** Real-git harness: bare origin, a worker clone with commits, and a base64 bundle. */
function harness(opts: { workerBranch?: string; files: Record<string, string> }) {
  const base = mkdtempSync(join(tmpdir(), "fleet33-"));
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
  for (const [f, c] of Object.entries(opts.files)) {
    mkdirSync(join(worker, f, ".."), { recursive: true });
    writeFileSync(join(worker, f), c);
  }
  git(worker, "add", "-A");
  git(worker, "commit", "-q", "-m", "work");
  const bundle = join(base, "w.bundle");
  git(worker, "bundle", "create", bundle, "--all");
  const b64 = readFileSync(bundle).toString("base64");
  const originRef = (b: string) => { try { return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`); } catch { return ""; } };
  const run = (policy?: Parameters<typeof syncFromNode>[6], pinned?: string) =>
    syncFromNode("local", worker, origin, "main", { mode: "from-base64", base64: b64, branch: "main", workerBranch: opts.workerBranch ?? "main", destBranch: pinned }, pinned, policy);
  return { base, origin, worker, originRef, run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("issue #33: end-to-end against real git repos", () => {
  it("work on main is redirected to fleet/<label>; origin/main is untouched", async () => {
    const h = harness({ files: { "a.txt": "x\n" } });
    try {
      const before = h.originRef("main");
      const r = await h.run();
      expect(r.ok).toBe(true);
      expect(r.synced).toBe(true);
      expect(r.redirectedFrom).toBe("main");
      expect(r.branch).toMatch(/^fleet\/sync-/);
      expect(h.originRef("main")).toBe(before);
      expect(h.originRef(r.branch!)).not.toBe("");
    } finally { h.cleanup(); }
  });
  it("allowDirectPush lets main advance", async () => {
    const h = harness({ files: { "a.txt": "x\n" } });
    try {
      const before = h.originRef("main");
      const r = await h.run({ allowDirectPush: ["main"] });
      expect(r.ok && r.synced).toBe(true);
      expect(r.redirectedFrom).toBeUndefined();
      expect(h.originRef("main")).not.toBe(before);
    } finally { h.cleanup(); }
  });
  it("a feature branch is published as itself, no redirect", async () => {
    const h = harness({ workerBranch: "feature/x", files: { "a.txt": "x\n" } });
    try {
      const r = await h.run();
      expect(r.synced).toBe(true);
      expect(r.branch).toBe("feature/x");
      expect(r.redirectedFrom).toBeUndefined();
      expect(h.originRef("feature/x")).not.toBe("");
    } finally { h.cleanup(); }
  });
  it("workflow changes are refused and nothing is pushed", async () => {
    const h = harness({ workerBranch: "feature/ci", files: { ".github/workflows/ci.yml": "on: push\n" } });
    try {
      const r = await h.run();
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(h.originRef("feature/ci")).toBe("");
      const allowed = await h.run({ allowSensitivePaths: true });
      expect(allowed.synced).toBe(true);
    } finally { h.cleanup(); }
  });
  it("credential-shaped additions are refused", async () => {
    const h = harness({ workerBranch: "feature/s", files: { "cfg.env": "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" } });
    try {
      const r = await h.run();
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(JSON.stringify(r)).not.toContain("ghp_abcdef");
      expect(h.originRef("feature/s")).toBe("");
    } finally { h.cleanup(); }
  });
  it("an unsafe destination name is refused before any git runs", async () => {
    const h = harness({ files: { "a.txt": "x\n" } });
    try {
      const r = await h.run(undefined, "--upload-pack=evil");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/unsafe/);
    } finally { h.cleanup(); }
  });
});

describe("issue #33: review follow-ups", () => {
  it("the redirect target is never itself a protected branch", () => {
    const pol = resolvePolicy({ protectedBranches: ["main", "fleet/feature/x"] });
    const d = resolveDestination("main", "feature/x", "sync-1", pol);
    expect(d.redirectedFrom).toBe("main");
    expect(pol.protectedBranches.includes(d.branch)).toBe(false);
    expect(isSafeBranchName(d.branch)).toBe(true);
    // an explicitly allowed fleet/* name is fine to use
    const allowed = resolvePolicy({ protectedBranches: ["main", "fleet/feature/x"], allowDirectPush: ["fleet/feature/x"] });
    expect(resolveDestination("main", "feature/x", "sync-1", allowed).branch).toBe("fleet/feature/x");
  });
  it("an added line starting with '++' is scanned (it is not a '+++' file header)", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1 @@", "+++ghp_abcdefghijklmnopqrstuvwxyz0123456789"].join("\n");
    expect(countSecretLines(diff)).toBe(1);
  });
  it("a PEM private key is caught line by line (header alone is enough)", () => {
    const diff = ["diff --git a/k b/k", "@@ -0,0 +3 @@", "+-----BEGIN RSA PRIVATE KEY-----", "+MIIBOgIBAAJBAK", "+-----END RSA PRIVATE KEY-----"].join("\n");
    expect(countSecretLines(diff)).toBeGreaterThanOrEqual(1);
  });
  it("file headers and removed lines never count", () => {
    const diff = ["diff --git a/f b/f", "--- a/ghp_abcdefghijklmnopqrstuvwxyz0123456789", "+++ b/f", "@@ -1 +1 @@", "-ghp_abcdefghijklmnopqrstuvwxyz0123456789", "+ok"].join("\n");
    expect(countSecretLines(diff)).toBe(0);
  });
  it("operator-configured sensitive globs extend the built-ins", () => {
    const pol = resolvePolicy({ sensitivePaths: ["ci/**", "deploy/*.sh", "Makefile"] });
    const files = ["ci/a/b.yml", "deploy/x.sh", "deploy/sub/x.sh", "Makefile", "src/a.ts", ".github/workflows/w.yml"];
    expect(sensitivePaths(files, pol.sensitivePaths)).toEqual(["ci/a/b.yml", "deploy/x.sh", "Makefile", ".github/workflows/w.yml"]);
    expect(evaluateChange(["ci/a.yml"], "", pol).ok).toBe(false);
    expect(globToRegex("a.b").test("aXb")).toBe(false);
  });
});

describe("issue #33: binary files do not hide secrets (real git)", () => {
  it("a token inside a file git treats as binary is still caught", async () => {
    const h = harness({ workerBranch: "feature/bin", files: { "blob.dat": "ghp_abcdefghijklmnopqrstuvwxyz0123456789\u0000\u0001binary" } });
    try {
      const r = await h.run();
      expect(r.ok).toBe(false);
      expect(r.commit).toBe("policy-refused");
      expect(h.originRef("feature/bin")).toBe("");
    } finally { h.cleanup(); }
  });
});

describe("issue #33: channel path publishes the worker's own branch", () => {
  it("__BUNDLE__ output -> workerBranch -> feature branch is pushed (not 'no changes' on main)", async () => {
    const h = harness({ workerBranch: "feature/chan", files: { "a.txt": "x\n" } });
    try {
      const out = execFileSync("bash", ["-c",
        `git bundle create ${JSON.stringify(join(h.base, "c.bundle"))} --all 2>/dev/null && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD && echo "${B64_MARKER}" && base64 ${JSON.stringify(join(h.base, "c.bundle"))}`],
        { cwd: h.worker, encoding: "utf8" });
      const parsed = parseBundleOutput(out);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.branch).toBe("feature/chan");
      const r = await syncFromNode("local", h.worker, h.origin, "main",
        { mode: "from-base64", base64: parsed.base64, branch: "main", workerBranch: parsed.branch, destBranch: undefined }, undefined);
      expect(r.synced).toBe(true);
      expect(r.branch).toBe("feature/chan");
      expect(h.originRef("feature/chan")).not.toBe("");
    } finally { h.cleanup(); }
  });
});
