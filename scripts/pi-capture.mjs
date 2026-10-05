#!/usr/bin/env node
/**
 * Capture what this node's Pi actually prints, for `pi-verify-cli` (issue #137). Run it ON the
 * node where `pi` is installed; it writes one JSON document to stdout.
 *
 *   node scripts/pi-capture.mjs > pi-capture.json
 *
 * It runs two tiny prompts in a throwaway directory: a text-only one and one that makes Pi run
 * `echo fleet-pi-probe` with its shell tool. The second run EXECUTES that harmless command and
 * calls the configured model, so it uses whatever model and credentials Pi is set up with. Review
 * pi-capture.json before sharing it: it contains Pi's raw output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (args, input, cwd, timeout = 120_000) => {
  const r = spawnSync("pi", args, { input, cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? String(r.error.message) : undefined };
};

const version = run(["--version"], "", process.cwd(), 20_000);
const help = run(["--help"], "", process.cwd(), 20_000);
const helpText = `${help.stdout}\n${help.stderr}`;
const has = (f) => helpText.includes(f);
const base = ["-p", ...["--no-session", "--no-approve", "--no-extensions", "--no-skills"].filter(has), ...(has("--mode") ? ["--mode", "json"] : [])];

const dir = mkdtempSync(join(tmpdir(), "pi-capture-"));
const prompts = [
  ["text", "Reply with exactly the single word: ok"],
  ["tool", "Use your shell tool to run `echo fleet-pi-probe`, then reply with the single word: done"],
];
const runs = prompts.map(([name, prompt]) => {
  const r = run(base, prompt, dir);
  return { name, prompt, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
});
rmSync(dir, { recursive: true, force: true });

process.stdout.write(JSON.stringify({ capturedAt: new Date().toISOString(), piVersion: `${version.stdout}${version.stderr}`.trim().slice(0, 200), help: helpText, runs }, null, 2) + "\n");
