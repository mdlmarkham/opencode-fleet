import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeInstallRecord,
  repairedRecord,
  needsRepair,
  inspectScript,
  repairScript,
  NULLABLE_STRING_FIELDS,
  MANAGED_PLUGIN_ID,
  type InstallRecord,
} from "./install-record.js";

const here = dirname(fileURLToPath(import.meta.url));
const deploy = readFileSync(join(here, "deploy.ts"), "utf8");

/**
 * Issue #20 regression guards.
 *
 * The bug: a node that once installed the plugin AS ROOT carries a managed
 * install record whose installPath is under /root. A later NON-ROOT install
 * makes the CLI's retire phase call realpathSync('/root/.openclaw') -> EACCES
 * (the service user cannot traverse root's 0700 home), so the command exits
 * rc=1 even though the install itself SUCCEEDED. A check that cannot measure
 * reported a failure verdict — the false-negative-as-success pattern in the
 * benign direction.
 *
 * Contract:
 *   1. Detection identifies an installPath outside the service user's home as
 *      stale, and JSON-null optional string fields as invalid.
 *   2. Repair corrects installPath and DROPS null optional fields (the schema
 *      wants them absent, not null — null fails validation where absence passes).
 *   3. Detection runs AS THE SERVICE PRINCIPAL; with no serviceUser we report a
 *      detection error, never a false "clean".
 *   4. deploy wires the check in BEFORE the install and reports honestly.
 */
describe("issue #20: stale install-record detection", () => {
  const HOME = "/home/svcuser";

  it("flags a root-owned installPath as stale", () => {
    const rec: InstallRecord = { source: "path", installPath: "/root/.openclaw/extensions/opencode-fleet" };
    const f = analyzeInstallRecord(rec, HOME);
    expect(f.present).toBe(true);
    expect(f.stale).toBe(true);
    expect(f.expectedInstallPath).toBe("/home/svcuser/.openclaw/extensions/opencode-fleet");
    expect(needsRepair(f)).toBe(true);
  });

  it("does NOT flag an installPath already under the service home", () => {
    const rec: InstallRecord = { source: "path", installPath: `${HOME}/.openclaw/extensions/opencode-fleet` };
    const f = analyzeInstallRecord(rec, HOME);
    expect(f.present).toBe(true);
    expect(f.stale).toBe(false);
    expect(needsRepair(f)).toBe(false);
  });

  it("flags JSON-null optional string fields even when installPath is fine", () => {
    const rec: InstallRecord = {
      source: "path",
      installPath: `${HOME}/.openclaw/extensions/opencode-fleet`,
      sourcePath: null,
    };
    const f = analyzeInstallRecord(rec, HOME);
    expect(f.stale).toBe(false);
    expect(f.nullFields).toContain("sourcePath");
    expect(needsRepair(f)).toBe(true);
  });

  it("reports absent when there is no record (clean node)", () => {
    const f = analyzeInstallRecord(undefined, HOME);
    expect(f.present).toBe(false);
    expect(needsRepair(f)).toBe(false);
  });
});

describe("issue #20: repair normalizes the record", () => {
  const HOME = "/hosthome/bob"; // non-standard home: must not be assumed /home/<user>

  it("corrects installPath to the service user's own plugin root", () => {
    const rec: InstallRecord = { source: "path", installPath: "/root/.openclaw/extensions/opencode-fleet" };
    const out = repairedRecord(rec, HOME);
    expect(out.installPath).toBe("/hosthome/bob/.openclaw/extensions/opencode-fleet");
  });

  it("DELETES null optional fields (key absent, not null)", () => {
    const rec: InstallRecord = {
      source: "path",
      installPath: "/root/x",
      sourcePath: null,
      resolvedAt: null,
    };
    const out = repairedRecord(rec, HOME);
    expect("sourcePath" in out).toBe(false);
    expect("resolvedAt" in out).toBe(false);
    // A non-null value on an optional field survives.
    expect(out.installPath).toBe("/hosthome/bob/.openclaw/extensions/opencode-fleet");
  });

  it("keeps non-null optional fields intact", () => {
    const rec: InstallRecord = { source: "path", version: "0.1.0", installPath: "/root/x" };
    const out = repairedRecord(rec, HOME);
    expect(out.version).toBe("0.1.0");
    expect(out.source).toBe("path");
  });

  it("the null-field list covers sourcePath and installPath (the two we hit live)", () => {
    expect(NULLABLE_STRING_FIELDS).toContain("sourcePath");
    expect(NULLABLE_STRING_FIELDS).toContain("installPath");
  });
});

describe("issue #20: scripts are principal-scoped and non-destructive", () => {
  it("inspect script reads the installedIndex row and reports null fields", () => {
    const s = inspectScript("/home/svcuser");
    expect(s).toContain("config_machine_state");
    expect(s).toContain("plugins.installedIndex");
    expect(s).toContain(MANAGED_PLUGIN_ID);
    expect(s).toContain("nullFields");
    // Missing DB is reported, not crashed as a hard error.
    expect(s).toContain('"present": False');
  });

  it("repair script backs up the DB before writing", () => {
    const s = repairScript("/home/svcuser");
    expect(s).toContain("bak-installrecord-");
    expect(s).toContain(".backup("); // sqlite consistent backup
    expect(s).toContain("UPDATE config_machine_state");
    expect(s).toContain("del rec[k]"); // drop null fields
  });
});

describe("issue #20: deploy wiring", () => {
  it("checks the record before installing, as the service principal", () => {
    expect(deploy).toContain("inspectRemoteInstallRecord");
    expect(deploy).toContain("repairRemoteInstallRecord");
    expect(deploy).toContain("needsRepair");
    // The check must precede the install (scp/install), so the record is
    // repaired before the CLI's retire phase would EACCES on it.
    const checkIdx = deploy.indexOf("inspectRemoteInstallRecord");
    const installIdx = deploy.indexOf("FLEET_INSTALL_RC");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(checkIdx);
  });

  it("surfaces a detection failure as ok:false, never a silent clean", () => {
    expect(deploy).toContain("could not resolve");
    expect(deploy).toContain("finding.error");
  });

  it("reports that a repair happened, with the backup path", () => {
    expect(deploy).toContain("record-repair-");
    expect(deploy).toContain("backup ${repaired.backup}");
  });
});
