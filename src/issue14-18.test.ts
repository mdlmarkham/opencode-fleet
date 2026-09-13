import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const provision = readFileSync(join(here, "provision.ts"), "utf8");
const deploy = readFileSync(join(here, "deploy.ts"), "utf8");
const membership = readFileSync(join(here, "membership.ts"), "utf8");

/**
 * Issue #14 regression guards.
 *
 * The bug: fleet_provision never normalized git's `safe.directory` for the
 * principal the manager actually lands as (root), while the checkout is owned
 * by the node's service user. git then refused with "dubious ownership"
 * (rc=128), surfacing later as an opaque `git status failed` in fleet_sync.
 *
 * Contract:
 *   1. provision sets safe.directory for the landing principal at provisioning
 *      time, at --system scope (covers whichever account the sync path uses).
 *   2. the fleet_sync tree-state check names the reason (dubious ownership)
 *      instead of returning a bare rc=128.
 */
describe("issue #14: safe.directory for the landing principal", () => {
  it("establishes safe.directory at provision time, at --system scope", () => {
    expect(provision).toContain("git config --system --add safe.directory");
    expect(provision).toContain("safeDirCmd");
    // Must be wired into the unpack chain, right after the clone.
    expect(provision).toContain("safeDirCmd,");
    expect(provision).toContain("---FLEET_SAFEDIR=ok");
  });

  it("names dubious ownership in the tree-state failure instead of a bare rc", () => {
    expect(provision).toContain("dubious ownership");
    expect(provision).toContain("git status refused on");
    // The actionable remedy must be in the message.
    expect(provision).toContain("git config --system --add safe.directory");
  });
});

/**
 * Issue #18 regression guards.
 *
 * The bug: fleet_deploy reported ok:true while the node install silently did
 * nothing. Three combined defects: (1) install targeted the SSH login principal
 * (root), not the service user; (2) `... 2>&1 | tail -2` masked the install's
 * exit status so the catch was unreachable; (3) nothing verified the installed
 * build, and `return { ok: true }` never aggregated per-node results.
 *
 * Contract:
 *   1. no formatter pipe stands in for the install's exit status
 *   2. the install runs as the node's service principal when configured
 *   3. the installed build is verified against the built artifact's hash
 *   4. `ok` is false if any node's install/verify/restart failed
 *   5. a node with no configured service principal is reported as unverified,
 *      never as a silent success
 */
describe("issue #18: fleet_deploy principal + verification + aggregation", () => {
  it("never pipes the node install through tail (defect 2)", () => {
    // The pipe must be gone from executable code. Strip comments first so an
    // explanatory comment mentioning the old pipe does not trip the guard.
    const code = deploy
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("| tail");
    // An explicit rc sentinel must gate the step.
    expect(deploy).toContain("FLEET_INSTALL_RC=$rc");
    expect(deploy).toContain("FLEET_INSTALL_RC=(-?\\d+)");
  });

  it("installs as the configured service principal (defect 1)", () => {
    expect(deploy).toContain("serviceUser");
    expect(deploy).toContain("sudo -n -u");
    expect(deploy).toContain("nodeUsers");
    // The unconfigured case must be reported as unverified, not success.
    expect(deploy).toContain("service principal unverified");
  });

  it("verifies the installed build against the built artifact (defect 3)", () => {
    expect(deploy).toContain("builtIndexHash");
    expect(deploy).toContain("sha256sum");
    expect(deploy).toContain("node is running stale code");
    expect(deploy).toContain("installed build not found");
  });

  it("aggregates per-node results into ok (defect 4)", () => {
    expect(deploy).toContain("anyNodeFailed");
    expect(deploy).toContain("const ok = gatewayOk && !anyNodeFailed");
    // The old constant-success return must be gone.
    expect(deploy).not.toContain("return { ok: true, steps, gatewayRestartRequired: true };");
  });

  it("threads the service principal through membership config", () => {
    expect(membership).toContain("serviceUser?: string");
    expect(membership).toContain("user?: string");
  });
});
