import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { verifyGateScript } from "./node/runtime.js";
import { classifyEnvironmentFailure, evaluateExpect, type ExpectCheck } from "./verify.js";
import { resolveCloneBase } from "./provision.js";
import { buildManifest } from "./audit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet326-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const runLauncher = async (spec: ExpectCheck) => {
  const cwd = join(dir, `r-${process.hrtime.bigint().toString(36)}`);
  mkdirSync(cwd, { recursive: true });
  const donePath = join(dir, "done.json");
  const gate = verifyGateScript(spec, donePath, { cwd });
  const scriptPath = join(dir, "launcher.sh");
  writeFileSync(scriptPath, ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n"), { mode: 0o700 });
  await promisify(execFile)("/bin/bash", [scriptPath]);
  return JSON.parse(readFileSync(donePath, "utf8")) as Record<string, any>;
};

describe("#324 classifier", () => {
  it("only exit 126/127 are environmental", () => {
    expect(classifyEnvironmentFailure("tsc", 127, "sh: 1: tsc: not found")).toEqual({ missing: "tsc" });
    expect(classifyEnvironmentFailure("x", 126, "")).toEqual({});
    expect(classifyEnvironmentFailure("t", 1, "Error: Cannot find module './util'")).toBeUndefined();
    expect(classifyEnvironmentFailure("t", 1, "tsc: not found")).toBeUndefined();
  });
  it("in-process gate: 127 is environment-unavailable, exit 1 is a plain failure", async () => {
    const env = await evaluateExpect({ command: "definitely-not-a-tool-xyz" }, dir);
    expect(env.verified).toBe(false);
    expect(JSON.stringify(env.verifyDetails)).toContain("environment-unavailable");
    const plain = await evaluateExpect({ command: "echo 'Cannot find module x' >&2; exit 1" }, dir);
    expect(JSON.stringify(plain.verifyDetails)).not.toContain("environment-unavailable");
  });
  it("stderr capture covers && chains, ; and comments", async () => {
    for (const c of ["true && nope-tool-xyz", "true; nope-tool-xyz", "nope-tool-xyz # trailing"]) {
      const r = await evaluateExpect({ command: c }, dir);
      expect(JSON.stringify(r.verifyDetails), c).toContain("environment-unavailable");
    }
  });
});

describe("#324 launcher (real bash)", () => {
  it("exit 127 and 126 carry kind; exit 3 does not; JSON is valid", async () => {
    const a = await runLauncher({ command: "nope-tool-xyz" });
    expect(a.verified).toBe(false);
    expect(a.verifyDetails.command).toMatchObject({ exitCode: 127, kind: "environment-unavailable" });
    const b = await runLauncher({ command: "exit 3" });
    expect(b.verifyDetails.command.kind).toBeUndefined();
    const c = await runLauncher({ commands: ["exit 126", "true"] });
    expect(c.verifyDetails.commands[0]).toMatchObject({ kind: "environment-unavailable" });
    expect(c.verifyDetails.commands[1].kind).toBeUndefined();
  });
});

describe("#323 clone base", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
  const mkRemote = () => {
    const src = join(dir, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "master");
    writeFileSync(join(src, "f"), "x");
    git(src, "-c", "user.email=a@b", "-c", "user.name=a", "add", ".");
    git(src, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i");
    return src;
  };
  it("implicit main falls back to the remote default; explicit is verbatim", async () => {
    const src = mkRemote();
    const imp = await resolveCloneBase(src, "main", false);
    expect(imp).toMatchObject({ base: "master", substitutedFor: "main" });
    const exp = await resolveCloneBase(src, "main", true);
    expect(exp.base).toBe("main");
    expect(exp.substitutedFor).toBeUndefined();
  });
});

describe("#325 producedChanges", () => {
  const base = { runId: "r", harness: "pi", events: { commandsRecorded: false, commands: [], eventCount: 0 }, log: { bytes: 0, truncated: false } } as any;
  const ch = (files: string[]) => ({ files, diffStat: "", endHead: "h" });
  it("true with files, false with none, absent when the capture is missing", () => {
    expect((buildManifest({ ...base, changes: ch(["a"]) }) as any).producedChanges).toBe(true);
    expect((buildManifest({ ...base, changes: ch([]) }) as any).producedChanges).toBe(false);
    expect("producedChanges" in (buildManifest(base) as any)).toBe(false);
  });
});
