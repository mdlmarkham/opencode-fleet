/**
 * Issue #62: OPTIONAL post-run verification gate.
 *
 * A run that exits 0 but produced nothing must not be reported as success.
 * With `expect: { files?, command? }` the NODE evaluates the gate in the
 * run's cwd after the worker exits and records `verified` + `verifyDetails`
 * next to the result. `verified` stays distinct from `ok` (the process exit
 * status); with no `expect` nothing changes at all (verified = null).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPECT_COMMAND_TIMEOUT_MS,
  evaluateExpect,
  parseExpectSpec,
  resolveExpectPath,
  type ExpectCheck,
} from "./verify.js";
import { doneMarkerLine, runScriptPath, verifyGateScript } from "./node/runtime.js";
import { handleOpencodeRun } from "./node/handler.js";
import { runPaths } from "./paths.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("issue #62: expect spec validation (parseExpectSpec)", () => {
  it("treats an absent/None spec as 'no gate' (backward compatibility)", () => {
    expect(parseExpectSpec(undefined)).toEqual({ ok: true, expect: undefined });
    expect(parseExpectSpec(null)).toEqual({ ok: true, expect: undefined });
  });
  it("accepts files, command, or both; keeps them verbatim", () => {
    expect(parseExpectSpec({ files: ["a.txt"] })).toEqual({ ok: true, expect: { files: ["a.txt"], command: undefined } });
    expect(parseExpectSpec({ command: "npm test" })).toEqual({ ok: true, expect: { files: undefined, command: "npm test" } });
    expect(parseExpectSpec({ files: [], command: "true" }).ok).toBe(true);
  });
  it("refuses a gate that checks nothing", () => {
    expect(parseExpectSpec({}).ok).toBe(false);
    expect(parseExpectSpec({ files: [] }).ok).toBe(false);
    expect(parseExpectSpec("files-only" as unknown).ok).toBe(false);
    expect(parseExpectSpec([] as unknown).ok).toBe(false);
  });
  it("refuses malformed files/command", () => {
    expect(parseExpectSpec({ files: 42 }).ok).toBe(false);
    expect(parseExpectSpec({ files: ["ok", 7] }).ok).toBe(false);
    expect(parseExpectSpec({ files: [""] }).ok).toBe(false);
    expect(parseExpectSpec({ command: "" }).ok).toBe(false);
    expect(parseExpectSpec({ command: "   " }).ok).toBe(false);
    expect(parseExpectSpec({ command: 1 }).ok).toBe(false);
  });
});

describe("issue #62: the pure evaluator (evaluateExpect)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet62-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when every expected file exists (relative to cwd)", async () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "x");
    writeFileSync(join(dir, "report.md"), "y");
    const out = await evaluateExpect({ files: ["dist/index.js", "report.md"] }, dir);
    expect(out.verified).toBe(true);
    expect(out.verifyDetails.files).toEqual([
      { path: "dist/index.js", ok: true },
      { path: "report.md", ok: true },
    ]);
    expect(out.verifyDetails.command).toBeUndefined();
  });

  it("fails (per-file detail) when one expected file is missing", async () => {
    writeFileSync(join(dir, "there.txt"), "x");
    const out = await evaluateExpect({ files: ["there.txt", "absent.txt"] }, dir);
    expect(out.verified).toBe(false);
    expect(out.verifyDetails.files).toEqual([
      { path: "there.txt", ok: true },
      { path: "absent.txt", ok: false },
    ]);
  });

  it("resolves relative paths against cwd — not against process.cwd()", async () => {
    writeFileSync(join(dir, "marker"), "x");
    // process.cwd() here is the repo root, deliberately NOT the gate cwd.
    const out = await evaluateExpect({ files: ["marker"] }, dir);
    expect(out.verified).toBe(true);
    expect(resolveExpectPath(dir, "marker")).toBe(join(dir, "marker"));
    expect(resolveExpectPath(dir, "/abs/path")).toBe("/abs/path");
  });

  it("follows symlinks: a valid link exists, a broken one does not", async () => {
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), join(dir, "good-link"));
    symlinkSync(join(dir, "never"), join(dir, "bad-link"));
    const out = await evaluateExpect({ files: ["good-link", "bad-link"] }, dir);
    expect(out.verifyDetails.files).toEqual([
      { path: "good-link", ok: true },
      { path: "bad-link", ok: false },
    ]);
    expect(out.verified).toBe(false);
  });

  it("a directory path satisfies an existence check", async () => {
    mkdirSync(join(dir, "sub"));
    const out = await evaluateExpect({ files: ["sub"] }, dir);
    expect(out.verified).toBe(true);
  });

  it("a passing command (exit 0) verifies", async () => {
    const out = await evaluateExpect({ command: "true" }, dir);
    expect(out.verified).toBe(true);
    expect(out.verifyDetails.command).toEqual({ cmd: "true", exitCode: 0, ok: true });
    expect(out.verifyDetails.files).toEqual([]);
  });

  it("a failing command reports its exit code and fails the gate", async () => {
    const out = await evaluateExpect({ command: "exit 3" }, dir);
    expect(out.verified).toBe(false);
    expect(out.verifyDetails.command).toEqual({ cmd: "exit 3", exitCode: 3, ok: false });
  });

  it("present files cannot rescue a failing command, and vice versa", async () => {
    writeFileSync(join(dir, "f.txt"), "x");
    expect((await evaluateExpect({ files: ["f.txt"], command: "exit 9" }, dir)).verified).toBe(false);
    expect((await evaluateExpect({ files: ["gone.txt"], command: "true" }, dir)).verified).toBe(false);
    expect((await evaluateExpect({ files: ["f.txt"], command: "true" }, dir)).verified).toBe(true);
  });

  it("a hanging command fails the gate instead of hanging the run", async () => {
    const t0 = Date.now();
    const out = await evaluateExpect({ command: "sleep 5" }, dir, { commandTimeoutMs: 400 });
    expect(out.verified).toBe(false);
    expect(out.verifyDetails.command?.exitCode === null || out.verifyDetails.command?.exitCode === 124).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it("uses the documented default command timeout", () => {
    expect(DEFAULT_EXPECT_COMMAND_TIMEOUT_MS).toBe(120_000);
  });
});

describe("issue #62: the launcher gate fragment (verifyGateScript)", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet62l-"));
    cwd = join(dir, "repo");
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a minimal launcher around the generated fragment and run it for real. */
  const runGate = async (expect: ExpectCheck, work: (c: string) => Promise<void> | void, ec = 0) => {
    // A fresh cwd per invocation — checks are one-run-worth of state.
    const cwd = join(dir, `repo-${process.hrtime.bigint().toString(36)}`);
    mkdirSync(cwd, { recursive: true });
    await work(cwd);
    const donePath = join(dir, "done.json");
    const gate = verifyGateScript(expect, donePath, { cwd, commandTimeoutMs: 10_000 });
    const script = ["#!/bin/bash", "set -u", `EC=${ec}`, ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, "launcher.sh");
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath]);
    return { done: JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>, donePath, script, cwd };
  };

  it("worker exit 0 + all files + command ok => verified true (details recorded)", async () => {
    const { done } = await runGate(
      { files: ["built.js", "report.md"], command: "test -f built.js" },
      (c) => {
        writeFileSync(join(c, "built.js"), "x");
        writeFileSync(join(c, "report.md"), "y");
      },
    );
    expect(done).toMatchObject({
      done: 1,
      exitCode: 0,
      verified: true,
      verifyDetails: {
        files: [
          { path: "built.js", ok: true },
          { path: "report.md", ok: true },
        ],
        command: { cmd: "test -f built.js", exitCode: 0, ok: true },
      },
    });
  });

  it("THE POINT: a failed/no-op worker (EC != 0) with produced artifacts still verifies; missing artifacts do not", async () => {
    const okWorker = await runGate({ files: ["artifact.txt"] }, (c) => writeFileSync(join(c, "artifact.txt"), "x"), 7);
    expect(okWorker.done).toMatchObject({ exitCode: 7, verified: true });

    const emptyWorker = await runGate({ files: ["artifact.txt"], command: "true" }, () => {}, 0);
    expect(emptyWorker.done).toMatchObject({
      exitCode: 0,
      verified: false,
      verifyDetails: { files: [{ path: "artifact.txt", ok: false }], command: { cmd: "true", exitCode: 0, ok: true } },
    });
  });

  it("a failing verification command records its exit code in the done record", async () => {
    const { done } = await runGate({ command: "exit 42" }, () => {});
    expect(done).toMatchObject({
      exitCode: 0,
      verified: false,
      verifyDetails: { files: [], command: { cmd: "exit 42", exitCode: 42, ok: false } },
    });
  });

  it("quoting: paths with spaces/quotes and commands with quotes survive the round trip", async () => {
    const name = "my file's \"name\".txt";
    const { done, cwd } = await runGate(
      { files: [name], command: `printf 'a"b' > out.txt` },
      (c) => writeFileSync(join(c, name), "x"),
    );
    expect(done).toMatchObject({
      verified: true,
      verifyDetails: {
        files: [{ path: name, ok: true }],
        command: { cmd: `printf 'a"b' > out.txt`, exitCode: 0, ok: true },
      },
    });
    expect(existsSync(join(cwd, "out.txt"))).toBe(true);
  });

  it("no expect.command => verifyDetails has no command key; empty files => files: []", async () => {
    const { done } = await runGate({ command: "true" }, () => {});
    expect(done.verifyDetails).toEqual({ files: [], command: { cmd: "true", exitCode: 0, ok: true } });
    const { done: done2 } = await runGate({ files: ["nope-missing.txt"] }, () => {});
    expect(done2.verifyDetails).toEqual({ files: [{ path: "nope-missing.txt", ok: false }] });
  });

  it("re-cd fails => fail closed, command not run", async () => {
    // Point the gate at a directory that does not exist: nothing can verify.
    const donePath = join(dir, "done.json");
    const gate = verifyGateScript({ files: ["x.txt"], command: "touch SHOULD_NOT_RUN" }, donePath, { cwd: join(dir, "vanished") });
    const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, "launcher2.sh");
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath], { cwd: dir });
    const done = JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>;
    expect(done).toMatchObject({
      verified: false,
      verifyDetails: { files: [{ path: "x.txt", ok: false }], command: { cmd: "touch SHOULD_NOT_RUN", exitCode: null, ok: false } },
    });
    expect(existsSync(join(dir, "SHOULD_NOT_RUN"))).toBe(false);
  });

  it("a hanging verification command is bounded (timeout) and fails the gate", async () => {
    const donePath = join(dir, "done.json");
    const gate = verifyGateScript({ command: "sleep 4" }, donePath, { cwd, commandTimeoutMs: 500 });
    const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
    writeFileSync(join(dir, "launcher3.sh"), script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [join(dir, "launcher3.sh")]);
    const done = JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>;
    expect(done.verified).toBe(false);
    expect((done.verifyDetails as { command: { exitCode: number } }).command.exitCode).toBe(124);
  });

  it("without a gate the done write is byte-identical to the historical line", () => {
    const legacy = doneMarkerLine("/state/done-r1.json");
    expect(legacy).toBe(
      `printf '{"done":1,"exitCode":%s,"finishedAt":"%s"}\\n' "$EC" "$(date -u +%FT%TZ)" > '/state/done-r1.json'`,
    );
  });
});

