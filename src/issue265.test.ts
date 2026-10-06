import { afterEach, describe, expect, it } from "vitest";
import { probeRun } from "./ledger.js";
import { interpretLiveness } from "./recovery.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stand-in ssh that prints exactly the given lines (no remote-command echo, which would itself look like a process line). */
function fakeSshLines(lines: string[]): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fakessh265-"));
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\n${lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("\n")}\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return () => { process.env.PATH = prev; rmSync(dir, { recursive: true, force: true }); };
}

// #265: a vanished pid makes the probe emit an EMPTY `CMDLINE ` marker; after the line is trimmed it must
// still be excluded from the process list, or a dead pid with no identity hint reports a live run.
describe("#265: the empty CMDLINE marker never counts as a process", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  const deadPid = ["CMDLINE ", "---UNCOMMITTED---", "0"];

  it("interpretLiveness: bare and real markers are excluded from procs", () => {
    expect(interpretLiveness("CMDLINE \n", 4242)).toEqual({ alive: false, procs: [] });
    expect(interpretLiveness("CMDLINE\n", 4242).procs).toEqual([]);
    expect(interpretLiveness("PIDALIVE 4242\nCMDLINE node /x/opencode run\n", 4242)).toEqual({ alive: true, procs: [] });
  });

  it("probeRun, pid set and NO hint, dead pid: not running", async () => {
    restore = fakeSshLines(deadPid);
    const r = await probeRun("node.example", "/work", { pid: 4242 });
    expect(r.procRunning).toBe(false);
    expect(r.procs).not.toContain("CMDLINE");
  });

  it("probeRun, pid and hint (the production path), dead pid: dead and no CMDLINE token in procs", async () => {
    restore = fakeSshLines(deadPid);
    const r = await probeRun("node.example", "/work", { pid: 4242, hint: "run-abc" });
    expect(r.procRunning).toBe(false);
    expect(r.procs).not.toContain("CMDLINE");
  });
});
