import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { handleOpencodeRun } from "./node/handler.js";
import { parseScope, scopeOverlap, scopeViolations } from "./scope.js";
import { parseTaskSpec, renderSpec } from "./spec.js";
import { runPaths } from "./paths.js";

describe("#65 scope: parseScope", () => {
  it("absent is fine; present must be well formed", () => {
    expect(parseScope(undefined)).toEqual({ ok: true });
    expect(parseScope(null)).toEqual({ ok: true });
    expect(parseScope({ files: ["src/**", "README.md"] })).toEqual({ ok: true, scope: { files: ["src/**", "README.md"] } });
  });
  it("refuses absolute paths, .. segments, empties, non-strings, too many, control chars", () => {
    for (const bad of [
      "x", [], {}, { files: [] }, { files: "src" }, { files: [""] }, { files: [1] }, { files: ["/etc/passwd"] }, { files: ["C:\\x"] },
      { files: ["a\\b"] }, { files: ["../x"] }, { files: ["a/../../x"] }, { files: ["a\nb"] }, { files: ["a\0b"] },
      { files: Array.from({ length: 101 }, (_, i) => `f${i}`) }, { files: ["x".repeat(201)] },
    ]) {
      expect(parseScope(bad).ok, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});

describe("#65 scope: violations and overlap", () => {
  const scope = { files: ["src/**", "docs/", "README.md", "test/*.ts"] };
  it("flags only changed files outside every pattern", () => {
    expect(scopeViolations(["src/a/b.ts", "docs/x/y.md", "README.md", "test/a.ts", "./src/z.ts"], scope)).toEqual([]);
    expect(scopeViolations(["src/a.ts", "package.json", "test/sub/a.ts", "docs"], scope)).toEqual(["package.json", "test/sub/a.ts", "docs"]);
  });
  it("overlap is conservative: nested prefixes and literal-vs-glob collide, disjoint trees do not", () => {
    const o = (a: string[], b: string[]) => scopeOverlap({ files: a }, { files: b });
    expect(o(["src/**"], ["src/a.ts"])).toBe(true);
    expect(o(["src/**"], ["src/a/**"])).toBe(true);
    expect(o(["src/a/"], ["src/a/b.ts"])).toBe(true);
    expect(o(["**"], ["docs/x.md"])).toBe(true);
    expect(o(["src/a/**"], ["docs/**"])).toBe(false);
    expect(o(["a.ts"], ["b.ts"])).toBe(false);
    expect(o(["a.ts"], ["a.ts"])).toBe(true);
    expect(o(["./a.ts"], ["a.ts"])).toBe(true);
  });
});

describe("#65 scope: spec parsing and rendering", () => {
  it("scope and caps are validated through parseTaskSpec", () => {
    expect(parseTaskSpec({ goal: "g", scope: { files: ["src/**"] } }).ok).toBe(true);
    const bad = parseTaskSpec({ goal: "g", scope: { files: ["../x"] } });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toMatch(/^spec\.scope/);
    expect(parseTaskSpec({ goal: "g", acceptance: Array.from({ length: 51 }, () => "x") }).ok).toBe(false);
    expect(parseTaskSpec({ goal: "g", acceptance: ["x".repeat(1001)] }).ok).toBe(false);
  });
  it("a goal-only spec still renders byte-identically; scope adds a delimited block", () => {
    expect(renderSpec({ goal: "fix it" })).toBe("fix it");
    expect(renderSpec({ goal: "fix it", acceptance: ["tests pass"] })).toBe("fix it\n\nAcceptance criteria:\n- tests pass");
    expect(renderSpec({ goal: "fix it", acceptance: ["a"], scope: { files: ["src/**", "x.ts"] } })).toBe(
      "fix it\n\nAcceptance criteria:\n- a\n\nScope (keep your changes within these paths):\n- src/**\n- x.ts",
    );
    expect(renderSpec({ goal: "g", scope: { files: ["a"] } })).toBe("g\n\nScope (keep your changes within these paths):\n- a");
  });
});

describe("#65 scope: end to end on the node", () => {
  let dir: string;
  let cwd: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet65b-"));
    mkdirSync(join(dir, "bin"));
    cwd = join(dir, "work", "proj");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const git = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(cwd, "src", "a.ts"), "a");
    writeFileSync(join(cwd, "package.json"), "{}");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    // A stand-in engine that edits one in-scope and one out-of-scope file, and adds an untracked one.
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, `#!/bin/bash\necho changed >> src/a.ts\necho changed >> package.json\necho new > src/new.ts\necho new > stray.txt\n`);
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
  const start = (runId: string, extra: Record<string, unknown>) =>
    call({ prompt: "__RUN_START__", op: "run.start", cwd, transport: "http", runId, realPrompt: "do it", timeoutMs: 60_000, ...extra });
  const finished = async (runId: string) => {
    const end = Date.now() + 10_000;
    while (!existsSync(runPaths(runId).done) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId });
  };

  it("reports changed files and the ones outside the declared scope", async () => {
    const ack = await start("run-sc1", { scope: { files: ["src/**"] } });
    expect(ack.ok).toBe(true);
    const st = await finished("run-sc1");
    expect(st.changedFiles.sort()).toEqual(["package.json", "src/a.ts", "src/new.ts", "stray.txt"]);
    expect(st.scopeViolations.sort()).toEqual(["package.json", "stray.txt"]);
  });
  it("a run with no scope reports neither field", async () => {
    await start("run-sc2", {});
    const st = await finished("run-sc2");
    expect("scopeViolations" in st).toBe(false);
    expect("changedFiles" in st).toBe(false);
  });
  it("the node refuses a malformed scope instead of dropping it", async () => {
    const r = await start("run-sc3", { scope: { files: ["../etc"] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refused: scope/);
  });
  it("git failing in the cwd is reported as unknown (null), never as 'no violations'", async () => {
    await start("run-sc4", { scope: { files: ["src/**"] } });
    await finished("run-sc4");
    rmSync(join(cwd, ".git"), { recursive: true, force: true });
    const st = await call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-sc4" });
    expect(st.scopeViolations).toBeNull();
    expect(st.scopeError).toMatch(/could not list/);
  });
});
