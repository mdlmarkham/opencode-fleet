/**
 * Issue #271: a worker dispatched with isolation:"clone" may edit files but
 * leave them UNCOMMITTED — the clone's branch tip equals the start commit
 * (startHead == endHead in the audit manifest) while the working tree is dirty.
 * The manifest's filesChanged IS populated (the capture runs `git diff
 * <startHead>`, which sees the dirty tree), so the run used to be reported as
 * a plain success with filesChanged non-empty and the tip at base — a silent
 * data-loss shape (fleet_sync publishes the branch tip; with the tip at base
 * there is nothing to push).
 *
 * Fix: the run script's capture tail appends a raw `dirtyWorktree=1` line when
 * endHead == startHead AND the captured changes are non-empty; parseChanges
 * surfaces it as Changes.dirtyWorktree, buildManifest stamps `dirtyWorktree:
 * true` on the manifest, and the run record mirrors it. A run that committed
 * its work, or changed nothing, gets NO marker and byte-identical output to
 * before (additive, fail-safe).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildManifest, extractEvents, parseChanges } from "./audit.js";
import { changesCaptureLines, dirtyWorktreeSignal } from "./node/runtime.js";
import { handleOpencodeRun } from "./node/handler.js";
import { runPaths } from "./paths.js";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const events = extractEvents("", "opencode");

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
function makeRepo(dir: string): string {
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

/** Run the capture the way the run script does: emit the lines, execute them. */
function runCapture(cwd: string, startHead: string, changesPath: string): { raw: string; parsed: ReturnType<typeof parseChanges> } {
  const lines = changesCaptureLines(cwd, startHead, changesPath);
  expect(lines.length, "capture + guard lines must exist when the start commit is known").toBeGreaterThan(0);
  execFileSync("bash", ["-c", lines.filter((l) => !l.startsWith("#")).join("\n")]);
  const raw = existsSync(changesPath) ? readFileSync(changesPath, "utf8") : "";
  return { raw, parsed: parseChanges(raw) };
}

describe("#271: the emitted capture tail carries the explicit dirty-worktree marker", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet271-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a dirty tree with an unchanged HEAD yields dirtyWorktree:true — RED on master (marker absent)", () => {
    const repo = makeRepo(dir);
    const startHead = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "a.ts"), " edited, not committed");
    writeFileSync(join(repo, "src", "untracked.ts"), "untracked");
    const { raw, parsed } = runCapture(repo, startHead, join(dir, "dirty.changes"));
    expect(git(repo, "rev-parse", "HEAD")).toBe(startHead); // the tip did NOT move
    expect(parsed.files.length).toBeGreaterThan(0); // the capture DID see the changes
    expect(dirtyWorktreeSignal(raw)).toBe(true);
    expect(parsed.dirtyWorktree).toBe(true);
  });

  it("a committed change does NOT get the marker (byte-identical capture to today)", () => {
    const repo = makeRepo(dir);
    const startHead = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "a.ts"), "committed work");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work");
    const { raw, parsed } = runCapture(repo, startHead, join(dir, "committed.changes"));
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(startHead);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(raw).not.toContain("dirtyWorktree");
    expect(parsed.dirtyWorktree).toBeUndefined();
    // the legacy capture shape is untouched
    expect(raw.startsWith(`endHead=${git(repo, "rev-parse", "HEAD")}\n---status\n`)).toBe(true);
  });

  it("a run that changed Nothing does NOT get the marker (no uncommitted work to lose)", () => {
    const repo = makeRepo(dir);
    const startHead = git(repo, "rev-parse", "HEAD");
    const { raw, parsed } = runCapture(repo, startHead, join(dir, "noop.changes"));
    expect(git(repo, "rev-parse", "HEAD")).toBe(startHead);
    expect(parsed.files).toEqual([]);
    expect(raw).not.toContain("dirtyWorktree");
    expect(parsed.dirtyWorktree).toBeUndefined();
  });
});

