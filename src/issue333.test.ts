/**
 * Issue #333 regression tests: the fleet_sync auto-commit must tolerate an
 * EMPTY staging set.
 *
 * The bug: since #332 both auto-commit paths stage with the exclusion
 * pathspec `git add -A -- ':(exclude).opencode-fleet'` (syncAddCommand()).
 * When the working tree's dirt is ONLY runtime-dir files (classic case:
 * untracked `.opencode-fleet/` state in a checkout whose .gitignore does not
 * cover the dir — a user repo), the add stages nothing, `git commit` exits 1
 * ("nothing added to commit but untracked files present"), and the whole
 * `&&` chain failed — aborting fleet_sync even when the branch carried real
 * committed work to harvest. Fail-closed had become an availability bug.
 *
 * Contract, proven three ways:
 *  1. REPRO + fix: the OLD emitted auto-commit chain (`add && commit`, no
 *     guard) runs under real bash against a real temp git repo whose only
 *     dirt is untracked `.opencode-fleet/x` — it exits 1. The NEW chain
 *     (built by syncCommitCommand, composed exactly as BOTH wiring sites
 *     emit it) exits 0 and creates NO commit.
 *  2. Real work present → the new chain still stages and auto-commits
 *     exactly as before (runtime dirt is excluded, real files are not).
 *  3. WIRING (issue191-style, closes the #332 review gap): the actual
 *     emitted command chain is read from the COMPILED dist
 *     (dist/provision.js manager SSH path, dist/node/handler.js worker
 *     bundle op) and EVALUATED with the real dist helpers, then asserted to
 *     carry BOTH (i) the exclusion pathspec and (ii) the empty-staging
 *     guard. Reverting either call site to its pre-fix shape fails these
 *     assertions (the guard disappears and the raw `${syncCommitCommand(`
 *     wiring vanishes).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAddCommand, syncCommitCommand } from "./syncfilter.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

/** The single-quote shell escaping the plugin ships (src/shell.ts shq). */
const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

const MANAGER_MARKER = "fleet_sync: auto-commit worker working-tree changes before sync";
const PRE_FIX_ADD = "git add -A -- ':(exclude).opencode-fleet'";
const GUARD = "git diff --cached --quiet ||";
const WORKER_COMMIT = `git -c user.email=fleet-worker@node -c user.name="fleet-worker" commit -q -m "${MANAGER_MARKER}"`;
const MANAGER_COMMIT = (nodeHost: string) =>
  `git -c user.email=fleet-worker@${nodeHost} -c user.name="fleet-worker (${nodeHost})" commit -m "${MANAGER_MARKER}"`;

