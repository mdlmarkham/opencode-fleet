import { describe, expect, it } from "vitest";
import { renderOpencodeReport, verifyOpencodeCapture, type OpencodeCapture } from "./opencode-verify.js";

const ok = (stdout: string) => ({ exitCode: 0, stdout });
const RUN_HELP = "opencode run [message..]\n  --model  --agent  --format  --auto  --session";
const toolUse = (cmd: string, exit?: number) => JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { input: { command: cmd }, ...(exit !== undefined ? { metadata: { exit } } : {}) } } });
const stepFinish = JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 } });
const good = (): OpencodeCapture => ({
  probes: { version: ok("opencode 1.2.3"), help: ok("x"), runHelp: ok(RUN_HELP), acpHelp: ok("opencode acp\n  --cwd"), agentList: ok("fleetprobe (subagent)"), debugSkill: ok("fleetprobe"), debugPaths: ok("/home/u/.config/opencode") },
  fsFacts: { "~/.config/opencode": ["opencode.json"], "~/.config/opencode/agent": null },
  modelRun: ok([toolUse("echo fleet-oc-probe", 0), stepFinish].join("\n")),
});
const by = (c: OpencodeCapture) => Object.fromEntries(verifyOpencodeCapture(c).checks.map((x) => [x.id, x.status]));

describe("opencode live verification", () => {
  it("a complete capture confirms every check and passes", () => {
    const r = verifyOpencodeCapture(good());
    expect(r.ok).toBe(true);
    expect(r.opencodeVersion).toBe("1.2.3");
    expect(r.checks.every((x) => x.status === "confirmed")).toBe(true);
  });
  it("a missing required flag fails the run and says what breaks", () => {
    const c = good();
    c.probes.runHelp = ok("opencode run\n  --model  --agent  --auto");
    const r = verifyOpencodeCapture(c);
    expect(r.ok).toBe(false);
    expect(by(c)["run.format"]).toBe("missing");
    expect(renderOpencodeReport(r)).toMatch(/run.format.*\n.*not recorded/);
  });
  it("acp gaining --auto is flagged (optional)", () => {
    const c = good();
    c.probes.acpHelp = ok("opencode acp\n  --auto");
    expect(by(c)["acp.no-auto"]).toBe("missing");
    expect(verifyOpencodeCapture(c).ok).toBe(true);
  });
  it("an event without metadata.exit leaves exit codes missing, not assumed", () => {
    const c = good();
    c.modelRun = ok([toolUse("echo fleet-oc-probe"), stepFinish].join("\n"));
    expect(by(c)["events.exit-code"]).toBe("missing");
    expect(by(c)["events.tool_use"]).toBe("confirmed");
  });
  it("no tool_use for the probe means the required events check is missing", () => {
    const c = good();
    c.modelRun = ok(stepFinish);
    expect(by(c)["events.tool_use"]).toBe("missing");
    expect(verifyOpencodeCapture(c).ok).toBe(false);
  });
  it("what the capture cannot speak to is unverifiable, never confirmed", () => {
    const c = good();
    delete c.modelRun;
    c.probes.agentList = { exitCode: 1, stdout: "", error: "unknown command" };
    c.probes.debugSkill = { exitCode: 1, stdout: "" };
    delete c.fsFacts;
    const s = by(c);
    expect(s["events.tool_use"]).toBe("unverifiable");
    expect(s["agents.project-local"]).toBe("unverifiable");
    expect(s["skills.project-local"]).toBe("unverifiable");
    expect(s["paths.global"]).toBe("unverifiable");
  });
  it("a project-local agent that is not listed is missing, not unverifiable", () => {
    const c = good();
    c.probes.agentList = ok("build\nplan");
    expect(by(c)["agents.project-local"]).toBe("missing");
  });
  it("redacts secrets in report details", () => {
    const c = good();
    c.modelRun = { exitCode: 1, stdout: "", error: "failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789" };
    expect(renderOpencodeReport(verifyOpencodeCapture(c))).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
