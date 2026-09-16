import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  defaultFleetCwd,
  looksWorkerInaccessible,
  cwdGuardScript,
  cwdCheckCommand,
  evaluateCwdCheck,
  FLEET_ROOT,
} from "./cwd.js";

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, "index.ts"), "utf8");

/**
 * Issue #26 regression guards.
 *
 * The worker runs as the service principal (svcuser), but /root is 0700, so no
 * /root cwd is usable. Provision's default landed checkouts under /root, so the
 * easy path produced a workspace the dispatch principal could not enter — a
 * cross-tool contract mismatch. Post-#22 it failed loudly; the contract gap
 * remained.
 */
describe("issue #26: default cwd lands in a shared workspace", () => {
  it("defaults under the shared fleet root, not /root", () => {
    const cwd = defaultFleetCwd("git@github.com:mdlmarkham/ohm.git");
    expect(cwd.startsWith(FLEET_ROOT)).toBe(true);
    expect(cwd).toBe("/home/svcuser/fleet/ohm");
    expect(cwd.startsWith("/root")).toBe(false);
  });

  it("sanitizes the repo name", () => {
    expect(defaultFleetCwd("https://example.com/org/my repo!")).toBe("/home/svcuser/fleet/my-repo-");
    expect(defaultFleetCwd("simple")).toBe("/home/svcuser/fleet/simple");
    expect(defaultFleetCwd("a/b/c/deep.git")).toBe("/home/svcuser/fleet/deep");
  });

  it("handles a trailing slash on the root without doubling", () => {
    expect(defaultFleetCwd("ohm", "/srv/fleet/")).toBe("/srv/fleet/ohm");
  });
});

describe("issue #26: fast path-only check for /root", () => {
  it("flags /root paths for a non-root principal", () => {
    expect(looksWorkerInaccessible("/root/ohm-fleet/ohm", "svcuser")).toBe(true);
    expect(looksWorkerInaccessible("/root", "svcuser")).toBe(true);
    expect(looksWorkerInaccessible("/rootish/notroot", "svcuser")).toBe(false);
  });

  it("does NOT flag for root itself (root can traverse /root)", () => {
    expect(looksWorkerInaccessible("/root/ohm-fleet", "root")).toBe(false);
    expect(looksWorkerInaccessible("/root/ohm-fleet", undefined)).toBe(false);
  });

  it("does not flag a shared workspace path", () => {
    expect(looksWorkerInaccessible("/home/svcuser/fleet/ohm", "svcuser")).toBe(false);
  });
});

describe("issue #26: node-side cwd guard", () => {
  it("distinguishes ok / missing / notdir / denied", () => {
    expect(cwdGuardScript("/x")).toContain("FLEET_CWD=missing");
    expect(cwdGuardScript("/x")).toContain("FLEET_CWD=notdir");
    expect(cwdGuardScript("/x")).toContain("FLEET_CWD=denied");
    expect(cwdGuardScript("/x")).toContain("FLEET_CWD=ok");
  });

  it("wraps the guard as the worker principal when given one", () => {
    const cmd = cwdCheckCommand("/home/svcuser/fleet/ohm", "svcuser");
    expect(cmd).toContain("sudo -n -u 'svcuser'");
    expect(cmd).toContain("FLEET_CWD=ok");
  });

  it("runs bare when no service principal is configured", () => {
    const cmd = cwdCheckCommand("/tmp", undefined);
    expect(cmd).not.toContain("sudo");
    expect(cmd).toContain("FLEET_CWD=ok");
  });
});

describe("issue #26: cwd check evaluation", () => {
  it("passes on ok", () => {
    const r = evaluateCwdCheck("FLEET_CWD=ok", "/home/svcuser/fleet/ohm", "svcuser");
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
  });

  it("refuses with an actionable error naming a usable path", () => {
    const r = evaluateCwdCheck("FLEET_CWD=denied", "/root/ohm-fleet/ohm", "svcuser");
    expect(r.ok).toBe(false);
    expect(r.status).toBe("denied");
    expect(r.error).toMatch(/refusing to dispatch/);
    expect(r.error).toContain("/home/svcuser/fleet/your-repo");
  });

  it("refuses on missing and notdir", () => {
    expect(evaluateCwdCheck("FLEET_CWD=missing", "/nope", "svcuser").ok).toBe(false);
    expect(evaluateCwdCheck("FLEET_CWD=notdir", "/nope", "svcuser").ok).toBe(false);
  });

  it("fails closed when the status cannot be determined", () => {
    const r = evaluateCwdCheck("", "/somewhere", "svcuser");
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unknown");
  });
});

describe("issue #26: dispatch wiring", () => {
  it("validates the cwd BEFORE recording a run or dispatching", () => {
    expect(index).toContain("looksWorkerInaccessible");
    expect(index).toContain("cwdCheckCommand");
    expect(index).toContain("evaluateCwdCheck");
    // The guard must come before the ledger write (upsertRun at the dispatch site).
    const guardIdx = index.indexOf("evaluateCwdCheck(cwdOut, p.cwd, svcUser)");
    const ledgerIdx = index.indexOf("await upsertRun(rootDir, {");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(ledgerIdx).toBeGreaterThan(guardIdx);
  });

  it("returns ok:false with the error rather than dispatching", () => {
    expect(index).toContain("refusing to dispatch: cwd");
    expect(index).toContain("results[nodeKey] = { ok: false, error: cwdCheck.error }");
  });

  it("provision defaults its cwd when the caller omits it", () => {
    expect(index).toContain("const targetCwd = p.cwd ?? defaultFleetCwd(p.repo)");
  });
});
