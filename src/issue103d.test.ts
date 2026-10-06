import { describe, expect, it } from "vitest";
import { interpretLiveness, pidMatchesHint, cmdlineOf } from "./recovery.js";
import { probeRun } from "./ledger.js";
import { fakeSshMultiline } from "./testkit/plugin.js";

/**
 * TASK #103d (issue #103) regression guards — the manager-side liveness probe
 * (probeRun, SSH path) can no longer be faked by pid reuse or an unrelated
 * opencode/pi process on the node:
 *   - a recorded pid is confirmed ONLY by pid + identity (its runId embedded
 *     in the launch script path, verified via /proc/<pid>/cmdline read in the
 *     SAME ssh call),
 *   - name-grep lines apply ONLY when no pid was recorded (issue #30 exact).
 * Pure helpers + string fixtures only; no network/SSH (the ssh binary is
 * faked like issue #105's tests).
 */

/** The runId-shaped hint a caller passes (unguessable, issue #32). */
const RUN = "run-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
/** The launch script argv as the kernel would expose it in cmdline (NULs → spaces). */
const scriptCmdline = (runId: string) =>
  `/bin/bash /home/svcuser/.openclaw/fleet/state/run-${runId}.sh`;
const RUNNER_HINT = scriptCmdline(RUN);

describe("#103d: pidMatchesHint (pure, injection-free substring identity)", () => {
  it("matches when the hint (runId) appears in the cmdline", () => {
    expect(pidMatchesHint(RUNNER_HINT, RUN)).toBe(true);
  });
  it("does not match an unrelated cmdline (pid reuse)", () => {
    expect(pidMatchesHint("/usr/bin/sleep 300", RUN)).toBe(false);
  });
  it("an absent cmdline never matches (vanished pid => no identity evidence)", () => {
    expect(pidMatchesHint(undefined, RUN)).toBe(false);
  });
  it("no hint => no match at all (nothing to confirm identity against)", () => {
    expect(pidMatchesHint(RUNNER_HINT, undefined)).toBe(false);
  });
});

describe("#103d: cmdlineOf extracts the CMDLINE marker", () => {
  it("reads the cmdline back from the marker (NULs flattened to spaces)", () => {
    expect(cmdlineOf(`CMDLINE ${RUNNER_HINT}\n`)).toBe(RUNNER_HINT);
  });
  it("a missing or EMPTY marker is no evidence (undefined), never an empty match", () => {
    expect(cmdlineOf("PIDALIVE 4242")).toBe(undefined);
    expect(cmdlineOf("CMDLINE \nPIDALIVE 4242")).toBe(undefined);
    expect(cmdlineOf("")).toBe(undefined);
  });
  it("passes through the full cmdline verbatim", () => {
    const c = scriptCmdline(RUN);
    expect(cmdlineOf(`CMDLINE ${c}\nPIDALIVE 4242\n`)).toBe(c);
  });
});

