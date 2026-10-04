import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCodeCommand, validatePiOptions, type OpenCodeTask } from "./opencode.js";
import { FEATURE_MIN_PROTOCOL, PROTOCOL_VERSION, requiredProtocol } from "./protocol.js";

const task = (over: Partial<OpenCodeTask> = {}): OpenCodeTask => ({ prompt: "do it", cwd: "/tmp", transport: "http", harness: "pi", piModel: "p/m", ...over });

/** A fake `pi` whose --help lists `flags` and which echoes its argv. */
function fakePi(flags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fakepi-"));
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/bin/bash\nif [ "$1" = "--help" ]; then echo "options: ${flags.join(" ")}"; exit 0; fi\necho "ARGV: $*"\n`);
  chmodSync(bin, 0o755);
  return dir;
}
const run = (cmd: string, dir: string) => spawnSync("bash", ["-c", cmd], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });

describe("#137 Pi-2: validation", () => {
  it("accepts good, rejects shell-ish or oversized", () => {
    expect(validatePiOptions({})).toBeNull();
    expect(validatePiOptions({ piTools: ["read", "grep", "ls"], piOffline: true })).toBeNull();
    expect(validatePiOptions({ piTools: [] })).toBeNull();
    for (const bad of [["read; rm -rf /"], ["$(x)"], ["Read"], [1], "read", Array(17).fill("a")]) expect(validatePiOptions({ piTools: bad }), JSON.stringify(bad)).not.toBeNull();
    expect(validatePiOptions({ piOffline: "yes" })).not.toBeNull();
  });
  it("buildOpenCodeCommand refuses a bad allowlist", () => {
    expect(() => buildOpenCodeCommand(task({ piTools: ["x;y"] }))).toThrow(/piTools/);
  });
});

describe("#137 Pi-2: generated command against a fake pi", () => {
  const all = ["--no-session", "--no-approve", "--no-extensions", "--no-skills", "--tools", "--no-tools", "--offline"];
  it("baseline flags are passed when supported", () => {
    const r = run(buildOpenCodeCommand(task()), fakePi(all));
    expect(r.stdout).toContain("ARGV: -p  --no-session --no-approve --no-extensions --no-skills --model p/m".replace("  ", " ").replace("-p ", "-p "));
  });
  it("an older pi without the flags still runs, unhardened", () => {
    const r = run(buildOpenCodeCommand(task()), fakePi([]));
    expect(r.stdout).toContain("ARGV: -p --model p/m");
    expect(r.status).toBe(0);
  });
  it("piTools and piOffline are forwarded", () => {
    const r = run(buildOpenCodeCommand(task({ piTools: ["read", "grep"], piOffline: true })), fakePi(all));
    expect(r.stdout).toContain("--tools read,grep");
    expect(r.stdout).toContain("--offline");
  });
  it("empty allowlist means --no-tools", () => {
    expect(run(buildOpenCodeCommand(task({ piTools: [] })), fakePi(all)).stdout).toContain("--no-tools");
  });
  it("fails closed (exit 67, pi never runs) when a requested restriction is unsupported", () => {
    for (const t of [task({ piTools: ["read"] }), task({ piOffline: true })]) {
      const r = run(buildOpenCodeCommand(t), fakePi(["--no-session"]));
      expect(r.status).toBe(67);
      expect(r.stderr).toContain("refusing to run unrestricted");
      expect(r.stdout).not.toContain("ARGV");
    }
  });
  it("a hostile prompt still arrives only on stdin", () => {
    const r = run(buildOpenCodeCommand(task({ prompt: "--tools bash '; rm -rf /" })), fakePi(all));
    expect(r.stdout).not.toContain("rm -rf");
    expect(r.status).toBe(0);
  });
});

describe("#137 Pi-2: protocol 5", () => {
  it("restrictions need protocol 5 so older nodes refuse instead of dropping them", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(5);
    expect(requiredProtocol({ harness: "pi", piTools: ["read"] }).version).toBe(FEATURE_MIN_PROTOCOL.piSandbox);
    expect(requiredProtocol({ harness: "pi", piOffline: true }).version).toBe(5);
    expect(requiredProtocol({ harness: "pi" }).version).toBe(1);
    expect(requiredProtocol({}).version).toBe(0);
  });
});
