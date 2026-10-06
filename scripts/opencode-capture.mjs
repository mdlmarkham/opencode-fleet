#!/usr/bin/env node
/**
 * Capture what this node's opencode actually does, for `opencode-verify-cli` (issues #111, #137, #243).
 * Run it ON the node where `opencode` is installed, as the service user; it writes one JSON document
 * to stdout.
 *
 *   node scripts/opencode-capture.mjs > opencode-capture.json
 *
 * Non-model probes: `--version`, `--help`, `run --help`, `acp --help`, and `agent list` inside a
 * throwaway project that contains a project-local agent file (does opencode load `.opencode/agent/`?).
 * One model probe: a prompt that makes opencode run `echo fleet-oc-probe` with `--format json`, to
 * capture real event shapes (tool_use input, metadata.exit, step_finish tokens). That run EXECUTES a
 * harmless command and calls the configured model with its credentials. Review the JSON before sharing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const run = (args, cwd, input = "", timeout = 120_000) => {
  const r = spawnSync("opencode", args, { cwd, input, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return { args, exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? String(r.error.message) : undefined };
};
const list = (dir) => { try { return existsSync(dir) ? readdirSync(dir).slice(0, 50) : null; } catch { return null; } };

const dir = mkdtempSync(join(tmpdir(), "oc-capture-"));
mkdirSync(join(dir, ".opencode", "agent"), { recursive: true });
writeFileSync(join(dir, ".opencode", "agent", "fleetprobe.md"), "---\ndescription: fleet capture probe agent\nmode: subagent\n---\nYou are a probe.\n");
mkdirSync(join(dir, ".opencode", "skill", "fleetprobe"), { recursive: true });
writeFileSync(join(dir, ".opencode", "skill", "fleetprobe", "SKILL.md"), "---\nname: fleetprobe\ndescription: fleet capture probe skill\n---\nprobe\n");

const probes = {
  version: run(["--version"], dir, "", 20_000),
  help: run(["--help"], dir, "", 20_000),
  runHelp: run(["run", "--help"], dir, "", 20_000),
  acpHelp: run(["acp", "--help"], dir, "", 20_000),
  agentList: run(["agent", "list"], dir, "", 30_000),
  debugPaths: run(["debug", "paths"], dir, "", 30_000),
  debugSkill: run(["debug", "skill"], dir, "", 30_000),
};
const home = homedir();
const fsFacts = Object.fromEntries([
  ["~/.config/opencode", join(home, ".config", "opencode")],
  ["~/.config/opencode/agent", join(home, ".config", "opencode", "agent")],
  ["~/.config/opencode/agents", join(home, ".config", "opencode", "agents")],
  ["~/.config/opencode/skill", join(home, ".config", "opencode", "skill")],
  ["~/.config/opencode/skills", join(home, ".config", "opencode", "skills")],
  ["~/.claude/skills", join(home, ".claude", "skills")],
].map(([k, p]) => [k, list(p)]));

const modelRun = run(["run", "--format", "json", "Use your shell tool to run `echo fleet-oc-probe`, then reply with the single word: done"], dir, "", 180_000);
rmSync(dir, { recursive: true, force: true });

process.stdout.write(JSON.stringify({ capturedAt: new Date().toISOString(), probes, fsFacts, modelRun }, null, 2) + "\n");