describe("#103d: interpretLiveness — recorded pid means pid+identity ONLY", () => {
  it("recorded pid alive + cmdline contains the runId hint => alive", () => {
    const part = `PIDALIVE 4242\nCMDLINE ${RUNNER_HINT}\n`;
    expect(interpretLiveness(part, 4242, RUN).alive).toBe(true);
  });
  it("pid reused: pid alive but unrelated cmdline (hint absent) => DEAD (kill -0 alone would lie)", () => {
    const part = `PIDALIVE 4242\nCMDLINE /usr/bin/sleep 300\n999 00:10 pi -p --model x\n`;
    const r = interpretLiveness(part, 4242, RUN);
    expect(r.alive).toBe(false);
    // The verdict must NOT be rescued by any other process line.
    expect(interpretLiveness(`PIDALIVE 4242\nCMDLINE /usr/bin/sleep 300\n998 00:10 opencode run --auto\n`, 4242, RUN).alive).toBe(false);
    // The unrelated lines are still reported (transparency), but never count.
    expect(r.procs).toEqual(["999 00:10 pi -p --model x"]);
  });
  it("recorded pid DEAD (no PIDALIVE) while an unrelated opencode process line IS present => DEAD (the false-alive bug)", () => {
    const part = `CMDLINE \n987 01:23 opencode run --auto\n`;
    expect(interpretLiveness(part, 4242, RUN).alive).toBe(false);
  });
  it("recorded pid dead, no matching processes => DEAD", () => {
    expect(interpretLiveness(`CMDLINE \n`, 4242, RUN).alive).toBe(false);
    expect(interpretLiveness(``, 4242, RUN).alive).toBe(false);
  });
  it("PIDALIVE for a DIFFERENT pid than the recorded one => DEAD (stale marker ignored)", () => {
    expect(interpretLiveness(`PIDALIVE 9999\nCMDLINE ${RUNNER_HINT}\n`, 4242, RUN).alive).toBe(false);
  });
  it("cmdline marker missing entirely while pid alive => DEAD (no identity evidence, fail closed)", () => {
    expect(interpretLiveness(`PIDALIVE 4242\n`, 4242, RUN).alive).toBe(false);
  });
  it("no pid recorded + an opencode process line => alive (issue #30 behavior preserved)", () => {
    expect(interpretLiveness(`1234 00:10 pi -p --model x\n`, undefined, RUN).alive).toBe(true);
    expect(interpretLiveness(`1234 00:10 opencode run --auto\n`, undefined).alive).toBe(true);
  });
  it("no pid recorded + no lines => dead (issue #30 preserved)", () => {
    expect(interpretLiveness(``, undefined, RUN).alive).toBe(false);
  });
  it("hint OMITTED (recorded pid alive, no cmdline read) => exactly today's issue #30 behavior", () => {
    expect(interpretLiveness(`PIDALIVE 4242`, 4242).alive).toBe(true);
    expect(interpretLiveness(`PIDALIVE 4242`, 4242, undefined).alive).toBe(true);
  });
  it("hint omitted + pid DEAD => today's behavior: a name line ALONE would say alive (guarded below by probeRun's new cmdline segment)", () => {
    // Pre-#103d (issue #30) semantics, unchanged for hint-less callers:
    expect(interpretLiveness(`987 01:23 opencode run --auto\n`, 4242).alive).toBe(true);
    expect(interpretLiveness(``, 4242).alive).toBe(false);
  });
  it("markers never leak into the procs name lines", () => {
    const r = interpretLiveness(`PIDALIVE 4242\nCMDLINE ${RUNNER_HINT}\n555 00:07 pi -p --model x\n`, 4242, RUN);
    expect(r.procs).toEqual(["555 00:07 pi -p --model x"]);
  });
});

describe("#103d: probeRun carries the identity read in the SAME ssh call (faked ssh, no network)", () => {
  it("an unrelated cmdline on a live-looking pid reports DEAD, with no ssh error", async () => {
    // The fake ssh answers exactly what the real node would when the recorded
    // pid was recycled by an unrelated process: PIDALIVE + a foreign cmdline.
    const restore = fakeSshMultiline(["PIDALIVE 4242", `CMDLINE /usr/bin/sleep 300`, "---UNCOMMITTED---", "0"]);
    try {
      const probe = await probeRun("node.example", "/work", { pid: 4242, hint: RUN });
      expect(probe.error).toBeUndefined();
      expect(probe.procRunning).toBe(false);
    } finally {
      restore();
    }
  }, 30_000);

  it("a matching cmdline (the run's launch script) reports alive", async () => {
    const restore = fakeSshMultiline(["PIDALIVE 4242", `CMDLINE ${RUNNER_HINT}`, "---UNCOMMITTED---", "3"]);
    try {
      const probe = await probeRun("node.example", "/work", { pid: 4242, hint: RUN });
      expect(probe.error).toBeUndefined();
      expect(probe.procRunning).toBe(true);
      expect(probe.uncommitted).toBe(3);
    } finally {
      restore();
    }
  }, 30_000);

  it("a vanished pid (empty CMDLINE marker, no PIDALIVE) with an unrelated opencode line => DEAD, never an ssh failure", async () => {
    const restore = fakeSshMultiline(["CMDLINE ", "987 01:23 opencode run --auto", "---UNCOMMITTED---", "0"]);
    try {
      const probe = await probeRun("node.example", "/work", { pid: 4242, hint: RUN });
      expect(probe.error).toBeUndefined();
      expect(probe.procRunning).toBe(false);
    } finally {
      restore();
    }
  }, 30_000);
});