describe("#271: parsing / manifest", () => {
  it("parseChanges reads the marker and buildManifest stamps dirtyWorktree on the manifest", () => {
    const marked = parseChanges(`endHead=${SHA1}\n---status\nM\tsrc/a.ts\n---stat\nsrc/a.ts\n---\ndirtyWorktree=1\n`);
    expect(marked.dirtyWorktree).toBe(true);
    const m = buildManifest({
      runId: "r", harness: "opencode", startHead: SHA1, exitCode: 0, events,
      log: { bytes: 1, truncated: false },
      changes: { endHead: SHA1, files: [{ status: "M", path: "src/a.ts" }], diffStat: "1", dirtyWorktree: true },
    });
    expect(m.dirtyWorktree).toBe(true);
  });
  it("absence of the marker keeps the manifest byte-identical to today (no dirtyWorktree key)", () => {
    const c = {
      runId: "r", harness: "opencode", startHead: SHA2, exitCode: 0, events,
      log: { bytes: 1, truncated: false },
      changes: { endHead: SHA1, files: [{ status: "M", path: "src/a.ts" }], diffStat: "s" },
    } as Parameters<typeof buildManifest>[0];
    expect(JSON.stringify(buildManifest(c))).not.toContain("dirtyWorktree");
    expect(JSON.stringify(parseChanges(`endHead=${SHA1}\n---status\n---stat\n`))).not.toContain("dirtyWorktree");
  });
  it("a missing capture file still means null (unknown), never dirty", () => {
    const c = {
      runId: "r", harness: "opencode", startHead: SHA2, exitCode: 0, events,
      log: { bytes: 1, truncated: false }, changes: undefined,
    } as Parameters<typeof buildManifest>[0];
    const m = buildManifest(c);
    expect(m.filesChanged).toBeNull();
    expect(m.dirtyWorktree).toBeUndefined();
  });
  it("dirtyWorktreeSignal reads only the exact marker line, not the log tail noise", () => {
    expect(dirtyWorktreeSignal("endHead=abc\ndirtyWorktree=1\n")).toBe(true);
    expect(dirtyWorktreeSignal("")).toBe(false);
    expect(dirtyWorktreeSignal("dirtyWorktree=0\n")).toBe(false);
    expect(dirtyWorktreeSignal(" x | 1 +-\ndirtyWorktree=1")).toBe(true);
    expect(dirtyWorktreeSignal("x dirtyWorktree=10")).toBe(false);
  });
});

describe("#271: end to end on the node (isolation:clone, stand-in engine that edits but never commits)", () => {
  let dir: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet271e-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    // The worker edits tracked files but never commits — the exact #271 shape.
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, `#!/bin/bash\necho dirty-work >> src/a.ts\necho loose > src/stray.txt\n`);
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
  const finish = async (runId: string, extra: Record<string, unknown> = {}) => {
    const end = Date.now() + 10_000;
    while (!existsSync(runPaths(runId).done) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId, ...extra });
  };

  it("the manifest and run record carry dirtyWorktree:true — RED on master", async () => {
    const repo = makeRepo(dir);
    const startHead = git(repo, "rev-parse", "HEAD");
    const ack = await start(repo, "run-d1", { isolation: "clone" });
    expect(ack).toMatchObject({ ok: true, isolation: "clone" });
    const st = await finish("run-d1", { report: true });
    const m = st.manifest as Record<string, unknown> | undefined;
    expect(m).toBeDefined();
    // the manifest saw the changes, and the tip stayed at base — the shape...
    expect((m!.filesChanged as Array<{ path: string }>).some((f) => f.path === "src/a.ts")).toBe(true);
    expect(m!.endHead).toBe(startHead);
    // ...which is now EXPLICIT, not a plain success:
    expect(m!.dirtyWorktree).toBe(true);
    expect(st.dirtyWorktree).toBe(true);
  });

  it("a run that DID commit its work gets no dirtyWorktree flag and a manifest without the key", async () => {
    const repo = makeRepo(dir);
    const bin = join(dir, "bin", "opencode");
    // A compliant worker: edits AND commits (the prompt convention the sync flow assumes).
    writeFileSync(bin, `#!/bin/bash\necho dirty-work >> src/a.ts\ngit add -A\ngit -c user.email=w@n -c user.name=worker commit -q -m work\n`);
    chmodSync(bin, 0o755);
    const ack = await start(repo, "run-d2", { isolation: "clone" });
    expect(ack).toMatchObject({ ok: true, isolation: "clone" });
    const st = await finish("run-d2", { report: true });
    const m = st.manifest as Record<string, unknown> | undefined;
    expect(m).toBeDefined();
    expect(m!.endHead).not.toBe(m!.startHead); // the tip moved
    expect(JSON.stringify(m)).not.toContain("dirtyWorktree");
    expect("dirtyWorktree" in st).toBe(false);
  });
});