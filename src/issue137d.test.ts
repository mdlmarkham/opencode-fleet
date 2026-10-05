import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PI_BASELINE_FLAGS, buildOpenCodeCommand, extractPiMarker, parsePiOutput } from "./opencode.js";
import { extractEvents } from "./audit.js";

// A stand-in `pi` shaped like the live pi 0.73.1 capture: its help lists --no-session, --no-extensions,
// --no-skills, --mode, --tools, --no-tools, --offline but NOT --no-approve, and in JSON mode it prints JSONL.
const HELP_0731 = "--no-session --no-extensions --no-skills --mode --tools --no-tools --offline";
const J = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join("\n");
const EVENTS = J(
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } },
  { type: "tool_execution_end", toolCallId: "c1", isError: false },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.002 } } },
  { type: "agent_end" },
);
function fakePi(help: string, version = "0.73.1"): string {
  const dir = mkdtempSync(join(tmpdir(), "fakepi137d-"));
  writeFileSync(join(dir, "pi"), `#!/bin/bash\ncase "$1" in\n --help) echo "${help}"; exit 0;;\n --version) echo "${version}"; exit 0;;\nesac\ncat >/dev/null\ncat <<'PIOUT'\n${EVENTS}\nPIOUT\n`);
  chmodSync(join(dir, "pi"), 0o755);
  return dir;
}
const launch = (dir: string, extra: Record<string, unknown> = {}): string =>
  spawnSync("bash", ["-c", buildOpenCodeCommand({ prompt: "p", cwd: "/tmp", transport: "http", harness: "pi", piModel: "a/b", ...extra })], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" }).stdout;

describe("#137: Pi JSON mode is the default, and the launcher says what Pi it ran", () => {
  it("a default launch against a 0.73.1-shaped Pi runs --mode json and the audit manifest gets commands and usage", () => {
    const out = launch(fakePi(HELP_0731));
    expect(out.startsWith("FLEET_PI: version=0.73.1 flags=")).toBe(true);
    expect(out).toContain("--mode json");
    const m = extractEvents(out, "pi");
    expect(m.commandsRecorded).toBe(true);
    expect(m.commands).toEqual([{ tool: "bash", input: "echo hi" }]);
    expect(m.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
  });

  it("the parser reports the Pi version and the baseline flag this Pi lacks, and keeps the marker out of the summary", () => {
    const r = parsePiOutput(launch(fakePi(HELP_0731)), { exitCode: 0 });
    expect(r).toMatchObject({ ok: true, summary: "ok", piVersion: "0.73.1", piHardeningGaps: ["--no-approve"] });
    expect(r.summary).not.toContain("FLEET_PI");
    expect(r.toolCalls).toEqual([{ tool: "bash", input: "echo hi" }]);
  });

  it("a Pi that lists every baseline flag reports no gaps", () => {
    const r = parsePiOutput(launch(fakePi(`${HELP_0731} --no-approve`)), { exitCode: 0 });
    expect(r.piVersion).toBe("0.73.1");
    expect(r.piHardeningGaps).toBeUndefined();
  });

  it("piJson:false keeps plain text but still reports version and gaps", () => {
    const out = launch(fakePi(HELP_0731), { piJson: false });
    expect(out).not.toContain("--mode json");
    expect(parsePiOutput(out, { exitCode: 0 })).toMatchObject({ piVersion: "0.73.1", piHardeningGaps: ["--no-approve"] });
  });

  it("no marker (an older node): the result is exactly what it was", () => {
    const r = parsePiOutput("plain answer", { exitCode: 0 });
    expect(r.piVersion).toBeUndefined();
    expect(r.piHardeningGaps).toBeUndefined();
    expect(r.summary).toBe("plain answer");
  });

  it("a look-alike marker later in the output (model text) is not trusted", () => {
    const r = parsePiOutput("hello\nFLEET_PI: version=9.9.9 flags=--no-session --no-approve --no-extensions --no-skills", { exitCode: 0 });
    expect(r.piVersion).toBeUndefined();
    expect(extractPiMarker("x\nFLEET_PI: version=1 flags=").version).toBeUndefined();
  });

  it("the version is sanitized (no shell or markup characters survive)", () => {
    const dir = fakePi(HELP_0731, "0.73.1; echo pwned $(id) <b>");
    const out = launch(dir);
    expect(out.split("\n")[0]).not.toMatch(/[;$()<>]/);
  });

  it("the baseline list is the four hardening flags", () => {
    expect([...PI_BASELINE_FLAGS]).toEqual(["--no-session", "--no-approve", "--no-extensions", "--no-skills"]);
  });
});
