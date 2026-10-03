import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildManifest, capLogFile, extractEvents, parseChanges, redactAudit } from "./audit.js";
import { handleOpencodeRun } from "./node/handler.js";
import { pruneStateDir } from "./node/runtime.js";
import { runPaths } from "./paths.js";

const SHA = "a".repeat(40);

describe("#42: parseChanges", () => {
  it("reads end head, name-status (incl. untracked and renames) and the stat", () => {
    const c = parseChanges(`endHead=${SHA}\n---status\nM\tsrc/a.ts\nA\tsrc/new.ts\nD\told.ts\nR100\tfrom.ts\tto.ts\n?\tstray.txt\n---stat\n src/a.ts | 2 +-\n 1 file changed, 1 insertion(+)\n`);
    expect(c.endHead).toBe(SHA);
    expect(c.files).toEqual([
      { status: "M", path: "src/a.ts" }, { status: "A", path: "src/new.ts" }, { status: "D", path: "old.ts" },
      { status: "R", path: "to.ts" }, { status: "?", path: "stray.txt" },
    ]);
    expect(c.diffStat).toContain("1 file changed");
  });
  it("an empty capture is 'no changes', distinct from a missing capture handled by the caller", () => {
    expect(parseChanges(`endHead=${SHA}\n---status\n---stat\n`)).toEqual({ endHead: SHA, files: [], diffStat: "" });
  });
});

describe("#42: extractEvents", () => {
  const nd = [
    '{"type":"step_start","sessionID":"s"}',
    '{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"npm test"}}}}',
    '{"type":"tool_use","part":{"tool":"edit","state":{"input":{"filePath":"src/a.ts"}}}}',
    "plain stderr noise",
    '{"type":"step_finish","part":{"cost":0.01,"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":50,"write":7}}}}',
    '{"type":"step_finish","part":{"cost":0.02,"tokens":{"input":10,"output":2}}}',
  ].join("\n");
  it("collects tool calls and sums usage, tolerating non-JSON lines", () => {
    const e = extractEvents(nd, "opencode");
    expect(e.commandsRecorded).toBe(true);
    expect(e.commands).toEqual([{ tool: "bash", input: "npm test" }, { tool: "edit", input: "src/a.ts" }]);
    expect(e.eventCount).toBe(5);
    expect(e.usage).toMatchObject({ inputTokens: 110, outputTokens: 22, reasoningTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 7 });
    expect(e.usage!.costUsd).toBeCloseTo(0.03, 5);
  });
  it("Pi, or a stream with no events, reports commandsRecorded:false (unknown), never an empty list implying none", () => {
    expect(extractEvents(nd, "pi")).toEqual({ commandsRecorded: false, commands: [], eventCount: 0 });
    expect(extractEvents("just text\nmore text", "opencode").commandsRecorded).toBe(false);
  });
  it("long inputs are bounded", () => {
    const big = JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { input: { command: "x".repeat(5000) } } } });
    expect(extractEvents(big, "opencode").commands[0].input.length).toBe(2000);
  });
});

