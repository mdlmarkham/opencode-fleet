import { describe, expect, it } from "vitest";
import { buildOpenCodeCommand } from "./opencode.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  defaultFleetCwd,
  looksWorkerInaccessible,
  cwdGuardScript,
  cwdCheckCommand,
  evaluateCwdCheck,
  resolveFleetRoot,
} from "./cwd.js";
import { gatewaySrc } from "./testkit/src.js";

const here = dirname(fileURLToPath(import.meta.url));
const index = gatewaySrc();

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
    const root = "/home/svcuser/fleet";
    const cwd = defaultFleetCwd("git@github.com:mdlmarkham/ohm.git", root);
    expect(cwd.startsWith(root)).toBe(true);
    expect(cwd).toBe("/home/svcuser/fleet/ohm");
    expect(cwd.startsWith("/root")).toBe(false);
  });

  it("sanitizes the repo name", () => {
    expect(defaultFleetCwd("https://example.com/org/my repo!", "/home/svcuser/fleet")).toBe("/home/svcuser/fleet/my-repo-");
    expect(defaultFleetCwd("simple", "/home/svcuser/fleet")).toBe("/home/svcuser/fleet/simple");
    expect(defaultFleetCwd("a/b/c/deep.git", "/home/svcuser/fleet")).toBe("/home/svcuser/fleet/deep");
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
    expect(index).toContain("const targetCwd = p.cwd ?? (fleetRoot ? defaultFleetCwd(p.repo, fleetRoot) : undefined)");
  });
});

describe("issue #44: fleet root is configuration, not a constant", () => {
  it("explicit fleetRoot wins", () => {
    expect(resolveFleetRoot({ fleetRoot: " /srv/work " }, ["a", "b"])).toBe("/srv/work");
  });
  it("derives /home/<user>/fleet only when every target shares one non-root service user", () => {
    expect(resolveFleetRoot({}, ["svc", "svc"])).toBe("/home/svc/fleet");
    expect(resolveFleetRoot({}, ["svc", "other"])).toBeUndefined();
    expect(resolveFleetRoot({}, ["svc", undefined])).toBeUndefined();
    expect(resolveFleetRoot({}, ["root"])).toBeUndefined();
    expect(resolveFleetRoot({}, [])).toBeUndefined();
  });
});

describe("issue #44: no deployment-specific literals in shipped code", () => {
  const read = (f: string) => (f === "index.ts" ? gatewaySrc() : readFileSync(join(here, f), "utf8"));
  it("the tailnet catalog host, Pi model and fleet root are not hardcoded", () => {
    for (const f of ["index.ts", "opencode.ts", "cwd.ts", "guard.ts", "membership.ts"]) {
      const src = read(f);
      expect(src, f).not.toContain("tailf9480");
      expect(src, f).not.toContain("aperture/glm-5.3-flash:cloud\";");
      expect(src, f).not.toMatch(/"\/home\/svcuser\/fleet"/);
    }
  });
  it("apertureUrl has no default in either config schema", () => {
    expect(read("index.ts")).not.toMatch(/apertureUrl: \{[^}]*\n\s+default:/);
    expect(readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8")).not.toContain("tailf9480");
  });
});

describe("issue #44: review follow-ups", () => {
  it("fleetRoot must be an absolute, non-root, '..'-free path", () => {
    for (const bad of ["fleet", "./fleet", "relative/path", "/", "//", "/a/../b", "/a\nb"]) {
      expect(() => resolveFleetRoot({ fleetRoot: bad }, []), bad).toThrow(/invalid fleetRoot/);
    }
    expect(resolveFleetRoot({ fleetRoot: "/srv/fleet/" }, [])).toBe("/srv/fleet");
  });
  it("a derived root needs a plausible username (no path tricks via serviceUser)", () => {
    expect(resolveFleetRoot({}, ["../etc"])).toBeUndefined();
    expect(resolveFleetRoot({}, ["a b"])).toBeUndefined();
    expect(resolveFleetRoot({}, ["svc.user-1"])).toBe("/home/svc.user-1/fleet");
  });
  it("a whitespace-only piModel is treated as missing everywhere", () => {
    expect(() => buildOpenCodeCommand({ prompt: "x", cwd: "/w", transport: "http", harness: "pi", piModel: "   " })).toThrow(/requires piModel/);
    expect(index).toContain('const clean = (v?: string) => v?.trim() || undefined;');
    expect(index).toMatch(/clean\(p\.piModel\) \?\? clean\(cfg\.piDefaultModel\)/);
  });
  it("provisioning derives the root from serviceUser falling back to user", () => {
    expect(index).toContain("m?.serviceUser ?? m?.user");
  });
});
