/**
 * Stale plugin-install-record repair (issue #20).
 *
 * A fleet node whose OpenClaw service runs as a NON-ROOT principal can carry a
 * managed plugin install record left from an era when installs ran as root:
 *
 *   DB:  ~/.openclaw/state/openclaw.sqlite
 *   Row: config_machine_state WHERE state_key='plugins.installedIndex'
 *   Field: installRecords['opencode-fleet'].installPath -> /root/.openclaw/...
 *
 * On the next non-root install the CLI's retire phase resolves that old path
 * and calls realpathSync('/root/.openclaw'), which fails EACCES because the
 * service user cannot traverse root's 0700 home. The command exits rc=1 even
 * though the install itself succeeded — a false-failure.
 *
 * This module detects that condition (AS THE SERVICE PRINCIPAL, because as root
 * the EACCES never appears and the bug is invisible), backs up the state DB,
 * and repairs the record so installs stop misreporting.
 *
 * It is deliberately side-effect-free until `repairStaleInstallRecord` is
 * called: detection returns a structured result and makes no changes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The plugin id whose install record we manage. */
export const MANAGED_PLUGIN_ID = "opencode-fleet";

/** A JSON value for one field of an install record. */
export type RecordFieldValue = string | number | boolean | null | string[] | undefined;

export interface InstallRecord {
  source?: string;
  spec?: string | null;
  sourcePath?: string | null;
  installPath?: string | null;
  version?: string | null;
  [key: string]: unknown;
}

/** Optional string fields in PluginInstallRecordSchema that reject JSON null. */
export const NULLABLE_STRING_FIELDS = [
  "sourcePath",
  "installPath",
  "spec",
  "version",
  "resolvedName",
  "resolvedVersion",
  "resolvedSpec",
  "integrity",
  "shasum",
  "resolvedAt",
  "installedAt",
  "clawhubUrl",
  "clawhubPackage",
  "clawhubFamily",
  "clawhubChannel",
  "clawhubTrustDisposition",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
  "artifactKind",
  "artifactFormat",
  "npmIntegrity",
  "npmShasum",
  "npmTarballName",
  "clawpackSha256",
  "clawpackManifestSha256",
  "gitUrl",
  "gitRef",
  "gitCommit",
  "marketplaceName",
  "marketplaceSource",
  "marketplacePlugin",
  "acceptedSurfaceHash",
  "acceptedSurfaceAt",
  "acceptedSurfaceIntegrity",
] as const;

export interface StaleRecordFinding {
  /** Whether a managed install record exists at all. */
  present: boolean;
  /** The installPath currently in the record, if any. */
  installPath?: string;
  /** True when installPath resolves outside the service user's own plugin root. */
  stale: boolean;
  /** The service user's expected plugin root, e.g. /home/svcuser/.openclaw/extensions/opencode-fleet. */
  expectedInstallPath: string;
  /** Optional string fields that are JSON null (schema rejects null; key must be absent). */
  nullFields: string[];
}

/**
 * Pure analysis of one install record. Kept separate from IO so it is unit
 * testable without a live node or database.
 *
 * @param record the parsed installRecords['opencode-fleet'] value (may be undefined)
 * @param serviceHome the service user's HOME, e.g. /home/svcuser
 */
export function analyzeInstallRecord(
  record: InstallRecord | undefined,
  serviceHome: string,
): StaleRecordFinding {
  const expectedInstallPath = `${serviceHome.replace(/\/+$/, "")}/.openclaw/extensions/${MANAGED_PLUGIN_ID}`;
  if (!record) {
    return { present: false, stale: false, expectedInstallPath, nullFields: [] };
  }
  const installPath = typeof record.installPath === "string" ? record.installPath : undefined;
  // Stale = the record points somewhere that is NOT under the service user's
  // own home. The classic case is /root/.openclaw, but any foreign root counts.
  const serviceHomeNormalized = serviceHome.replace(/\/+$/, "");
  const stale = installPath !== undefined && !installPath.startsWith(`${serviceHomeNormalized}/`);
  const nullFields = NULLABLE_STRING_FIELDS.filter((f) => record[f] === null) as unknown as string[];
  return { present: true, installPath, stale, expectedInstallPath, nullFields };
}

/**
 * Produce the repaired record: correct installPath and drop null-valued
 * optional string fields (the schema wants them ABSENT, not null).
 */