describe("#42: buildManifest and redaction", () => {
  const events = extractEvents("", "opencode");
  it("computes duration, and uses null (not []) when the change capture is missing", () => {
    const m = buildManifest({ runId: "r", harness: "opencode", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:30Z", exitCode: 0, events, log: { bytes: 1, truncated: false } });
    expect(m.durationMs).toBe(90_000);
    expect(m.filesChanged).toBeNull();
    expect(m.diffStat).toBeNull();
    expect(m.verified).toBeNull();
    expect(m.startHead).toBeNull();
  });
  it("carries files, verification and scope when known", () => {
    const m = buildManifest({ runId: "r", harness: "pi", piModel: "p/m", startHead: SHA, exitCode: 1, verified: false, verifyDetails: { files: [] }, scope: { files: ["src/**"] }, changes: { endHead: SHA, files: [], diffStat: "" }, events, log: { bytes: 0, truncated: false } });
    expect(m).toMatchObject({ model: "p/m", exitCode: 1, verified: false, filesChanged: [], endHead: SHA, scope: { files: ["src/**"] } });
  });
  it("redactAudit scrubs secrets in nested strings only", () => {
    const out = redactAudit({ commands: [{ input: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'" }], n: 3, ok: true });
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out.n).toBe(3);
  });
});

describe("#42: capLogFile", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet42-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("leaves a small log alone", async () => {
    const f = join(dir, "a.log");
    writeFileSync(f, "hello");
    expect(await capLogFile(f, 100)).toEqual({ bytes: 5, truncated: false });
    expect(readFileSync(f, "utf8")).toBe("hello");
  });
  it("keeps head and tail with a marker, within the cap, and says so", async () => {
    const f = join(dir, "b.log");
    writeFileSync(f, "HEAD-" + "x".repeat(10_000) + "-TAIL");
    const r = await capLogFile(f, 1000, 200);
    expect(r).toMatchObject({ truncated: true, originalBytes: 10_010 });
    const out = readFileSync(f, "utf8");
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith("HEAD-")).toBe(true);
    expect(out.endsWith("-TAIL")).toBe(true);
    expect(out).toContain("truncated by fleet audit cap");
  });
  it("a missing log is zero bytes, not an error", async () => {
    expect(await capLogFile(join(dir, "nope.log"), 10)).toEqual({ bytes: 0, truncated: false });
  });
});

describe("#42: end to end on the node (real git repo, stand-in engine)", () => {
  let dir: string;
  let cwd: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  const engine = (body: string) => {
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, `#!/bin/bash\n${body}\n`);
    chmodSync(bin, 0o755);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet42e-"));
    mkdirSync(join(dir, "bin"));
    cwd = join(dir, "work", "proj");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const git = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" });
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    writeFileSync(join(cwd, "src", "a.ts"), "a");
    git("add", "-A"); git("commit", "-q", "-m", "init");
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
  const start = (runId: string, c = cwd) => call({ prompt: "__RUN_START__", op: "run.start", cwd: c, transport: "http", runId, realPrompt: "do it", timeoutMs: 60_000 });
  const report = async (runId: string) => {
    const end = Date.now() + 10_000;
    while (!existsSync(runPaths(runId).done) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId, report: true });
  };

  it("a run that edits files yields a manifest with files, stat, commands, usage, exit code and a stable cached copy", async () => {
    engine(`echo changed >> src/a.ts\necho new > src/b.ts\necho '{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"npm test"}}}}'\necho '{"type":"step_finish","part":{"cost":0.5,"tokens":{"input":9,"output":3}}}'`);
    await start("run-au1");
    const st = await report("run-au1");
    const m = st.manifest;
    expect(m.manifestVersion).toBe(1);
    expect(m.filesChanged.map((f: { path: string }) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(m.diffStat).toMatch(/src\/a\.ts/);
    expect(m.startHead).toMatch(/^[0-9a-f]{40}$/);
    expect(m.commands).toEqual([{ tool: "bash", input: "npm test" }]);
    expect(m.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, costUsd: 0.5 });
    expect(m.exitCode).toBe(0);
    expect(m.durationMs).toBeGreaterThanOrEqual(0);
    expect(statSync(runPaths("run-au1").manifest).mode & 0o077).toBe(0);
    // the worktree moves on; the manifest does not
    writeFileSync(join(cwd, "src", "later.ts"), "later");
    const again = (await call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-au1", report: true })).manifest;
    expect(again).toEqual(m);
  });
  it("exit 0 with NO files written shows filesChanged: [] (the #62 bake-off signature), not null", async () => {
    engine(`echo '{"type":"text","part":{"text":"all tests passing"}}'`);
    await start("run-au2");
    const m = (await report("run-au2")).manifest;
    expect(m.exitCode).toBe(0);
    expect(m.filesChanged).toEqual([]);
  });
  it("outside a git repo the change capture is null (unknown), never an empty list", async () => {
    const plain = join(dir, "work", "plain");
    mkdirSync(plain);
    engine(`echo hi`);
    await start("run-au3", plain);
    const m = (await report("run-au3")).manifest;
    expect(m.filesChanged).toBeNull();
    expect(m.startHead).toBeNull();
  });
  it("no manifest is returned without asking, or before the run has finished", async () => {
    engine(`echo '{"type":"text","part":{"text":"x"}}'`);
    await start("run-au4");
    const end = Date.now() + 10_000;
    while (!existsSync(runPaths("run-au4").done) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    const plain = await call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-au4" });
    expect("manifest" in plain).toBe(false);
  });
});

describe("#42: retention", () => {
  it("prune treats the change capture and manifest as part of the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet42p-"));
    try {
      for (const f of ["run-x.json", "run-x.sh", "run-x.log", "run-x.changes", "done-x.json", "manifest-x.json"]) {
        writeFileSync(join(dir, f), "z");
        utimes(join(dir, f));
      }
      const r = await pruneStateDir(dir, 1000, new Set());
      expect(r.removedRuns).toEqual(["x"]);
      for (const f of ["run-x.changes", "manifest-x.json"]) expect(existsSync(join(dir, f)), f).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
function utimes(p: string) {
  utimesSync(p, 1, 1);
}
