/**
 * Issue #275: a run into a SHARED, non-isolated checkout must not start on top
 * of another run's uncommitted work.
 *
 * The bug (observed 2026-10-06, the #271/#255 tangle): a dispatch into
 * `/home/svcuser/fleet/opencode-fleet` — a reused checkout that already held a
 * previous run's uncommitted edits — built on that stale working tree, so its
 * diff contained BOTH workstreams and its scope gate fired only AFTER the run.
 * The `ref` path already refused a dirty source (`src/node/handler.ts`); the
 * ordinary (non-ref, non-clone) path did not.
 *
 * Contract:
 *   1. a non-isolated dispatch into a git work tree with uncommitted changes is
 *      REFUSED before the run, naming a sample of the dirty paths;
 *   2. the same dispatch with `isolation: "clone"` proceeds (the clone is taken
 *      from committed state; the dirty source is reported, not blocked);
 *   3. a clean checkout dispatches exactly as before (no change in behaviour);
 *   4. a non-git cwd is not refused (the guard only fires on a dirty work tree).
 *
 * Every behavioral test drives REAL git against throwaway repos under the OS
 * temp dir (mkdtemp) — never inside this repo checkout.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOpencodeRun } from "./node/handler.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();

describe("#275: a non-isolated dispatch into a dirty checkout is refused", () => {
  let dir: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet275-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    // A stand-in engine that succeeds and touches nothing — the guard must fire
    // (or not) BEFORE this ever runs.
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, "#!/bin/bash\necho ok\n");
    chmodSync(bin, 0o755);
    process.env.FLEET_STATE_DIR = join(dir, "state");
    process.env.FLEET_ALLOWED_ROOTS = join(dir, "work");
    process.env.PATH = `${join(dir, "bin")}:${prev.path}`;
  });
  afterEach(() => {
    process.env.PATH = prev.path;
    for (const [k, v] of [["FLEET_STATE_DIR", prev.state], ["FLEET_ALLOWED_ROOTS", prev.roots]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));
  const start = (repo: string, runId: string, extra: Record<string, unknown> = {}) =>
    call({ prompt: "__RUN_START__", op: "run.start", cwd: repo, transport: "http", runId, realPrompt: "do it", timeoutMs: 60_000, ...extra });

  /** A committed git work tree with one tracked file. */
  function makeRepo(): string {
    const repo = join(dir, "work", "proj");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "src", "a.ts"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    return repo;
  }

  it("refuses a dirty checkout and names the changed paths — RED on master", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "src", "a.ts"), "edited, not committed");
    writeFileSync(join(repo, "src", "b.ts"), "untracked");
    const r = await start(repo, "run-dirty-none");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("uncommitted changes");
    // the refusal names at least one of the dirty paths, and the clone escape hatch
    expect(String(r.error)).toMatch(/src\/[ab]\.ts/);
    expect(String(r.error)).toContain("isolation");
  });

  it("does NOT refuse a clean checkout (unchanged behaviour)", async () => {
    const repo = makeRepo();
    const r = await start(repo, "run-clean-none");
    expect(r).toMatchObject({ ok: true, detached: true });
  });

  it("does NOT refuse a non-isolated dispatch when the source is only dirty with IGNORED files", async () => {
    // Ignored files are not "another run's work": they must not block dispatch.
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "out.txt"), "ignored artifact");
    const r = await start(repo, "run-ignored-none");
    expect(r).toMatchObject({ ok: true, detached: true });
  });

  it("a dirty source with isolation:clone still proceeds (the clone is from committed state)", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "src", "a.ts"), "edited, not committed");
    const r = await start(repo, "run-dirty-clone", { isolation: "clone" });
    expect(r).toMatchObject({ ok: true, isolation: "clone", sourceDirty: true });
  });

  it("does not refuse a non-git cwd (the guard only fires on a dirty work tree)", async () => {
    const plain = join(dir, "work", "notgit");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "notes.txt"), "scratch");
    const r = await start(plain, "run-nongit");
    expect(r).toMatchObject({ ok: true, detached: true });
  });
});
