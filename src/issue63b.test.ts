import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRemoteStageDir, remoteStageDirCmd } from "./provision.js";
import { shq } from "./shell.js";
import { fleetStateDir, stagePaths } from "./paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const provision = readFileSync(join(here, "provision.ts"), "utf8");

/** Minimal env so the emitted shell sees only what we intend. */
const shellEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  ...extra,
});

async function scratch<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "fleet63b-"));
  try {
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * Issue #63 (private staging): the SSH provisioning/sync path used to stage
 * node-side bundles in PUBLIC /tmp under predictable names (a fleet bundle
 * per transfer, plus a wildcard rm cleanup that could delete OTHER users'/runs'
 * files). Contract:
 *   1. bundles stage inside a per-run PRIVATE dir (0700) under the node's
 *      private state dir — the same `xfer-<id>` layout the channel path gets
 *      from paths.ts (fleetStateDir()/xferPaths()) — never in shared tmp;
 *   2. cleanup is a targeted rm of ONLY this run's dir (no wildcard sweep).
 */
describe("issue #63b: per-run private staging on the node", () => {
  it("stagePaths keeps bundles under the private state dir, named like the channel path", () => {
    const p = stagePaths("63b", "/home/u/.openclaw/fleet/state");
    expect(p.dir).toBe("/home/u/.openclaw/fleet/state/xfer-63b");
    expect(p.bundle).toBe(join(p.dir, "bundle"));
    expect(p.bundle.startsWith(p.dir + sep)).toBe(true);
    // Default root is the per-user private state dir (same dir fleetStateDir()
    // resolves), not a shared, predictable public path.
    const clean = stagePaths("63b", fleetStateDir({}));
    expect(clean.dir).toBe(join(fleetStateDir({}), "xfer-63b"));
    expect(clean.dir).toContain(join(".openclaw", "fleet", "state"));
    expect(clean.dir.includes("/fleet-")).toBe(false);
    // IDs cannot escape the state dir (validated like transferIds).
    expect(() => stagePaths("../etc", "/s")).toThrow(/invalid transferId/);
  });

  it("emits the exact staging shell: state-dir resolution, 0700 mkdir, resolved echo", () => {
    expect(remoteStageDirCmd("63bx")).toBe(
      'sd="${FLEET_STATE_DIR:-$HOME/.openclaw/fleet/state}" && d="$sd/xfer-63bx" && mkdir -p "$d" && chmod 700 "$sd" "$d" && printf \'%s\\n\' "$d"',
    );
    expect(() => remoteStageDirCmd("../x")).toThrow(/unsafe staging id/);
  });

  it("remoteStageDirCmd honors FLEET_STATE_DIR and matches stagePaths layout, 0700", async () => {
    await scratch(async (base) => {
      const out = execSync(remoteStageDirCmd("63bt"), { env: shellEnv({ FLEET_STATE_DIR: base }) }).toString();
      const dir = parseRemoteStageDir("63bt", out);
      // Shell layout === paths.ts helper layout, for both dir and bundle.
      expect(dir).toBe(stagePaths("63bt", base).dir);
      expect(`${dir}/bundle`).toBe(stagePaths("63bt", base).bundle);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      // The state root itself is tightened to 0700 as well.
      expect((await stat(base)).mode & 0o777).toBe(0o700);
    });
  });

  it("defaults to $HOME/.openclaw/fleet/state (the dir fleetStateDir resolves), not shared tmp", async () => {
    await scratch(async (base) => {
      const home = join(base, "home");
      await mkdir(home);
      const out = execSync(remoteStageDirCmd("63bd"), { env: shellEnv({ HOME: home }) }).toString();
      const dir = parseRemoteStageDir("63bd", out);
      expect(dir).toContain(join(".openclaw", "fleet", "state"));
      expect(dir.includes("/fleet-")).toBe(false);
      expect(dir).toBe(join(home, ".openclaw", "fleet", "state", "xfer-63bd"));
      expect(dir).toBe(stagePaths("63bd", join(home, ".openclaw", "fleet", "state")).dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    });
  });

  it("cleanup removes only this run's dir — sibling runs' staging survives", async () => {
    await scratch(async (base) => {
      // Another run's staged bundle, created BEFORE this run:
      const other = stagePaths("other", base);
      await mkdir(other.dir, { recursive: true, mode: 0o700 });
      await writeFile(other.bundle, "other-run-bundle");
      // This run stages (what provisioning does first):
      const out = execSync(remoteStageDirCmd("63bt"), { env: shellEnv({ FLEET_STATE_DIR: base }) }).toString();
      const mine = parseRemoteStageDir("63bt", out);
      await writeFile(join(mine, "bundle"), "this-run-bundle");
      // The per-run cleanup provisionToNode/syncFromNode run in their cleanup
      // paths — exactly this run's dir, nothing else:
      expect(provision).toContain("rm -rf ${shq(remoteStageDir)}");
      execSync(`rm -rf ${shq(mine)}`, { env: shellEnv() });
      expect(existsSync(mine)).toBe(false);
      expect(existsSync(other.bundle)).toBe(true);
      // And the old public staging + wildcard sweep are gone from the source.
      expect(provision).not.toContain("/tmp/fleet-");
      expect(provision).not.toContain("fleet-*.bundle");
    });
  });

  it("parseRemoteStageDir refuses anything but this run's private xfer dir", () => {
    expect(() => parseRemoteStageDir("63bt", "/tmp/fleet-63bt.bundle\n")).toThrow(/unexpected remote staging dir/);
    expect(() => parseRemoteStageDir("63bt", "rel/xfer-63bt\n")).toThrow(/unexpected remote staging dir/);
    expect(() => parseRemoteStageDir("63bt", "/state/xfer-nope\n")).toThrow(/unexpected remote staging dir/);
    expect(() => parseRemoteStageDir("63bt", "/state/xfer-63bt\n/state/xfer-63bt\n")).toThrow(/unexpected remote staging dir/);
    expect(parseRemoteStageDir("63bt", "/state/xfer-63bt\n")).toBe("/state/xfer-63bt");
    expect(() => parseRemoteStageDir("../x", "/state/xfer-x\n")).toThrow(/unsafe staging id/);
  });

  it("provision and sync stage via the private dir; transferId naming and channel contract intact", () => {
    // Both flows resolve/create the per-run private dir on the node first.
    expect(provision).toContain("remoteStageDirCmd(transferId)");
    expect(provision).toContain("remoteStageDirCmd(stageId)");
    expect(provision).toContain("const stageId = `sync-${Date.now()}`;");
    // scp ships into the private dir; the worker bundles inside it.
    expect(provision).toContain("scpPrefix(), bundlePath, scpRemote(nodeHost, remoteBundle)");
    expect(provision).toContain("git bundle create ${shq(remoteBundle)}");
    expect(provision).toContain("`${remoteStageDir}/bundle`");
    // transferId naming unchanged, channel fallback/receiver contract intact.
    expect(provision).toContain("const transferId = `${Date.now()}`;");
    expect(provision).toContain('"__RECEIVE_CLEAN__"');
    // Manager-side mkdtemp staging is untouched (only node-side changed).
    expect(provision).toContain('mkdtemp(join(tmpdir(), "fleet-provision-"))');
    expect(provision).toContain('mkdtemp(join(tmpdir(), "fleet-sync-"))');
  });
});