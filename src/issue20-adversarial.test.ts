/**
 * Adversarial probes for the #20 repair path.
 *
 * The happy path is proven. These target the cases a careful reviewer would
 * object to:
 *   A. HOME resolution returns garbage (MOTD/banner on stdout) -> must not
 *      repair against a bogus path.
 *   B. serviceHome has a trailing slash -> no double-slash in expected path.
 *   C. Record with installPath = "/" prefix collision: /home/svcuser2 must NOT
 *      be treated as under /home/svcuser.
 *   D. Install record where installPath is absent entirely -> not "stale"
 *      (nothing to correct), but nullFields may still trigger repair.
 *   E. installPath exactly equal to expected -> clean.
 *   F. installPath = "" (empty string) -> should be treated as stale/missing.
 *   G. Non-string null-ish values must not crash analysis.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeInstallRecord,
  repairedRecord,
  needsRepair,
  inspectScript,
  repairScript,
  type InstallRecord,
} from "./install-record.js";

describe("#20 adversarial: path-boundary correctness", () => {
  it("C. /home/svcuser2 is NOT under /home/svcuser (no prefix collision)", () => {
    const rec: InstallRecord = { installPath: "/home/svcuser2/.openclaw/extensions/opencode-fleet" };
    const f = analyzeInstallRecord(rec, "/home/svcuser");
    expect(f.stale).toBe(true); // different user's home -> foreign -> repair
  });

  it("B. trailing slash on serviceHome does not produce a double slash", () => {
    const rec: InstallRecord = { installPath: "/root/x" };
    const f1 = analyzeInstallRecord(rec, "/home/svcuser");
    const f2 = analyzeInstallRecord(rec, "/home/svcuser/");
    expect(f1.expectedInstallPath).toBe("/home/svcuser/.openclaw/extensions/opencode-fleet");
    expect(f2.expectedInstallPath).toBe(f1.expectedInstallPath);
    expect(f2.expectedInstallPath).not.toContain("//");
  });

  it("E. installPath equal to expected -> clean, no repair", () => {
    const rec: InstallRecord = { installPath: "/home/svcuser/.openclaw/extensions/opencode-fleet" };
    const f = analyzeInstallRecord(rec, "/home/svcuser");
    expect(f.stale).toBe(false);
    expect(needsRepair(f)).toBe(false);
  });

  it("F. empty-string installPath is stale", () => {
    const rec: InstallRecord = { installPath: "" };
    const f = analyzeInstallRecord(rec, "/home/svcuser");
    expect(f.stale).toBe(true);
    expect(needsRepair(f)).toBe(true);
  });

  it("D. absent installPath is not 'stale' (nothing to correct)", () => {
    const rec: InstallRecord = { source: "archive", version: "0.1.0" };
    const f = analyzeInstallRecord(rec, "/home/svcuser");
    expect(f.present).toBe(true);
    expect(f.stale).toBe(false);
    // no null fields either -> no repair
    expect(needsRepair(f)).toBe(false);
  });

  it("repair sets installPath even when it was absent", () => {
    const rec: InstallRecord = { source: "archive" };
    const out = repairedRecord(rec, "/home/svcuser");
    expect(out.installPath).toBe("/home/svcuser/.openclaw/extensions/opencode-fleet");
  });

  it("G. analysis tolerates odd value types without throwing", () => {
    // Deliberately violate the type at RUNTIME (the record comes from JSON on a
    // node, so a non-string is possible). Cast through unknown so this probe
    // itself compiles.
    const rec = { installPath: 42, sourcePath: null, weird: { a: 1 } } as unknown as InstallRecord;
    expect(() => analyzeInstallRecord(rec, "/home/svcuser")).not.toThrow();
    // installPath 42 is not a string -> treated as undefined -> not stale
    const f = analyzeInstallRecord(rec, "/home/svcuser");
    expect(f.stale).toBe(false);
    expect(f.nullFields).toContain("sourcePath");
  });
});

describe("#20 adversarial: script injection safety", () => {
  it("A. HOME is resolved via stdin heredoc, not interpolated into a shell string", () => {
    // The inspect/repair scripts must pass paths through JSON.stringify into a
    // python heredoc, so a hostile HOME cannot break out of the shell.
    const s = inspectScript("/home/svcuser");
    expect(s).toContain("python3 - <<'PY'");
    expect(s).toContain("json.dumps({\"present\"");
    // db path appears JSON-quoted (a string literal), not raw-interpolated
    expect(s).toContain(JSON.stringify("/home/svcuser/.openclaw/state/openclaw.sqlite"));
  });

  it("a HOME with a quote does not break out of the python string", () => {
    const evil = '/home/ev"il$(touch /tmp/pwned)';
    const s = inspectScript(evil);
    // JSON.stringify escapes the quote; the $(...) stays inside a JSON string
    expect(s).not.toContain('ev"il$(touch /tmp/pwned)"\n');
    expect(s).toContain('\\"il$(touch /tmp/pwned)');
  });

  it("repair script refuses to run when no row/record exists (no accidental write)", () => {
    const s = repairScript("/home/svcuser");
    expect(s).toContain('"error": "no installedIndex row"');
    expect(s).toContain('"error": "no managed record"');
  });
});
