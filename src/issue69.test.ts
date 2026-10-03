import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { handleOpencodeRun } from "./node/handler.js";
import { abortRunById, parseProcessTable, runScriptRows, selfStateLines, type AbortDeps } from "./node/runtime.js";
import { runPaths } from "./paths.js";

/** Running = exists and is not a zombie (a killed child whose parent never reaped it is dead). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#69: process table parsing", () => {
  const table = [
    "    1     1     1 Ss   /sbin/init",
    "  500   500   500 Ss   /bin/bash /home/u/.openclaw/fleet/state/run-abc.sh",
    "  501   500   500 S    sleep 60",
    "  777   777   777 S    tail -f /home/u/.openclaw/fleet/state/run-abc.sh",
    "  778   778   778 S    vim /home/u/.openclaw/fleet/state/run-abc.sh",
    "  900   500   500 Z    [sleep] <defunct>",
    "garbage line",
  ].join("\n");
  it("parses rows and drops zombies", () => {
    const rows = parseProcessTable(table);
    expect(rows.map((r) => r.pid)).toEqual([1, 500, 501, 777, 778]);
    expect(rows[1]).toMatchObject({ pid: 500, pgid: 500, stat: "Ss" });
  });
  it("identifies only `bash <script>` as the run, not processes that mention the path", () => {
    const hits = runScriptRows(parseProcessTable(table), "/home/u/.openclaw/fleet/state/run-abc.sh");
    expect(hits.map((r) => r.pid)).toEqual([500]);
    expect(runScriptRows(parseProcessTable(table), "/home/u/.openclaw/fleet/state/run-zzz.sh")).toEqual([]);
  });
  it("an unrelated process that merely has `bash <script>` in its arguments is not the run", () => {
    const rows = parseProcessTable("  9 9 9 S python helper.py /bin/bash /s/run-a.sh");
    expect(runScriptRows(rows, "/s/run-a.sh")).toHaveLength(0);
  });
  it("a path with regex metacharacters is matched literally", () => {
    const rows = parseProcessTable("  9 9 9 Ss /bin/bash /tmp/a.b+c/run(1).sh");
    expect(runScriptRows(rows, "/tmp/a.b+c/run(1).sh")).toHaveLength(1);
    expect(runScriptRows(rows, "/tmp/aXb+c/run(1).sh")).toHaveLength(0);
  });
});

describe("#69: abort logic with a fake process table", () => {
  const mkDeps = (tables: string[], kills: Array<[number, string]>): AbortDeps => ({
    list: async () => (tables.length > 1 ? tables.shift()! : tables[0]),
    kill: (pid, sig) => void kills.push([pid, sig]),
    sleep: async () => {},
  });
  const own = `${process.pid} ${process.pid} ${process.pid} S node`;
  it("signals the SCRIPT's group (negative pgid), not the recorded pid, and confirms only when the group is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet69a-"));
    process.env.FLEET_STATE_DIR = dir;
    try {
      const script = runPaths("run-fake").script;
      const kills: Array<[number, string]> = [];
      const before = `  ${process.pid} ${process.pid} ${process.pid} S node\n  800   800   800 Ss /bin/bash ${script}\n  801   800   800 S sleep 60`;
      const after = `  ${process.pid} ${process.pid} ${process.pid} S node`;
      const r = await abortRunById("run-fake", mkDeps([before, before, after], kills));
      expect(kills[0]).toEqual([-800, "SIGTERM"]);
      expect(r).toMatchObject({ ok: true, aborted: true, confirmed: true, pgid: 800 });
    } finally { delete process.env.FLEET_STATE_DIR; rmSync(dir, { recursive: true, force: true }); }
  });
  it("a group that survives SIGTERM gets SIGKILL; one that survives both is NOT reported aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet69b-"));
    process.env.FLEET_STATE_DIR = dir;
    try {
      const script = runPaths("run-stub").script;
      const kills: Array<[number, string]> = [];
      const alive = `${own}\n  800 800 800 Ss /bin/bash ${script}\n  801 800 800 S sleep 60`;
      const t0 = Date.now();
      const r = await abortRunById("run-stub", { ...mkDeps([alive], kills), sleep: async () => { /* fast-forward */ } });
      expect(kills.map((k) => k[1])).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
      expect(r.ok).toBe(false);
      expect(r.aborted).toBe(false);
      expect(r.confirmed).toBe(false);
      void t0;
    } finally { delete process.env.FLEET_STATE_DIR; rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
  it("nothing running: says so, signals nothing, and distinguishes 'already finished'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet69c-"));
    process.env.FLEET_STATE_DIR = dir;
    try {
      const kills: Array<[number, string]> = [];
      const none = await abortRunById("run-gone", mkDeps([own], kills));
      expect(none).toMatchObject({ ok: false, aborted: false });
      expect(none.alreadyFinished).toBe(false);
      expect(kills).toEqual([]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(runPaths("run-done").done, '{"done":1,"exitCode":0}');
      const done = await abortRunById("run-done", mkDeps([own], kills));
      expect(done).toMatchObject({ ok: false, aborted: false, alreadyFinished: true });
      expect(kills).toEqual([]);
    } finally { delete process.env.FLEET_STATE_DIR; rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses to signal init, or its own process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet69d-"));
    process.env.FLEET_STATE_DIR = dir;
    try {
      const script = runPaths("run-evil").script;
      for (const pgid of [1, process.pid]) {
        const kills: Array<[number, string]> = [];
        const r = await abortRunById("run-evil", mkDeps([`${own}\n  800 ${pgid} 800 Ss /bin/bash ${script}`], kills));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/refusing to signal/);
        expect(kills).toEqual([]);
      }
    } finally { delete process.env.FLEET_STATE_DIR; rmSync(dir, { recursive: true, force: true }); }
  });
  it("a failure to list processes is an error, not a success", async () => {
    const r = await abortRunById("run-x", { list: async () => { throw new Error("ps missing"); }, kill: () => {}, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, aborted: false });
    expect(r.error).toMatch(/cannot list processes/);
  });
});