describe("issue #62: node handler — threading through the detached launcher", () => {
  let dir: string;
  const prev = { state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet62n-"));
    process.env.FLEET_STATE_DIR = join(dir, "state");
    process.env.FLEET_ALLOWED_ROOTS = join(dir, "work");
  });
  afterEach(() => {
    process.env.FLEET_STATE_DIR = prev.state;
    process.env.FLEET_ALLOWED_ROOTS = prev.roots;
    if (prev.state === undefined) delete process.env.FLEET_STATE_DIR;
    if (prev.roots === undefined) delete process.env.FLEET_ALLOWED_ROOTS;
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));
  const repo = () => {
    const r = join(dir, "work", "repo");
    mkdirSync(r, { recursive: true });
    return r;
  };
  const waitDone = async (runId: string, timeoutMs = 45_000) => {
    const donePath = runPaths(runId).done;
    const start = Date.now();
    for (;;) {
      if (existsSync(donePath)) return JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>;
      if (Date.now() - start > timeoutMs) throw new Error(`done file never appeared for ${runId}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  it("run.start refuses a malformed expect before launching anything", async () => {
    const r = await call({ prompt: "__RUN_START__", cwd: repo(), transport: "http", runId: "vbad", op: "run.start", realPrompt: "x", expect: { files: 7 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expect\.files/);
    expect(existsSync(runScriptPath("vbad"))).toBe(false);
  });

  it("expect reaches the generated launcher script (threading)", async () => {
    const r = await call({
      prompt: "__RUN_START__", cwd: repo(), transport: "http", runId: "vthread", op: "run.start", realPrompt: "produce a report",
      maxDurationMs: 2_000,
      expect: { files: ["report.md"], command: "printf done > .verify-ran" },
    });
    expect(r.ok).toBe(true);
    const script = readFileSync(runScriptPath("vthread"), "utf8");
    // The gate fragment must carry the caller's paths + command...
    expect(script).toContain("'report.md'");
    expect(script).toContain("bash -lc 'printf done > .verify-ran'");
    // ...and the done write must record verified + verifyDetails.
    expect(script).toContain('"verified":%s,"verifyDetails":%s');
  });

  it("end-to-end: the node evaluates the gate after the worker exits and records it", async () => {
    const r = repo();
    writeFileSync(join(r, "report.md"), "worker output");
    const launched = await call({
      prompt: "__RUN_START__", cwd: r, transport: "http", runId: "ve2e", op: "run.start", realPrompt: "produce a report",
      maxDurationMs: 2_000,
      expect: { files: ["report.md"], command: "test -f report.md && printf done > .verify-ran" },
    });
    expect(launched.ok).toBe(true);
    // Wait for the DETACHED worker to exit and the node to run the gate.
    const done = await waitDone("ve2e");
    expect(typeof done.exitCode).toBe("number");
    // verified is INDEPENDENT of the exit status: whatever the worker's real
    // exit code was, the gate outcome is recorded alongside it.
    expect(done.verified).toBe(true);
    expect(done.verifyDetails).toEqual({
      files: [{ path: "report.md", ok: true }],
      command: { cmd: "test -f report.md && printf done > .verify-ran", exitCode: 0, ok: true },
    });
    // The command actually ran on the node, in the run cwd.
    expect(existsSync(join(r, ".verify-ran"))).toBe(true);
  });

  it("end-to-end: missing artifacts => verified false, still distinct from the exit code", async () => {
    const r = repo();
    const launched = await call({
      prompt: "__RUN_START__", cwd: r, transport: "http", runId: "vemiss", op: "run.start", realPrompt: "produce a report",
      maxDurationMs: 2_000,
      expect: { files: ["never-written.md"], command: "true" },
    });
    expect(launched.ok).toBe(true);
    const done = await waitDone("vemiss");
    expect(typeof done.exitCode).toBe("number");
    expect(done.verified).toBe(false);
    expect(done.verifyDetails).toEqual({
      files: [{ path: "never-written.md", ok: false }],
      command: { cmd: "true", exitCode: 0, ok: true },
    });
  });

  it("no expect => byte-identical done line in the script and no gate in the record", async () => {
    const launched = await call({
      prompt: "__RUN_START__", cwd: repo(), transport: "http", runId: "vplain", op: "run.start", realPrompt: "plain task",
      maxDurationMs: 2_000,
    });
    expect(launched.ok).toBe(true);
    const script = readFileSync(runScriptPath("vplain"), "utf8");
    expect(script).toContain(`printf '{"done":1,"exitCode":%s,"finishedAt":"%s"}\\n' "$EC" "$(date -u +%FT%TZ)"`);
    expect(script).not.toContain("__V_");
    expect(script).not.toContain("verifyDetails");
    const done = await waitDone("vplain");
    expect("verified" in done).toBe(false);
  });

  it("run.status surfaces verified/verifyDetails (null when no gate); run.result carries them too", async () => {
    const r = repo();
    writeFileSync(join(r, "report.md"), "worker output");
    await call({
      prompt: "__RUN_START__", cwd: r, transport: "http", runId: "vsurf", op: "run.start", realPrompt: "produce a report",
      maxDurationMs: 2_000,
      expect: { files: ["report.md"] },
    });
    await waitDone("vsurf");
    const status = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: "vsurf", op: "run.status" });
    expect(status.verified).toBe(true);
    expect(status.verifyDetails).toEqual({ files: [{ path: "report.md", ok: true }] });
    const result = await call({ prompt: "__RUN_RESULT__", cwd: "/", transport: "http", runId: "vsurf", op: "run.result" });
    expect(result.verified).toBe(true);
    expect(result.result.verified).toBe(true);
    expect(result.result.verifyDetails).toEqual({ files: [{ path: "report.md", ok: true }] });

    const plain = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: "protocol-probe", op: "run.status" });
    expect(plain.status).toBe("never-started");
  });

  it("a run without a gate reports verified: null from run.status/run.result", async () => {
    const r = repo();
    await call({ prompt: "__RUN_START__", cwd: r, transport: "http", runId: "vnull", op: "run.start", realPrompt: "plain task", maxDurationMs: 2_000 });
    await waitDone("vnull");
    const status = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: "vnull", op: "run.status" });
    expect(status.verified).toBe(null);
    expect(status.verifyDetails).toBe(null);
    expect(status.exitCode).toBeDefined();
  });
});

describe("issue #62: node handler — the synchronous (op 'run') path verifies too", () => {
  let dir: string;
  const prev = { state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet62s-"));
    process.env.FLEET_STATE_DIR = join(dir, "state");
    process.env.FLEET_ALLOWED_ROOTS = join(dir, "work");
  });
  afterEach(() => {
    process.env.FLEET_STATE_DIR = prev.state;
    process.env.FLEET_ALLOWED_ROOTS = prev.roots;
    if (prev.state === undefined) delete process.env.FLEET_STATE_DIR;
    if (prev.roots === undefined) delete process.env.FLEET_ALLOWED_ROOTS;
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (p: Record<string, unknown>) => JSON.parse(await handleOpencodeRun(JSON.stringify(p)));

  it("verified is computed in the run cwd after the worker finishes, distinct from ok", async () => {
    const r = join(dir, "work", "repo");
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, "out.txt"), "x");
    const res = await call({
      prompt: "produce out.txt", cwd: r, transport: "http", op: "run", timeoutMs: 2_000,
      expect: { files: ["out.txt"], command: "test -f out.txt" },
    });
    // The worker here really runs (the opencode binary exists in the test
    // env), so ok reflects ITS exit status; verified reflects the gate.
    expect(typeof res.ok).toBe("boolean");
    expect(res.verified).toBe(true);
    expect(res.verifyDetails).toEqual({
      files: [{ path: "out.txt", ok: true }],
      command: { cmd: "test -f out.txt", exitCode: 0, ok: true },
    });
  });

  it("missing artifacts on the sync path => verified false next to the worker's own ok", async () => {
    const r = join(dir, "work", "repo");
    mkdirSync(r, { recursive: true });
    const res = await call({
      prompt: "produce out.txt", cwd: r, transport: "http", op: "run", timeoutMs: 2_000,
      expect: { files: ["out.txt"] },
    });
    expect(res.verified).toBe(false);
    expect(res.verifyDetails).toEqual({ files: [{ path: "out.txt", ok: false }] });
  });

  it("a malformed expect is refused on the sync path too", async () => {
    const r = join(dir, "work", "repo");
    mkdirSync(r, { recursive: true });
    const res = await call({ prompt: "x", cwd: r, transport: "http", op: "run", expect: { command: "" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expect\.command/);
  });
});

describe("issue #62: gateway wiring", () => {
  it("fleet_dispatch validates + threads expect; fleet_run_status surfaces the gate", () => {
    const src = readFileSync(join(here, "index.ts"), "utf8");
    expect(src).toContain("Optional post-run verification gate (issue #62)");
    expect(src).toContain("parseExpectSpec(p.expect)");
    expect(src).toContain("expect: expectSpec.expect,");
    expect(src).toContain('verified: typeof st.verified === "boolean" ? st.verified : null');
    expect(src).toContain("verifyDetails: st.verifyDetails ?? null");
  });
  it("the node handler re-validates expect before launching (the node does not trust the gateway)", () => {
    const src = readFileSync(join(here, "node", "handler.ts"), "utf8");
    expect(src).toContain("parseExpectSpec(task.expect)");
    expect(src).toContain("verifyGateScript(expect, donePath, { cwd: task.cwd })");
  });
});