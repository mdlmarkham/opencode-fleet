import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cloneHasUnsyncedWork, createRunClone, pruneRunClones, removeRunClone, runCloneDir } from "./node/runtime.js";
import { handleOpencodeRun } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { PROTOCOL_VERSION, requiredProtocol } from "./protocol.js";
import { latestRunFor, type LedgerEntry } from "./ledger.js";
import { runPaths } from "./paths.js";

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

describe("#41: createRunClone", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet41-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("makes a private clone beside the source on branch fleet/<runId>, with hooks disabled", async () => {
    const repo = makeRepo(dir);
    const r = await createRunClone("run-a", repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cwd).toBe(`${join(dir, "work")}/.fleet-runs/run-a/repo`);
    expect(r.branch).toBe("fleet/run-a");
    expect(r.sourceDirty).toBe(false);
    expect(git(r.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fleet/run-a");
    expect(git(r.cwd, "config", "core.hooksPath")).toBe("/dev/null");
    expect(readFileSync(join(r.cwd, "src", "a.ts"), "utf8")).toBe("a");
    // 0700 run dir, and the clone's .git is its own (not a worktree pointer into the source)
    expect(execFileSync("stat", ["-c", "%a", runCloneDir(repo, "run-a")]).toString().trim()).toBe("700");
    expect(readFileSync(join(r.cwd, ".git", "HEAD"), "utf8")).toContain("fleet/run-a");
    expect(existsSync(join(r.cwd, ".git", "objects"))).toBe(true);
  });
  it("two runs on the same source never share a cwd, and work in one does not appear in the other or the source", async () => {
    const repo = makeRepo(dir);
    const a = await createRunClone("run-a", repo);
    const b = await createRunClone("run-b", repo);
    if (!a.ok || !b.ok) throw new Error("clone failed");
    expect(a.cwd).not.toBe(b.cwd);
    writeFileSync(join(a.cwd, "only-in-a.txt"), "x");
    git(a.cwd, "add", "-A");
    git(a.cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a work");
    expect(existsSync(join(b.cwd, "only-in-a.txt"))).toBe(false);
    expect(existsSync(join(repo, "only-in-a.txt"))).toBe(false);
    expect(git(repo, "log", "--oneline").split("\n")).toHaveLength(1);
  });
  it("a hook planted by run A is not executed by run B or by the source checkout", async () => {
    const repo = makeRepo(dir);
    const a = await createRunClone("run-a", repo);
    const b = await createRunClone("run-b", repo);
    if (!a.ok || !b.ok) throw new Error("clone failed");
    const marker = join(dir, "HOOK-RAN");
    // run A tries every route: its own hook dir, and a repo-level hooksPath it controls
    mkdirSync(join(a.cwd, ".git", "hooks"), { recursive: true });
    writeFileSync(join(a.cwd, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(a.cwd, ".git", "hooks", "post-commit"), 0o755);
    for (const cwd of [b.cwd, repo]) {
      writeFileSync(join(cwd, "x.txt"), "x");
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
    }
    expect(existsSync(marker)).toBe(false);
    // and the clone itself ignores its own hooks (core.hooksPath=/dev/null)
    writeFileSync(join(a.cwd, "y.txt"), "y");
    git(a.cwd, "add", "-A");
    git(a.cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "y");
    expect(existsSync(marker)).toBe(false);
  });
  it("reports uncommitted source changes (only committed state is cloned)", async () => {
    const repo = makeRepo(dir);
    writeFileSync(join(repo, "wip.txt"), "wip");
    const r = await createRunClone("run-a", repo);
    expect(r).toMatchObject({ ok: true, sourceDirty: true });
    if (r.ok) expect(existsSync(join(r.cwd, "wip.txt"))).toBe(false);
  });
  it("refuses a non-repo, a repo with no commits, a bad runId, and a run that already has a directory", async () => {
    const plain = join(dir, "work", "plain");
    mkdirSync(plain, { recursive: true });
    expect((await createRunClone("run-a", plain)).ok).toBe(false);
    const empty = join(dir, "work", "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    expect((await createRunClone("run-a", empty)).ok).toBe(false);
    const repo = makeRepo(dir);
    expect((await createRunClone("../escape", repo)).ok).toBe(false);
    expect((await createRunClone("run-a", repo)).ok).toBe(true);
    const again = await createRunClone("run-a", repo);
    expect(again.ok).toBe(false);
  });
  it("removeRunClone only removes the exact .fleet-runs/<id>/repo shape and never follows a symlink", async () => {
    const repo = makeRepo(dir);
    const r = await createRunClone("run-a", repo);
    if (!r.ok) throw new Error("clone failed");
    expect(await removeRunClone(repo)).toBe(false); // the source checkout is not a run clone
    expect(await removeRunClone(join(dir, "work"))).toBe(false);
    expect(existsSync(repo)).toBe(true);
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "k");
    mkdirSync(join(dir, "work", ".fleet-runs", "evil"), { recursive: true });
    rmSync(join(dir, "work", ".fleet-runs", "evil"), { recursive: true });
    symlinkSync(outside, join(dir, "work", ".fleet-runs", "evil"));
    expect(await removeRunClone(join(dir, "work", ".fleet-runs", "evil", "repo"))).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(await removeRunClone(r.cwd)).toBe(true);
    expect(existsSync(r.cwd)).toBe(false);
  });
});

describe("#41: cleanup never deletes unsynced work silently", () => {
  let dir: string;
  let state: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet41p-")); state = join(dir, "state"); mkdirSync(state, { mode: 0o700 }); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const finishedRun = async (repo: string, id: string, work: "none" | "uncommitted" | "commit") => {
    const r = await createRunClone(id, repo);
    if (!r.ok) throw new Error(r.error);
    const startHead = git(r.cwd, "rev-parse", "HEAD");
    if (work !== "none") writeFileSync(join(r.cwd, "w.txt"), "w");
    if (work === "commit") { git(r.cwd, "add", "-A"); git(r.cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "w"); }
    writeFileSync(join(state, `run-${id}.json`), JSON.stringify({ runId: id, startHead, isolation: { mode: "clone", cwd: r.cwd } }));
    writeFileSync(join(state, `done-${id}.json`), "{}");
    for (const f of [`run-${id}.json`, `done-${id}.json`]) utimesSync(join(state, f), 1, 1);
    return r.cwd;
  };

  it("classifies a clone's work", async () => {
    const repo = makeRepo(dir);
    const none = await finishedRun(repo, "n", "none");
    const unc = await finishedRun(repo, "u", "uncommitted");
    const com = await finishedRun(repo, "c", "commit");
    const startOf = (id: string) => JSON.parse(readFileSync(join(state, `run-${id}.json`), "utf8")).startHead as string;
    expect((await cloneHasUnsyncedWork(none, startOf("n"))).unsynced).toBe(false);
    expect(await cloneHasUnsyncedWork(unc, startOf("u"))).toMatchObject({ unsynced: true, detail: "uncommitted changes" });
    expect((await cloneHasUnsyncedWork(com, startOf("c"))).detail).toMatch(/1 commit/);
    expect((await cloneHasUnsyncedWork(none, undefined)).unsynced).toBe(true); // unknown counts as unsynced
  });
  it("removes only clean old clones by default, keeps and lists the rest, and protects their state pointers", async () => {
    const repo = makeRepo(dir);
    const none = await finishedRun(repo, "n", "none");
    const unc = await finishedRun(repo, "u", "uncommitted");
    const com = await finishedRun(repo, "c", "commit");
    const r = await pruneRunClones(state, 1000, new Set());
    expect(r.removedClones).toEqual(["n"]);
    expect(r.keptUnsynced.map((k) => k.runId).sort()).toEqual(["c", "u"]);
    expect([...r.protect].sort()).toEqual(["c", "u"]);
    expect(existsSync(none)).toBe(false);
    expect(existsSync(unc) && existsSync(com)).toBe(true);
  });
  it("discardUnsynced is an explicit opt-in", async () => {
    const repo = makeRepo(dir);
    const com = await finishedRun(repo, "c", "commit");
    const r = await pruneRunClones(state, 1000, new Set(), { discardUnsynced: true });
    expect(r.removedClones).toEqual(["c"]);
    expect(existsSync(com)).toBe(false);
  });
  it("never touches a live run or a run that has not finished", async () => {
    const repo = makeRepo(dir);
    const live = await finishedRun(repo, "l", "none");
    const unfinished = await finishedRun(repo, "x", "none");
    rmSync(join(state, "done-x.json"));
    const r = await pruneRunClones(state, 1000, new Set(["l"]));
    expect(r.removedClones).toEqual([]);
    expect(existsSync(live) && existsSync(unfinished)).toBe(true);
  });
  it("a run younger than the cutoff is left alone", async () => {
    const repo = makeRepo(dir);
    const cwd = await finishedRun(repo, "n", "none");
    utimesSync(join(state, "run-n.json"), Date.now() / 1000, Date.now() / 1000);
    utimesSync(join(state, "done-n.json"), Date.now() / 1000, Date.now() / 1000);
    expect((await pruneRunClones(state, 3_600_000, new Set())).removedClones).toEqual([]);
    expect(existsSync(cwd)).toBe(true);
  });
});

describe("#41: end to end on the node", () => {
  let dir: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet41e-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, `#!/bin/bash\npwd > "$(dirname "$(pwd)")/where"\necho changed >> src/a.ts\necho new > src/new.ts\n`);
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

  it("the worker runs in the clone: the source is untouched, the ack names the clone and branch, the manifest and scope use the clone", async () => {
    const repo = makeRepo(dir);
    const ack = await start(repo, "run-iso1", { isolation: "clone", scope: { files: ["src/a.ts"] } });
    expect(ack).toMatchObject({ ok: true, isolation: "clone", branch: "fleet/run-iso1", sourceDirty: false });
    expect(ack.runCwd).toBe(`${join(dir, "work")}/.fleet-runs/run-iso1/repo`);
    const st = await finish("run-iso1", { report: true });
    expect(readFileSync(join(dir, "work", ".fleet-runs", "run-iso1", "where"), "utf8").trim()).toBe(ack.runCwd);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("a");
    expect(st.cwd).toBe(ack.runCwd);
    expect(st.isolation).toMatchObject({ mode: "clone", source: repo, cwd: ack.runCwd, branch: "fleet/run-iso1" });
    expect(st.manifest.filesChanged.map((f: { path: string }) => f.path).sort()).toEqual(["src/a.ts", "src/new.ts"]);
    expect(st.scopeViolations).toEqual(["src/new.ts"]);
    expect(git(ack.runCwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fleet/run-iso1");
  });
  it("without isolation the run works in the source, as before", async () => {
    const repo = makeRepo(dir);
    const ack = await start(repo, "run-iso2");
    expect("runCwd" in ack).toBe(false);
    await finish("run-iso2");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toContain("changed");
    expect(existsSync(join(dir, "work", ".fleet-runs"))).toBe(false);
  });
  it("two concurrent isolated runs of the same source work in different clones", async () => {
    const repo = makeRepo(dir);
    const [a, b] = await Promise.all([start(repo, "run-iso3", { isolation: "clone" }), start(repo, "run-iso4", { isolation: "clone" })]);
    expect(a.runCwd).not.toBe(b.runCwd);
    await finish("run-iso3");
    await finish("run-iso4");
    for (const c of [a.runCwd, b.runCwd]) expect(git(c, "status", "--porcelain")).toMatch(/src\/a\.ts/);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
  it("refuses a bad isolation value and a source that cannot be cloned, launching nothing", async () => {
    const repo = makeRepo(dir);
    expect((await start(repo, "run-iso5", { isolation: "docker" })).error).toMatch(/unknown isolation/);
    const plain = join(dir, "work", "plain");
    mkdirSync(plain);
    const r = await start(plain, "run-iso6", { isolation: "clone" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot isolate/);
    expect(existsSync(runPaths("run-iso6").script)).toBe(false);
  });
});

describe("#41: protocol 4 gate (no silent un-isolated run)", () => {
  it("only isolation 'clone' needs protocol 4; 'none' and absent need nothing", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
    expect(requiredProtocol({ isolation: "clone" }).version).toBe(4);
    expect(requiredProtocol({ isolation: "none" }).version).toBe(0);
    expect(requiredProtocol({}).version).toBe(0);
    expect(requiredProtocol({ harness: "pi", isolation: "clone" }).version).toBe(4);
  });
  for (const pv of [0, 1, 2, 3]) {
    it(`a protocol-${pv} node is refused by the gateway, which sends only the probe`, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const ctx = (params: Record<string, unknown>): PolicyCtx => ({
        params, node: { nodeId: "n1" },
        invokeNode: async (a: { params: Record<string, unknown> }) => { seen.push(a.params); return { ok: true as const, payload: { ok: true, ...(pv > 0 ? { protocol: pv } : {}) } }; },
      } as unknown as PolicyCtx);
      const r = await handleOpencodeRunPolicy(ctx({ prompt: "__RUN_START__", op: "run.start", cwd: "/w", runId: "r1", realPrompt: "x", isolation: "clone" }), newProtocolCache());
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/isolation/);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ prompt: "__RUN_STATUS__" });
    });
  }
});

describe("#41: sync follows the run's clone", () => {
  it("latestRunFor finds the run by its clone path as well as the source", () => {
    const e = { runId: "r", node: "dev2", cwd: "/w/proj", runCwd: "/w/.fleet-runs/r/repo", prompt: "x", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "completed", verified: false } as LedgerEntry;
    expect(latestRunFor([e], ["dev2"], "/w/.fleet-runs/r/repo")?.runId).toBe("r");
    expect(latestRunFor([e], ["dev2"], "/w/proj")?.runId).toBe("r");
    expect(latestRunFor([e], ["dev2"], "/w/other")).toBeUndefined();
  });
});