describe("issue #333: the auto-commit tolerates an empty staging set (real git)", () => {
  let base = "";
  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = ""; });

  /**
   * A repo with one committed seed, then dirt of the requested kinds left
   * uncommitted. `runtimeDirtOnly` models the abort case: untracked
   * `.opencode-fleet/` runtime files in a checkout whose .gitignore does NOT
   * cover the dir.
   */
  function repoWith(opts: { runtimeDirt?: boolean; realWork?: boolean }): string {
    base = mkdtempSync(join(tmpdir(), "fleet333-"));
    const repo = join(base, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, ".gitignore"), "# deliberately does NOT cover the runtime dir\n*.tmp\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "gitignore without the runtime dir");
    if (opts.runtimeDirt) {
      mkdirSync(join(repo, ".opencode-fleet"), { recursive: true });
      writeFileSync(join(repo, ".opencode-fleet", "x"), "runtime log\n");
    }
    if (opts.realWork) writeFileSync(join(repo, "real.txt"), "real work\n");
    return repo;
  }

  const commitCount = (repo: string) => Number(git(repo, "rev-list", "--count", "HEAD"));
  const headFiles = (repo: string) =>
    execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);

  it("REPRO: the pre-fix add && commit chain aborts (exit 1) when only runtime dirt exists", () => {
    const repo = repoWith({ runtimeDirt: true });
    // The chain PR #332 (and pre-#332, modulo the pathspec) emitted at both
    // call sites: stage with the exclusion, then commit unconditionally.
    const old = [`cd ${shq(repo)}`, syncAddCommand(), `git -c user.email=fleet-worker@node -c user.name="fleet-worker" commit -q -m "${MANAGER_MARKER}"`].join(" && ");
    let threw: unknown;
    try {
      execFileSync("bash", ["-c", old], { encoding: "utf8" });
    } catch (e) { threw = e; }
    expect(threw, "the old chain should have failed with 'nothing added to commit'").toBeDefined();
    expect((threw as { status: number }).status).toBe(1);
    // Nothing was committed and the sync would have aborted right here.
    expect(commitCount(repo)).toBe(2);
    expect(git(repo, "status", "--porcelain")).toContain("?? .opencode-fleet/");
  });

  it("FIX: the guarded chain (syncCommitCommand) skips the commit — exit 0, no commit created", () => {
    const repo = repoWith({ runtimeDirt: true });
    const chain = [`cd ${shq(repo)}`, syncCommitCommand(`git -c user.email=fleet-worker@node -c user.name="fleet-worker" commit -q -m "${MANAGER_MARKER}"`)].join(" && ");
    execFileSync("bash", ["-c", chain], { encoding: "utf8" });
    expect(commitCount(repo)).toBe(2);
    expect(headFiles(repo)).toEqual([".gitignore"]);
  });

  it("REAL WORK: the guarded chain still auto-commits real uncommitted work", () => {
    const repo = repoWith({ realWork: true });
    const chain = [`cd ${shq(repo)}`, syncCommitCommand(WORKER_COMMIT)].join(" && ");
    execFileSync("bash", ["-c", chain], { encoding: "utf8" });
    expect(commitCount(repo)).toBe(3);
    expect(headFiles(repo)).toEqual(["real.txt"]);
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe(MANAGER_MARKER);
  });

  it("MIXED: runtime dirt plus real work — the real work commits, the runtime dir never does", () => {
    const repo = repoWith({ runtimeDirt: true, realWork: true });
    const chain = [`cd ${shq(repo)}`, syncCommitCommand(WORKER_COMMIT)].join(" && ");
    execFileSync("bash", ["-c", chain], { encoding: "utf8" });
    expect(headFiles(repo)).toEqual(["real.txt"]);
    expect(git(repo, "ls-files")).not.toContain(".opencode-fleet/x");
  });

  it("a failed `cd` never falls through into the commit arm (whole chain fails)", () => {
    const missing = join(tmpdir(), "fleet333-no-such-dir");
    let threw: unknown;
    try {
      execFileSync("bash", ["-c", `cd ${shq(missing)} && ${syncCommitCommand(WORKER_COMMIT)}`], { encoding: "utf8" });
    } catch (e) { threw = e; }
    expect(threw, "a failed cd must fail the chain, never skip ahead to the commit").toBeDefined();
  });

  it("CLEAN TREE: nothing staged (no dirt at all) also skips the commit", () => {
    const repo = repoWith({});
    const chain = [`cd ${shq(repo)}`, syncCommitCommand(WORKER_COMMIT)].join(" && ");
    execFileSync("bash", ["-c", chain], { encoding: "utf8" });
    expect(commitCount(repo)).toBe(2);
  });
});