export function repairedRecord(
  record: InstallRecord,
  serviceHome: string,
): InstallRecord {
  const expectedInstallPath = `${serviceHome.replace(/\/+$/, "")}/.openclaw/extensions/${MANAGED_PLUGIN_ID}`;
  const out: InstallRecord = { ...record };
  out.installPath = expectedInstallPath;
  for (const field of NULLABLE_STRING_FIELDS) {
    if (out[field] === null) delete out[field];
  }
  return out;
}

/**
 * Whether a finding warrants a repair at all.
 */
export function needsRepair(finding: StaleRecordFinding): boolean {
  return finding.present && (finding.stale || finding.nullFields.length > 0);
}

/**
 * Shell script, run AS THE SERVICE PRINCIPAL, that reads the current install
 * record and prints a JSON object describing it. Uses python3 for reliable
 * JSON handling (the state value_json is a nested JSON document).
 *
 * Emits: {"present":bool,"installPath":str|null,"nullFields":[...]}
 * Exits non-zero only on an unexpected failure (missing DB is reported as
 * present:false, not an error).
 */
export function inspectScript(serviceHome: string, pluginId: string = MANAGED_PLUGIN_ID): string {
  const db = `${serviceHome.replace(/\/+$/, "")}/.openclaw/state/openclaw.sqlite`;
  const py = `
import sqlite3, json, sys
db = ${JSON.stringify(db)}
key = "plugins.installedIndex"
plugin = ${JSON.stringify(pluginId)}
try:
    con = sqlite3.connect(db)
    row = con.execute("SELECT value_json FROM config_machine_state WHERE state_key=?", (key,)).fetchone()
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(3)
if row is None:
    print(json.dumps({"present": False}))
    sys.exit(0)
try:
    doc = json.loads(row[0])
    rec = (doc.get("index", {}).get("installRecords", {}) or {}).get(plugin)
except Exception as e:
    print(json.dumps({"present": True, "error": "parse: " + str(e)}))
    sys.exit(4)
if rec is None:
    print(json.dumps({"present": False}))
    sys.exit(0)
nulls = [k for k, v in rec.items() if v is None]
print(json.dumps({"present": True, "installPath": rec.get("installPath"), "nullFields": nulls}))
`;
  return `python3 - <<'PY'\n${py}\nPY`;
}

/**
 * Shell script, run AS THE SERVICE PRINCIPAL, that:
 *   1. backs up the state DB,
 *   2. rewrites the record (correct installPath, drop null optional strings).
 *
 * Prints {"repaired":true,"backup":"<path>"} on success.
 * Refuses to touch the DB if the record is not present (nothing to repair).
 */
export function repairScript(serviceHome: string, pluginId: string = MANAGED_PLUGIN_ID): string {
  const db = `${serviceHome.replace(/\/+$/, "")}/.openclaw/state/openclaw.sqlite`;
  const expected = `${serviceHome.replace(/\/+$/, "")}/.openclaw/extensions/${pluginId}`;
  const py = `
import sqlite3, json, sys, time, shutil, os
db = ${JSON.stringify(db)}
expected = ${JSON.stringify(expected)}
key = "plugins.installedIndex"
plugin = ${JSON.stringify(pluginId)}
NULLABLE = set(${JSON.stringify([...NULLABLE_STRING_FIELDS])})
backup = db + ".bak-installrecord-" + time.strftime("%Y%m%d%H%M%S")
try:
    con = sqlite3.connect(db)
    row = con.execute("SELECT value_json FROM config_machine_state WHERE state_key=?", (key,)).fetchone()
except Exception as e:
    print(json.dumps({"repaired": False, "error": str(e)}))
    sys.exit(3)
if row is None:
    print(json.dumps({"repaired": False, "error": "no installedIndex row"}))
    sys.exit(0)
doc = json.loads(row[0])
rec = (doc.get("index", {}).get("installRecords", {}) or {}).get(plugin)
if rec is None:
    print(json.dumps({"repaired": False, "error": "no managed record"}))
    sys.exit(0)
# Back up before writing. Use sqlite backup API for a consistent copy.
try:
    bck = sqlite3.connect(backup)
    con.backup(bck)
    bck.close()
except Exception:
    try:
        shutil.copy2(db, backup)
    except Exception as e:
        print(json.dumps({"repaired": False, "error": "backup failed: " + str(e)}))
        sys.exit(5)
rec["installPath"] = expected
for k in list(rec.keys()):
    if rec[k] is None and k in NULLABLE:
        del rec[k]
doc["index"]["installRecords"][plugin] = rec
try:
    con.execute("UPDATE config_machine_state SET value_json=?, updated_at_ms=? WHERE state_key=?",
                (json.dumps(doc), int(time.time() * 1000), key))
    con.commit()
except Exception as e:
    print(json.dumps({"repaired": False, "error": "write failed: " + str(e)}))
    sys.exit(6)
print(json.dumps({"repaired": True, "backup": backup, "installPath": expected}))
`;
  return `python3 - <<'PY'\n${py}\nPY`;
}

