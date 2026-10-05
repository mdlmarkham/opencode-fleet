import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePiVersion, renderPiReport, verifyPiCapture, type PiCapture } from "./pi-verify.js";

// SYNTHETIC fixtures, shaped from Pi's docs (cli.md, json.md) as the plugin reads them. They are
// NOT a live transcript: they prove the verifier tells a conforming capture from a drifted one,
// not that real Pi conforms. A real capture comes from scripts/pi-capture.mjs on a node.
const HELP = [
  "pi - coding agent",
  "  -p, --print           non-interactive",
  "  --mode <mode>         output mode: text | json | rpc",
  "  --tools <list>        allowlist of tools",
  "  --no-tools            disable all tools",
  "  --offline             no automatic network activity",
  "  --no-session          do not persist a session",
  "  --no-approve          do not trust project-local config",
  "  --no-extensions       do not load extensions",
  "  --no-skills           do not load skills",
].join("\n");
const j = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n");
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, ...extra },
});
const TEXT = j({ type: "agent_start" }, assistant("ok"), { type: "agent_end" });
const TOOL = j(
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo fleet-pi-probe" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false },
  assistant("done"),
  { type: "agent_end" },
);
const good = (): PiCapture => ({
  piVersion: "pi 0.80.2",
  help: HELP,
  runs: [
    { name: "text", prompt: "p", exitCode: 0, stdout: TEXT },
    { name: "tool", prompt: "p", exitCode: 0, stdout: TOOL },
  ],
});
const byId = (r: ReturnType<typeof verifyPiCapture>, id: string) => r.checks.find((c) => c.id === id)!;

describe("#137: verifyPiCapture", () => {
  it("a conforming capture confirms every flag and event the plugin relies on", () => {
    const r = verifyPiCapture(good());
    expect(r.ok).toBe(true);
    expect(r.summary.missing).toBe(0);
    expect(r.piVersion).toBe("0.80.2");
    for (const id of ["flag:--tools", "flag:--no-tools", "flag:--offline", "flag:--mode", "flag:--no-session", "text:message_end", "text:usage", "tool:tool_start", "tool:tool_end"]) {
      expect(byId(r, id).status, id).toBe("confirmed");
    }
  });

  it("a missing flag is reported with what breaks in production (restriction flags: dispatch refuses)", () => {
    const c = good();
    c.help = HELP.replace("  --offline             no automatic network activity\n", "").replace("  --tools <list>        allowlist of tools\n", "");
    const r = verifyPiCapture(c);
    expect(byId(r, "flag:--offline")).toMatchObject({ status: "missing" });
    expect(byId(r, "flag:--offline").effect).toContain("exit 67");
    expect(byId(r, "flag:--tools").status).toBe("missing");
    // --no-tools must not be mistaken for --tools: flag matching is token-exact.
    expect(byId(r, "flag:--no-tools").status).toBe("confirmed");
  });

  it("a drifted event stream fails the required checks: renamed final-message event", () => {
    const c = good();
    c.runs[0]!.stdout = j({ type: "agent_start" }, { type: "assistant_done", text: "ok" }, { type: "agent_end" });
    const r = verifyPiCapture(c);
    expect(r.ok).toBe(false);
    const m = byId(r, "text:message_end");
    expect(m.status).toBe("missing");
    expect(m.detail).toContain("assistant_done");
  });

  it("missing or renamed usage is reported as optional-missing, not a hard failure", () => {
    const c = good();
    c.runs[0]!.stdout = j({ type: "agent_start" }, assistant("ok", { usage: { tokensIn: 5 } }), { type: "agent_end" });
    const r = verifyPiCapture(c);
    expect(byId(r, "text:usage")).toMatchObject({ status: "missing", required: false });
    expect(byId(r, "text:usage").detail).toContain("tokensIn");
    expect(r.ok).toBe(true);
  });

  it("plain-text output (no --mode json) fails the jsonl check and carries the exit and stderr", () => {
    const c = good();
    c.runs[0] = { name: "text", prompt: "p", exitCode: 2, stdout: "just text", stderr: "unknown option --mode" };
    const r = verifyPiCapture(c);
    expect(byId(r, "text:jsonl")).toMatchObject({ status: "missing", required: true });
    expect(byId(r, "text:jsonl").detail).toContain("exit 2");
  });

  it("without a tool run, tool events stay unverifiable (never silently confirmed)", () => {
    const c = good();
    c.runs = [c.runs[0]!];
    const r = verifyPiCapture(c);
    expect(byId(r, "tool:run").status).toBe("unverifiable");
    expect(r.checks.some((x) => x.id === "tool:tool_start")).toBe(false);
  });

  it("a tool run whose tool events were renamed is missing", () => {
    const c = good();
    c.runs[1]!.stdout = j({ type: "agent_start" }, { type: "tool_call", name: "bash" }, assistant("done"), { type: "agent_end" });
    const r = verifyPiCapture(c);
    expect(byId(r, "tool:tool_start").status).toBe("missing");
    expect(r.ok).toBe(false);
  });

  it("reports redact secrets in captured detail; ordinary text is kept", () => {
    const secret = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
    const c = good();
    c.runs[0] = { name: "text", prompt: "p", exitCode: 1, stdout: "x", stderr: `auth failed token ${secret} for run-d8b4fb19` };
    const text = renderPiReport(verifyPiCapture(c));
    expect(text).not.toContain(secret);
    expect(text).toContain("run-d8b4fb19");
  });

  it("an empty capture (no runs) cannot pass: nothing about the events was verified", () => {
    const r = verifyPiCapture({ help: HELP, runs: [] });
    expect(r.ok).toBe(false);
    expect(byId(r, "runs")).toMatchObject({ status: "missing", required: true });
  });

  it("parsePiVersion", () => {
    expect(parsePiVersion("pi 0.73.1")).toBe("0.73.1");
    expect(parsePiVersion("nothing")).toBeUndefined();
    expect(parsePiVersion(undefined)).toBeUndefined();
  });
});

describe("#137: pi-capture.mjs", () => {
  it("runs against a stand-in `pi`, passing only flags the help lists, and emits a capture the verifier accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
    const argv = join(dir, "argv.log");
    // A stand-in that prints docs-shaped output; it logs its argv so we can see the flags used.
    writeFileSync(
      join(dir, "pi"),
      [
        "#!/bin/sh",
        'case "$1" in',
        '  --version) echo "pi 0.80.2"; exit 0;;',
        `  --help) cat <<'FAKEPI_HELP'`,
        HELP,
        "FAKEPI_HELP",
        "  exit 0;;",
        "esac",
        `echo "$@" >> "${argv}"`,
        "cat >/dev/null",
        "cat <<'FAKEPI_OUT'",
        TOOL,
        "FAKEPI_OUT",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "pi-capture.mjs")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    const cap = JSON.parse(r.stdout) as PiCapture;
    expect(cap.runs.map((x) => x.name)).toEqual(["text", "tool"]);
    expect(cap.piVersion).toBe("pi 0.80.2");
    expect(verifyPiCapture(cap).ok).toBe(true);
    const used = spawnSync("cat", [argv], { encoding: "utf8" }).stdout;
    expect(used).toContain("--no-session");
    expect(used).toContain("--mode json");
  });
});