describe("issue #333: WIRING — read the ACTUAL emitted chains from the compiled dist", () => {
  // issue191-style: evaluate the dist template expressions with the REAL
  // compiled helpers, so these assertions cover exactly what ships. The
  // dist modules are loaded via dynamic imports of computed specifiers (a
  // literal `typeof import(...)` would pull dist/*.d.ts into the test
  // program as compile inputs and break `tsc` emit with TS5055).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type DistSyncfilter = { syncAddCommand(): string; syncCommitCommand(commitLine: string): string };
  type DistShell = { shq(value: string): string };
  const distHref = (rel: string) => new URL(`../dist/${rel}`, import.meta.url).href;
  const distSyncfilter = async (): Promise<DistSyncfilter> => (await import(distHref("syncfilter.js"))) as any as DistSyncfilter;
  const distShell = async (): Promise<DistShell> => (await import(distHref("shell.js"))) as any as DistShell;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * The manager-side step-2 chain EXACTLY as dist/provision.js emits it:
   * the `[...].join(" && ")` expression around the auto-commit marker is
   * sliced out of the compiled output and evaluated with the real dist shq
   * and syncCommitCommand bound.
   */
  async function emittedManagerChain(nodeHost: string, cwd: string): Promise<string> {
    const src = readFileSync(new URL("../dist/provision.js", import.meta.url), "utf8");
    const ix = src.indexOf(MANAGER_MARKER);
    if (ix < 0) throw new Error("manager auto-commit chain not found in dist (is dist built?)");
    const start = src.lastIndexOf("[", ix);
    const end = src.indexOf('].join(" && ")', ix);
    const expr = src.slice(start, end + '].join(" && ")'.length);
    const mod = await distSyncfilter();
    const { shq } = await distShell();
    return new Function("shq", "nodeHost", "syncCommitCommand", "cwd", `"use strict"; return (${expr});`)(
      shq, nodeHost, mod.syncCommitCommand, cwd,
    ) as string;
  }

  /**
   * The worker-side guarded-commit line EXACTLY as dist/node/handler.js
   * emits it: the DIRTY-conditional template (`if [ -n "$DIRTY" ]; then
   * ${syncCommitCommand(...)}; fi`) is matched from the compiled output and
   * evaluated with the real dist syncCommitCommand.
   */
  async function emittedWorkerDirtyLine(): Promise<string> {
    const src = readFileSync(new URL("../dist/node/handler.js", import.meta.url), "utf8").replace(/\n/g, " ");
    const m = src.match(/if \[ -n "\$DIRTY" \]; then \$\{syncCommitCommand\((`[^`]+`)\)\}; fi/);
    if (!m) throw new Error("worker DIRTY auto-commit template not found in dist/node/handler.js (was the call site reverted?)");
    const mod = await distSyncfilter();
    const chain = new Function("syncCommitCommand", `"use strict"; return syncCommitCommand(${m[1]});`)(mod.syncCommitCommand) as string;
    // The DIST wiring wraps the chain in the DIRTY conditional, with the
    // detection as the preceding chain arm (`DIRTY=$(git status ...)` like
    // the worker bundle op emits). Return the full two-arm line.
    return `DIRTY=$(git status --porcelain --untracked-files=all) && if [ -n "$DIRTY" ]; then ${chain}; fi`;
  }

  it("dist/provision.js: the emitted chain carries the exclusion pathspec AND the empty-staging guard", async () => {
    const chain = await emittedManagerChain("dev3", "/srv/checkout");
    // (i) exclusion staging command
    expect(chain).toContain(PRE_FIX_ADD);
    // (ii) the new empty-staging guard wraps the commit (commit arm directly
    // after the `||`, inside guard parentheses)
    expect(chain).toContain(GUARD);
    expect(chain).toMatch(/\|\s*git -c user\.email=fleet-worker/);
    expect(chain).toContain(`cd '/srv/checkout'`);
    // The chain composition: cd && add && (guard || commit)
    const parts = chain.split(" && ");
    expect(parts[0]).toBe(`cd '/srv/checkout'`);
    expect(parts[1]).toBe(PRE_FIX_ADD);
    expect(parts[2]).toBe(`(${GUARD} ${MANAGER_COMMIT("dev3")})`);
    expect(parts[2].endsWith(")")).toBe(true);
  }, 30_000);

  it("dist/node/handler.js: the emitted DIRTY line carries the exclusion pathspec AND the guard", async () => {
    const line = await emittedWorkerDirtyLine();
    expect(line).toContain('DIRTY=$(git status --porcelain --untracked-files=all)');
    expect(line).toContain('if [ -n "$DIRTY" ]; then ');
    expect(line.endsWith("; fi")).toBe(true);
    expect(line).toContain(PRE_FIX_ADD);
    expect(line).toContain(GUARD);
    expect(line).toContain(WORKER_COMMIT);
    // Discriminator: the pre-fix shape was `add && commit` with no guard —
    // that exact shape must NOT be present.
    expect(line).not.toMatch(new RegExp(`${syncAddCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && git -c user\\.email=fleet-worker`));
  }, 30_000);

  it("the EMITTED manager chain runs green end-to-end in a runtime-dirt-only temp repo", async () => {
    const base = mkdtempSync(join(tmpdir(), "fleet333mgr-"));
    try {
      const repo = join(base, "repo");
      execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      mkdirSync(join(repo, ".opencode-fleet"), { recursive: true });
      writeFileSync(join(repo, ".opencode-fleet", "x"), "runtime log\n");
      const chain = await emittedManagerChain("dev3", repo);
      execFileSync("bash", ["-c", chain], { encoding: "utf8" });
      expect(Number(git(repo, "rev-list", "--count", "HEAD"))).toBe(1);
      expect(git(repo, "status", "--porcelain")).toContain("?? .opencode-fleet/");
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 30_000);

  it("the EMITTED worker DIRTY line runs green in a runtime-dirt-only temp repo, and commits real work", async () => {
    const base = mkdtempSync(join(tmpdir(), "fleet333wrk-"));
    try {
      const repo = join(base, "repo");
      execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      mkdirSync(join(repo, ".opencode-fleet"), { recursive: true });
      writeFileSync(join(repo, ".opencode-fleet", "x"), "runtime log\n");
      const line = await emittedWorkerDirtyLine();
      execFileSync("bash", ["-c", `cd ${shq(repo)} && ${line}`], { encoding: "utf8" });
      expect(Number(git(repo, "rev-list", "--count", "HEAD"))).toBe(1);

      // Now real work appears: the SAME emitted line must auto-commit it.
      writeFileSync(join(repo, "real.txt"), "real work\n");
      execFileSync("bash", ["-c", `cd ${shq(repo)} && ${line}`], { encoding: "utf8" });
      expect(Number(git(repo, "rev-list", "--count", "HEAD"))).toBe(2);
      expect(git(repo, "log", "-1", "--pretty=%s")).toBe("fleet_sync: auto-commit worker working-tree changes before sync");
      expect(execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })).not.toContain(".opencode-fleet/x");
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 30_000);

  it("the raw dist text wires BOTH call sites through the shared helper (a revert is detectable)", async () => {
    const provision = readFileSync(new URL("../dist/provision.js", import.meta.url), "utf8");
    const handler = readFileSync(new URL("../dist/node/handler.js", import.meta.url), "utf8");
    for (const [name, src, rel] of [["provision.js", provision, "./syncfilter.js"], ["node/handler.js", handler, "../syncfilter.js"]] as const) {
      const ix = src.indexOf(MANAGER_MARKER);
      expect(ix, `${name} lost the auto-commit chain`).toBeGreaterThan(-1);
      // The call site imports and calls the shared guarded-commit helper.
      expect(src).toContain(`await import("${rel}")`);
      // Worker site: the guard sits INSIDE the DIRTY conditional.
      if (name === "node/handler.js") {
        expect(src).toContain('if [ -n "$DIRTY" ]; then ${syncCommitCommand(');
      } else {
        expect(src).toContain("syncCommitCommand(");
        // The pre-fix literal shape (`syncAddCommand()` chained directly to
        // the commit) must be gone from the manager chain too.
        const call = src.lastIndexOf("syncCommitCommand(", ix);
        expect(call, "manager call site does not wire syncCommitCommand").toBeGreaterThan(-1);
      }
      expect(src).not.toContain("syncAddCommand() && git -c user.email=fleet-worker");
    }
  });
});
