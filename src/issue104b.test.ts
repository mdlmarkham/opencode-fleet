/**
 * Issue #104 (bounded slice, TASK-104b): `verify.commands[]` (plural) on the
 * task-spec verify gate.
 *
 * A spec may declare a plural gate — `verify: { commands: string[], timeoutMs? }`
 * (or the flat `expect` equivalent) — where EVERY command is run in the run
 * cwd after the worker exits and must exit 0 for the gate to pass. The
 * singular `command` stays a working alias: it is normalized onto the same
 * plural evaluation path (ONE path — parseExpectSpec -> normalize -> evaluate)
 * and must behave byte-identically to a one-element `commands`. A no-gate spec
 * is untouched (`verified` null / nothing extra emitted).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExpect, normalizeExpect, parseExpectSpec } from "./verify.js";
import { parseTaskSpec, renderSpec } from "./spec.js";
import { verifyGateScript } from "./node/runtime.js";

describe("issue #104b: parseExpectSpec accepts + validates the plural gate", () => {
  it("accepts commands[] alongside files, kept verbatim (timeoutMs too)", () => {
    const a = parseExpectSpec({ commands: ["true", "test -f x"] });
    if (!a.ok) throw new Error("expected ok");
    expect(a.expect).toEqual({ files: undefined, command: undefined, commands: ["true", "test -f x"], timeoutMs: undefined });
    const b = parseExpectSpec({ files: ["a.txt"], commands: ["true"], timeoutMs: 5000 });
    if (!b.ok) throw new Error("expected ok");
    expect(b.expect).toEqual({ files: ["a.txt"], commands: ["true"], timeoutMs: 5000 });
  });

  it("normalizes the singular `command` onto the plural (ONE evaluation path)", () => {
    const parsed = parseExpectSpec({ command: "npm test" });
    if (!parsed.ok || !parsed.expect) throw new Error("expected ok");
    const plural = parseExpectSpec({ commands: ["npm test"] });
    if (!plural.ok || !plural.expect) throw new Error("expected ok");
    expect(normalizeExpect(parsed.expect)).toEqual({ commands: ["npm test"] });
    expect(parsed.expect.commands).toBeUndefined(); // the wire shape keeps the alias
    expect(parsed.expect.command).toBe("npm test"); // kept for `expect: expectSpec.expect` threading
    expect(normalizeExpect(plural.expect)).toEqual({ commands: ["npm test"] });
  });

  it("plural entries are validated like the singular: non-empty strings, no NUL", () => {
    expect(parseExpectSpec({ commands: [] }).ok).toBe(false);
    expect(parseExpectSpec({ commands: ["ok", ""] }).ok).toBe(false);
    expect(parseExpectSpec({ commands: ["ok", "   "] }).ok).toBe(false);
    expect(parseExpectSpec({ commands: ["ok", 7] }).ok).toBe(false);
    expect(parseExpectSpec({ commands: 42 }).ok).toBe(false);
    expect(parseExpectSpec({ commands: ["true\0"] }).ok).toBe(false);
    expect(parseExpectSpec({ timeoutMs: 0 }).ok).toBe(false);
    expect(parseExpectSpec({ timeoutMs: -5 }).ok).toBe(false);
    expect(parseExpectSpec({ timeoutMs: "soon" }).ok).toBe(false);
  });

  it("a gate that checks nothing is refused (plural empty list behaves like the singular's absence)", () => {
    expect(parseExpectSpec({}).ok).toBe(false);
    expect(parseExpectSpec({ commands: [] }).ok).toBe(false);
    // Exact historical text (issue #65 pins it byte-for-byte).
    expect((parseExpectSpec({ commands: [] }) as { error?: string }).error).toBe(
      "expect requires at least one of files or command",
    );
  });
});

describe("issue #104b: spec-level verify gate (parseTaskSpec / renderSpec)", () => {
  it("spec.verify carries commands[] + timeoutMs through parseTaskSpec (validated later by the ONE gate parser)", () => {
    const r = parseTaskSpec({
      goal: "g",
      verify: { commands: ["./scripts/check.sh"], timeoutMs: 30_000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.spec) throw new Error("expected ok spec");
    expect(r.spec.verify).toEqual({ commands: ["./scripts/check.sh"], timeoutMs: 30_000 });
  });

  it("a commands-only gate satisfies 'requires at least one of' when parsed at the gate", () => {
    const r = parseExpectSpec({ commands: ["./scripts/check.sh"] });
    expect(r.ok).toBe(true);
  });

  it("renderSpec is unchanged: verify never appears in the prompt (plural or singular)", () => {
    const withCommands = renderSpec({ goal: "Ship it", acceptance: ["works"], verify: { commands: ["a", "b"], timeoutMs: 1 } });
    const plain = renderSpec({ goal: "Ship it", acceptance: ["works"] });
    expect(withCommands).toBe(plain);
    expect(withCommands).not.toContain("commands");
    expect(parseTaskSpec({ goal: "p", verify: { commands: ["a"] } }).ok).toBe(true);
    expect(renderSpec({ goal: p0() })).toBe(p0()); // prompt-only path byte-identical
  });

  it("issue #262: references render as a dated References block; absent references are byte-identical to today", () => {
    const plain = renderSpec({ goal: "Ship it", acceptance: ["works"] });
    // no references => identical to the pre-#262 output
    expect(renderSpec({ goal: "Ship it", acceptance: ["works"], references: [] })).toBe(plain);
    const withRefs = renderSpec({ goal: "Ship it", acceptance: ["works"], references: [{ path: "docs/CONVENTIONS.md", note: "project conventions" }, { note: "ADR 0002 governs this file" }] });
    expect(withRefs).toContain("References");
    expect(withRefs).toContain("docs/CONVENTIONS.md — project conventions");
    expect(withRefs).toContain("ADR 0002 governs this file");
    // blank entries are dropped, never rendered as empty bullets
    const blank = renderSpec({ goal: "Ship it", references: [{ path: "  " }, { note: "" }] });
    expect(blank).not.toContain("References");
  });

  const p0 = (): string => "just a prompt";
});

describe("issue #104b: evaluateExpect — ONE plural evaluation path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet104b-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("two commands, both exit 0 => verified true; details record every command", async () => {
    const out = await evaluateExpect({ commands: ["true", "exit 0"] }, dir);
    expect(out.verified).toBe(true);
    expect(out.verifyDetails.commands).toEqual([
      { cmd: "true", exitCode: 0, ok: true },
      { cmd: "exit 0", exitCode: 0, ok: true },
    ]);
  });

  it("THE POINT: the second command exits non-zero => verified false, the detail names the failing command", async () => {
    const out = await evaluateExpect({ commands: ["true", "exit 7"] }, dir);
    expect(out.verified).toBe(false);
    expect(out.verifyDetails.commands).toEqual([
      { cmd: "true", exitCode: 0, ok: true },
      { cmd: "exit 7", exitCode: 7, ok: false },
    ]);
    expect((out.verifyDetails.commands ?? []).some((c) => !c.ok && c.cmd === "exit 7")).toBe(true);
  });

  it("the FIRST command failing also fails the gate (every command must pass)", async () => {
    const out = await evaluateExpect({ commands: ["exit 1", "true"] }, dir);
    expect(out.verified).toBe(false);
    expect(out.verifyDetails.commands?.[0]).toEqual({ cmd: "exit 1", exitCode: 1, ok: false });
  });

  it("`command` (singular) behaves byte-identically to a one-element `commands` (evaluation + legacy ledger shape)", async () => {
    const singular = await evaluateExpect({ command: "exit 3" }, dir);
    const plural = await evaluateExpect({ commands: ["exit 3"] }, dir);
    expect(singular.verified).toBe(plural.verified);
    expect(singular.verifyDetails).toEqual({ files: [], command: { cmd: "exit 3", exitCode: 3, ok: false } });
    // The plural adds only the additive `commands` array; the legacy key stays
    // on the FIRST entry so old consumers keep reading the same shape.
    expect(plural.verifyDetails).toEqual({
      files: [],
      command: { cmd: "exit 3", exitCode: 3, ok: false },
      commands: [{ cmd: "exit 3", exitCode: 3, ok: false }],
    });
    const okS = await evaluateExpect({ command: "true" }, dir);
    const okP = await evaluateExpect({ commands: ["true"] }, dir);
    expect(okS.verified).toBe(okP.verified);
    expect(okS.verifyDetails).toEqual({ files: [], command: { cmd: "true", exitCode: 0, ok: true } });
    expect((okP.verifyDetails as { commands?: unknown[] }).commands).toEqual(
      (okS.verifyDetails as { command?: unknown }).command ? [{ cmd: "true", exitCode: 0, ok: true }] : undefined,
    );
  });

  it("files + commands combine: every file must exist AND every command must pass", async () => {
    const missing = await evaluateExpect({ files: ["absent.txt"], commands: ["true"] }, dir);
    expect(missing.verified).toBe(false);
    expect((missing.verifyDetails.commands ?? []).every((c) => c.ok)).toBe(true); // commands ran; the file failed
    const failingCmd = await evaluateExpect({ files: [], commands: ["exit 4"] }, dir);
    expect(failingCmd.verified).toBe(false); // command fails even with no file expectations
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "present.txt"), "x");
    const out = await evaluateExpect({ files: ["present.txt"], commands: ["test -f present.txt", "true"] }, dir);
    expect(out.verified).toBe(true);
    expect(out.verifyDetails.files).toEqual([{ path: "present.txt", ok: true }]);
  });

  it("a no-gate spec is unchanged: absent expect => verified null (withVerified shape)", async () => {
    const { withVerified } = await import("./verify.js");
    const out = withVerified({}, null);
    expect(out.verified).toBe(null);
    expect(out.verifyDetails).toBe(null);
    const noGate = parseExpectSpec(undefined);
    expect(noGate.ok).toBe(true);
    if (noGate.ok) expect(noGate.expect).toBeUndefined();
    const noGateNull = parseExpectSpec(null);
    if (noGateNull.ok) expect(noGateNull.expect).toBeUndefined();
  });
});

describe("issue #104b: timeoutMs bounds a hanging command (shared, overriding the default path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet104bt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("command 1 hangs: bounded by timeoutMs, gate fails, never wedges", async () => {
    const t0 = Date.now();
    const out = await evaluateExpect({ commands: ["sleep 30", "true"], timeoutMs: 500 }, dir);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(10_000); // 30s of sleep must NOT be awaited
    expect(dt).toBeGreaterThan(400); // the 500ms bound genuinely applied
    expect(out.verified).toBe(false);
    const first = out.verifyDetails.commands?.[0];
    expect(first?.cmd).toBe("sleep 30");
    expect(first?.exitCode === null || first?.exitCode === 124).toBe(true);
  });

  it("timeoutMs overrides the per-call commandTimeoutMs option (spec-declared wins)", async () => {
    const t0 = Date.now();
    const out = await evaluateExpect({ commands: ["sleep 30"], timeoutMs: 400 }, dir, { commandTimeoutMs: 30_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out.verified).toBe(false);
  });

  it("without timeoutMs, the launcher/evaluator still bounds via its own budget (backward-compatible shape)", () => {
    // The bash fragment derives its bound from the spec's timeoutMs when given.
    const gate = verifyGateScript({ commands: ["true"], timeoutMs: 4_000 }, "/state/done.json", { cwd: "/w" });
    expect(gate.verifyLines.some((l) => l.includes("__V_TOOLS=( 4 "))).toBe(true);
    const gateDefault = verifyGateScript({ commands: ["true"] }, "/state/done.json", { cwd: "/w" });
    expect(gateDefault.verifyLines.some((l) => l.includes("__V_TOOLS=( 120 "))).toBe(true); // DEFAULT_EXPECT_COMMAND_TIMEOUT_MS
    // A singular `command` keeps the exact legacy fragment bytes.
    const legacy = verifyGateScript({ command: "exit 0" }, "/state/done.json", { cwd: "/w" });
    expect(legacy.verifyLines.join("\n")).toMatch(/timeout -k 5 120 bash -c 'exit 0'/);
    expect(legacy.verifyLines.join("\n")).not.toContain("__V_CMDS=(");
  });
});

describe("issue #104b: the detached launcher fragment runs EVERY command (real bash)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet104bl-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runGate = async (expectSpec: Parameters<typeof verifyGateScript>[0], ec = 0) => {
    const cwd = join(dir, `repo-${process.hrtime.bigint().toString(36)}`);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(cwd, { recursive: true });
    const donePath = join(dir, "done.json");
    const gate = verifyGateScript(expectSpec, donePath, { cwd, commandTimeoutMs: 10_000 });
    const script = ["#!/bin/bash", "set -u", `EC=${ec}`, ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, `launcher-${process.hrtime.bigint().toString(36)}.sh`);
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath]);
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>;
  };

  it("both commands run in the run cwd and both pass => verified true with full plural details", async () => {
    const cwd = join(dir, "repo-cmds");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(cwd + "/sentinel.txt", "x");
    const donePath = join(dir, "done1.json");
    const gate = verifyGateScript(
      { commands: ["test -f sentinel.txt", "printf run > .ran"], timeoutMs: 10_000 },
      donePath,
      { cwd },
    );
    const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, "l1.sh");
    const fs = await import("node:fs");
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath]);
    const done = JSON.parse(fs.readFileSync(donePath, "utf8")) as {
      verified: boolean;
      verifyDetails: { commands: Array<{ cmd: string; exitCode: number; ok: boolean }>; command: { cmd: string } };
    };
    expect(done.verified).toBe(true);
    expect(done.verifyDetails.commands).toEqual([
      { cmd: "test -f sentinel.txt", exitCode: 0, ok: true },
      { cmd: "printf run > .ran", exitCode: 0, ok: true },
    ]);
    expect(done.verifyDetails.command.cmd).toBe("test -f sentinel.txt"); // legacy FIRST key
    expect(fs.existsSync(cwd + "/.ran")).toBe(true);
  });

  it("the SECOND command failing records its exit code and fails the gate", async () => {
    const cwd = join(dir, "repo-fail");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cwd, { recursive: true });
    const donePath = join(dir, "done2.json");
    const gate = verifyGateScript({ commands: ["true", "exit 5"] }, donePath, { cwd, commandTimeoutMs: 10_000 });
    const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, "l2.sh");
    const fs = await import("node:fs");
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath]);
    const done = JSON.parse(fs.readFileSync(donePath, "utf8")) as {
      verified: boolean;
      verifyDetails: { files: unknown[]; commands: Array<{ cmd: string; exitCode: number | null; ok: boolean }>; command: { cmd: string; exitCode: number } };
    };
    expect(done.verified).toBe(false);
    expect(done.verifyDetails.files).toEqual([]);
    expect(done.verifyDetails.commands).toEqual([
      { cmd: "true", exitCode: 0, ok: true },
      { cmd: "exit 5", exitCode: 5, ok: false },
    ]);
    expect(done.verifyDetails.command.exitCode).toBe(0);
  });

  it("a hanging command bounded by timeoutMs in the launcher (exit 124), gate fails, no wedge", async () => {
    const cwd = join(dir, "repo-hang");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cwd, { recursive: true });
    const donePath = join(dir, "done3.json");
    const gate = verifyGateScript({ commands: ["sleep 20", "true"], timeoutMs: 500 }, donePath, { cwd });
    const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
    const scriptPath = join(dir, "l3.sh");
    const fs = await import("node:fs");
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    const t0 = Date.now();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("/bin/bash", [scriptPath], { timeout: 30_000 });
    const dt = Date.now() - t0;
    const done = JSON.parse(fs.readFileSync(donePath, "utf8")) as {
      verified: boolean;
      verifyDetails: { commands: Array<{ cmd: string; exitCode: number | null; ok: boolean }> };
    };
    expect(dt).toBeLessThan(20_000); // sleep 20 was killed by the timeout, not awaited
    expect(done.verified).toBe(false);
    expect(done.verifyDetails.commands[0].cmd).toBe("sleep 20");
    expect(done.verifyDetails.commands[0].exitCode === null || done.verifyDetails.commands[0].exitCode === 124).toBe(true);
  });

  it("the singular `command` fragment is byte-identical in behaviour to one-element commands (re-cd failure fails closed)", async () => {
    // re-cd fails => the command fails closed (never runs); the legacy singular
    // ledger keeps the exact {files, command} shape (no additive commands key).
    const done = await new Promise<Record<string, unknown>>((resolveDone) => {
      void (async () => {
        const donePath = join(dir, "done4.json");
        const gate = verifyGateScript(
          { command: "touch SHOULD_NOT_RUN", commands: undefined as unknown as undefined },
          donePath,
          { cwd: join(dir, "vanished") },
        );
        const script = ["#!/bin/bash", "set -u", "EC=0", ...gate.verifyLines, gate.doneLine].join("\n");
        const scriptPath = join(dir, "l4.sh");
        const fs = await import("node:fs");
        fs.writeFileSync(scriptPath, script, { mode: 0o700 });
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        await promisify(execFile)("/bin/bash", [scriptPath], { cwd: dir });
        resolveDone(JSON.parse(fs.readFileSync(donePath, "utf8")) as Record<string, unknown>);
      })();
    });
    const details = done.verifyDetails as {
      files: unknown[];
      command: { cmd: string; exitCode: number | null; ok: boolean };
      commands?: Array<{ cmd: string; exitCode: number | null; ok: boolean }>;
    };
    expect(done.verified).toBe(false);
    expect(details.command).toEqual({ cmd: "touch SHOULD_NOT_RUN", exitCode: null, ok: false });
    expect(details.commands).toBeUndefined(); // legacy wire shape: no additive key
    const fs = await import("node:fs");
    expect(fs.existsSync(dir + "/SHOULD_NOT_RUN")).toBe(false);
    expect(fs.existsSync(join(dir, "vanished", "SHOULD_NOT_RUN"))).toBe(false);
  });
});