import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  evaluateSelfCheck,
  selfCheckScript,
  selfCheckCwdCandidates,
} from "./selfcheck.js";

const here = dirname(fileURLToPath(import.meta.url));
const deploy = readFileSync(join(here, "deploy.ts"), "utf8");

/**
 * Issue #24 regression guards.
 *
 * A merged fix that never reaches the runtime (stale dist) silently
 * re-introduces false success. Hash-equality proves the *file* matches; it does
 * not prove the plugin *works*. The missing piece — shared by every
 * false-success defect in this repo (#12, #13, #18, #22) — is an end-to-end
 * post-install assertion: run a trivial dispatch and require the token back.
 */
describe("issue #24: post-install self-check evaluation", () => {
  const TOKEN = "FLEET_SELFCHECK_abc123";

  it("PASSES only when the token appears in the output", () => {
    const out = `{"type":"text","part":{"text":"${TOKEN}"}}\nFLEET_SELFCHECK_EXIT=0`;
    const v = evaluateSelfCheck(out, TOKEN);
    expect(v.ok).toBe(true);
    expect(v.tokenSeen).toBe(true);
  });

  it("FAILS on exit 0 with no token (the #22 empty-session shape)", () => {
    // A run that opens an empty session exits 0 and greets — must NOT pass.
    const out = `{"type":"text","part":{"text":"Ready. What would you like to do?"}}\nFLEET_SELFCHECK_EXIT=0`;
    const v = evaluateSelfCheck(out, TOKEN);
    expect(v.ok).toBe(false);
    expect(v.tokenSeen).toBe(false);
    expect(v.detail).toMatch(/token never appeared/);
  });

  it("FAILS when the worker principal could not enter the cwd", () => {
    const out = "FLEET_SELFCHECK_CD_FAILED";
    const v = evaluateSelfCheck(out, TOKEN);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/could not enter/);
  });

  it("FAILS when there is no output at all", () => {
    const v = evaluateSelfCheck("", TOKEN);
    expect(v.ok).toBe(false);
    expect(v.tokenSeen).toBe(false);
  });

  it("a stale token from a PREVIOUS run does not pass", () => {
    // Only the exact unique token counts.
    const out = `FLEET_SELFCHECK_old999\nFLEET_SELFCHECK_EXIT=0`;
    const v = evaluateSelfCheck(out, TOKEN);
    expect(v.ok).toBe(false);
  });
});

describe("issue #24: self-check command shape", () => {
  it("delivers the prompt after `--` (bug-#22-aware)", () => {
    const s = selfCheckScript("/tmp", "TOK");
    expect(s).toContain("-- ");
    const dash = s.indexOf(" -- ");
    const tok = s.indexOf("TOK");
    expect(tok).toBeGreaterThan(dash);
  });

  it("fails closed if the cwd is not enterable", () => {
    const s = selfCheckScript("/root/nope", "TOK");
    expect(s).toContain("cd '/root/nope' ||");
    expect(s).toContain("FLEET_SELFCHECK_CD_FAILED");
    expect(s).toContain("exit 66");
  });

  it("emits an explicit exit marker for diagnosis", () => {
    const s = selfCheckScript("/tmp", "TOK");
    expect(s).toContain("FLEET_SELFCHECK_EXIT=$?");
  });

  it("prefers the service HOME then /tmp for a traversable cwd", () => {
    expect(selfCheckCwdCandidates("/home/svcuser")).toEqual(["/home/svcuser", "/tmp"]);
    expect(selfCheckCwdCandidates(undefined)).toEqual(["/tmp"]);
    // A non-absolute HOME is ignored rather than used blindly.
    expect(selfCheckCwdCandidates("relative/path")).toEqual(["/tmp"]);
  });
});

describe("issue #24: deploy wiring", () => {
  it("runs the self-check after restart, and fails the deploy on failure", () => {
    expect(deploy).toContain("runSelfCheck");
    expect(deploy).toContain("selfcheck-");
    // Must come after the restart block so it exercises the served code.
    const restartIdx = deploy.indexOf("restart-${host}");
    const selfIdx = deploy.indexOf("runSelfCheck(SSH_ARGS");
    expect(restartIdx).toBeGreaterThan(-1);
    expect(selfIdx).toBeGreaterThan(restartIdx);
  });

  it("can be disabled explicitly and defaults to enabled", () => {
    expect(deploy).toContain("selfCheck?: boolean");
    expect(deploy).toContain("req.selfCheck !== false");
  });
});