describe("#69/#64: the real launcher, real processes", () => {
  let dir: string;
  const prev = { path: process.env.PATH, state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet69-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "work", "proj"), { recursive: true });
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
  /** A stand-in engine: records its descendants' pids, optionally ignores TERM, then sleeps. */
  const fakeEngine = (ignoreTerm: boolean) => {
    const bin = join(dir, "bin", "opencode");
    writeFileSync(bin, `#!/bin/bash
${ignoreTerm ? "trap '' TERM" : ""}
( ${ignoreTerm ? "trap '' TERM;" : ""} echo $BASHPID > ${JSON.stringify(join(dir, "child.pid"))}; sleep 120 ) &
echo $$ > ${JSON.stringify(join(dir, "engine.pid"))}
sleep 120
`);
    chmodSync(bin, 0o755);
  };
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));
  const start = (runId: string) =>
    call({ prompt: "__RUN_START__", op: "run.start", cwd: join(dir, "work", "proj"), transport: "http", runId, realPrompt: "do the thing", timeoutMs: 120_000 });
  const waitFor = async (cond: () => boolean, ms = 6_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(100);
    return cond();
  };

  it("records the SCRIPT's pid (a real group leader) as valid JSON, never the launcher subshell or a placeholder", async () => {
    fakeEngine(false);
    const ack = await start("run-real1");
    try {
      expect(ack).toMatchObject({ ok: true, detached: true, pidSource: "script" });
      const st = JSON.parse(readFileSync(runPaths("run-real1").state, "utf8"));
      expect(st).toMatchObject({ runId: "run-real1", state: "running", harness: "opencode" });
      expect(st.pid).toBe(ack.pid);
      expect(st.pgid).toBe(st.pid); // setsid made the script its own group leader
      expect(running(st.pid)).toBe(true);
      expect(readFileSync(`/proc/${st.pid}/cmdline`, "utf8")).toContain(runPaths("run-real1").script);
    } finally { await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-real1" }); }
  }, 30_000);

  it("run.status reports alive for a live run and not alive once it is aborted", async () => {
    fakeEngine(false);
    await start("run-real2");
    expect((await call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-real2" })).alive).toBe(true);
    const ab = await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-real2" });
    expect(ab).toMatchObject({ ok: true, aborted: true, confirmed: true });
    expect((await call({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-real2" })).alive).toBe(false);
  }, 30_000);

  it("abort kills the engine AND its forked children (the bug: it signalled a nonexistent group and reported success)", async () => {
    fakeEngine(false);
    await start("run-real3");
    expect(await waitFor(() => existsSync(join(dir, "child.pid")) && existsSync(join(dir, "engine.pid")))).toBe(true);
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    const engine = Number(readFileSync(join(dir, "engine.pid"), "utf8"));
    expect(running(child) && running(engine)).toBe(true);
    const ab = await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-real3" });
    expect(ab).toMatchObject({ ok: true, aborted: true, confirmed: true });
    expect(running(child)).toBe(false);
    expect(running(engine)).toBe(false);
  }, 30_000);

  it("abort escalates to SIGKILL for a TERM-ignoring engine and still confirms", async () => {
    fakeEngine(true);
    await start("run-real4");
    expect(await waitFor(() => existsSync(join(dir, "child.pid")))).toBe(true);
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    const ab = await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-real4" });
    expect(ab).toMatchObject({ ok: true, confirmed: true });
    expect(running(child)).toBe(false);
  }, 30_000);

  it("a stale/wrong recorded pid cannot make abort hit an unrelated process", async () => {
    fakeEngine(false);
    await start("run-real5");
    // an unrelated process whose pid we plant in the state file (pid reuse / legacy launcher pid)
    const bystander = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
    bystander.unref();
    try {
      const st = JSON.parse(readFileSync(runPaths("run-real5").state, "utf8"));
      writeFileSync(runPaths("run-real5").state, JSON.stringify({ ...st, pid: bystander.pid, pgid: bystander.pid }));
      const ab = await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-real5" });
      expect(ab).toMatchObject({ ok: true, confirmed: true });
      expect(running(bystander.pid!)).toBe(true); // untouched
    } finally {
      try { process.kill(bystander.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  }, 30_000);

  it("aborting a run that is not running signals nothing and does not claim success", async () => {
    const ab = await call({ prompt: "__ABORT__", op: "abort", cwd: "/", runId: "run-never" });
    expect(ab).toMatchObject({ ok: false, aborted: false });
  });

  it("selfStateLines produce valid JSON even with awkward values", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const st = join(dir, "state", "x.json");
    const lines = selfStateLines(st, { runId: "r1", harness: "pi", piModel: "p/it's 100% \"odd\"" });
    writeFileSync(join(dir, "s.sh"), ["#!/bin/bash", ...lines].join("\n"), { mode: 0o755 });
    const { execFileSync } = await import("node:child_process");
    execFileSync("bash", [join(dir, "s.sh")]);
    const parsed = JSON.parse(readFileSync(st, "utf8"));
    expect(parsed).toMatchObject({ runId: "r1", harness: "pi", piModel: "p/it's 100% \"odd\"", state: "running" });
    expect(Number.isInteger(parsed.pid) && parsed.pid > 1).toBe(true);
  });
});

describe("#64: unreadable state", () => {
  it("run.status reports unknown-state, not cleaned, for a corrupt state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet64-"));
    const prev = process.env.FLEET_STATE_DIR;
    process.env.FLEET_STATE_DIR = dir;
    try {
      writeFileSync(runPaths("run-bad").state, "not json{");
      const r = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__RUN_STATUS__", op: "run.status", cwd: "/", runId: "run-bad" })));
      expect(r).toMatchObject({ ok: false, status: "unknown-state" });
    } finally {
      if (prev === undefined) delete process.env.FLEET_STATE_DIR; else process.env.FLEET_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