export interface InspectResult extends StaleRecordFinding {
  /** Node-side error, if inspection itself failed. Detection failure must be surfaced, never guessed. */
  error?: string;
}

/**
 * Inspect the install record on a node, AS THE SERVICE PRINCIPAL.
 *
 * @param sshArgs  args to prepend (SSH_ARGS)
 * @param sshHost  host or user@host
 * @param serviceUser the principal the node service runs as; when absent we cannot
 *                    prove staleness (the check would be blind as root), so we
 *                    report a detection error rather than a false "clean".
 */
export async function inspectRemoteInstallRecord(
  sshArgs: string[],
  sshHost: string,
  serviceUser: string | undefined,
  serviceHome: string,
): Promise<InspectResult> {
  const base: StaleRecordFinding = { present: false, stale: false, expectedInstallPath: `${serviceHome.replace(/\/+$/, "")}/.openclaw/extensions/${MANAGED_PLUGIN_ID}`, nullFields: [] };
  if (!serviceUser) {
    // Cannot measure as the service principal -> say so. Do NOT guess "clean".
    return { ...base, error: "no serviceUser configured — cannot inspect as the service principal (would be blind as root)" };
  }
  const script = inspectScript(serviceHome);
  const cmd = `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(script)}`;
  let stdout = "";
  try {
    const r = await execFileP("ssh", [...sshArgs, sshHost, cmd], { timeout: 60_000 });
    stdout = r.stdout;
  } catch (e) {
    // Even on non-zero we may have JSON on stdout; try to use it.
    const anyErr = e as { stdout?: string; message?: string };
    stdout = anyErr.stdout ?? "";
    if (!stdout.trim()) {
      return { ...base, error: `inspection failed: ${anyErr.message ?? "no output"}` };
    }
  }
  const lastLine = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  let parsed: { present?: boolean; installPath?: string | null; nullFields?: string[]; error?: string };
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { ...base, error: `inspection returned unparseable output: ${lastLine.slice(0, 200)}` };
  }
  if (parsed.error) return { ...base, error: `inspection error: ${parsed.error}` };
  const record: InstallRecord | undefined = parsed.present
    ? { installPath: parsed.installPath ?? undefined }
    : undefined;
  // Recompute nullFields from the raw values the script reported (authoritative).
  const finding = analyzeInstallRecord(
    record ? { ...record, ...(parsed.nullFields ? Object.fromEntries(parsed.nullFields.map((f) => [f, null])) : {}) } : undefined,
    serviceHome,
  );
  return finding;
}

export interface RepairResult {
  repaired: boolean;
  backup?: string;
  error?: string;
}

/**
 * Repair the install record on a node, AS THE SERVICE PRINCIPAL, after backing
 * up the state DB. Only call after `inspectRemoteInstallRecord` reported a
 * problem (or call optimistically — it is a no-op when there is nothing to fix).
 */
export async function repairRemoteInstallRecord(
  sshArgs: string[],
  sshHost: string,
  serviceUser: string,
  serviceHome: string,
): Promise<RepairResult> {
  const script = repairScript(serviceHome);
  const cmd = `sudo -n -u ${shq(serviceUser)} -H bash -c ${shq(script)}`;
  try {
    const { stdout } = await execFileP("ssh", [...sshArgs, sshHost, cmd], { timeout: 60_000 });
    const lastLine = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    const parsed = JSON.parse(lastLine) as RepairResult;
    return parsed;
  } catch (e) {
    const anyErr = e as { stdout?: string; message?: string };
    const stdout = anyErr.stdout ?? "";
    const lastLine = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(lastLine) as RepairResult;
    } catch {
      return { repaired: false, error: anyErr.message ?? "repair failed" };
    }
  }
}

/** Quote a string for safe use as a single POSIX shell argument. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
