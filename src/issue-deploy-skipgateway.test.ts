import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployPlugin } from "./deploy.js";

/**
 * Issue #255: fleet_deploy skipGateway. A node-only sync (nodes already
 * current) must not be held hostage by the gateway's install-gateway step:
 * with skipGateway the build + pack still run (nodes need the tarball) but
 * `openclaw plugins install` is never invoked locally; the step is reported
 * ok:true with detail 'skipped by request (skipGateway)' and
 * gatewayRestartRequired stays false. Default (no param) is unchanged: the
 * gateway install IS invoked.
 *
 * Drives the real deployPlugin with a temp plugin repo and fake `npm`,
 * `openclaw`, `ssh`, `scp` shims placed first on PATH (the established
 * fake-bin pattern from src/testkit/plugin.ts — no new harness). `openclaw`
 * appends every argv it is given to a log file, so a reverted skipGateway
 * branch (which invokes install-gateway unconditionally) makes the pin fail.
 */

const here = new URL(".", import.meta.url).pathname;

function makeShimDir(): { dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fleet255-shims-"));
  const log = join(dir, "openclaw-calls.log");
  // openclaw: never run for real; log argv so tests can pin invocation.
  const ocBin = join(dir, "openclaw");
  writeFileSync(ocBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(ocBin, 0o755);
  // npm: build writes a real (fake) tarball so per-node staging + hashing
  // succeed; pack emits the JSON `npm pack --json` prints.
  const repoRef = process.env.FLEET255_REPO ?? "";
  const npmBin = join(dir, "npm");
  writeFileSync(
    npmBin,
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '"run build") mkdir -p "$FLEET255_REPO/dist"; printf x > "$FLEET255_REPO/dist/index.js"; printf y > "$FLEET255_REPO/openclaw-plugin-opencode-fleet-0.1.0.tgz" ; exit 0 ;;',
      '"pack --json") printf \'%s\\n\' \'[{"filename":"openclaw-plugin-opencode-fleet-0.1.0.tgz"}]\' ; exit 0 ;;',
      "*)",
      "echo \"unexpected npm invocation: $*\" >&2",
      "exit 9 ;;",
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  // ssh: a real 64-hex sha reply for the remote `sha256sum` checksum (matched
  // against the manager-side sha256 of the fake tarball), a clean install
  // record, a HOME reply for the serviceUser, a real staging dir for the
  // mktemp probe, and FLEET_INSTALL_RC=0 for install commands.
  const sshBin = join(dir, "ssh");
  writeFileSync(
    sshBin,
    [
      "#!/bin/sh",
      'argv="$*"',
      'case "$argv" in',
      // Issue #281: the deploy now verifies a whole-dist CODE-TREE digest, not a
      // single index.js hash. Emulate it EXACTLY as build-provenance.treeDigest:
      // sort the .js paths, emit `path\\0sha\\0` per file, strip the trailing NUL
      // (`head -c -1`) so the payload has no final separator, then sha256 it.
      //
      // ORDER MATTERS: this arm MUST come before the `*"sha256sum --"*` arm. The
      // emitted verify script contains `sha256sum -- "$f"` INSIDE its text, so the
      // tarball-checksum glob would otherwise match it first and answer with a
      // tarball hash/MISSING, never reaching here (that ordering bug made #281's
      // first shim update fail for the wrong reason).
      "  *'*.js'*)",
      "    ROOT=\"$FLEET255_REPO/dist\"",
      "    if [ -d \"$ROOT\" ]; then",
      "      find \"$ROOT\" -type f -name '*.js' | LC_ALL=C sort | while IFS= read -r f; do h=$(/usr/bin/sha256sum -- \"$f\"); h=${h%% *}; printf '%s\\0%s\\0' \"${f#$ROOT/}\" \"$h\"; done | head -c -1 | /usr/bin/sha256sum | cut -d' ' -f1",
      "    else printf '%s\\n' MISSING; fi",
      "    ;;",
      '  *"sha256sum --"*)',
      "    p=$(printf '%s' \"$argv\" | awk -F\"'\" '{print $4}')",
      '    if [ -f "$p" ]; then exec sha256sum_real "$p"; fi',
      "    printf '%s\\n' MISSING",
      "    ;;",
      "  *installedIndex*) printf '%s\\n' '{\"present\": false}' ;;",
      // Issue #281: the deploy now verifies a whole-dist CODE-TREE digest, not a
      // single index.js hash. Emulate it EXACTLY as build-provenance.treeDigest:
      // sort the .js paths, emit `path\\0sha\\0` per file, strip the trailing NUL
      // (`head -c -1`) so the payload has no final separator, then sha256 it.
      // Match on the shq-escaped wire form: the emitted script reaches here as
      // `-name '\\''*.js'\\''` (shq inside a single-quoted bash -c), so match on the
      // stable `*.js` token rather than the surrounding quote style.
      "  *'*.js'*)",
      "    ROOT=\"$FLEET255_REPO/dist\"",
      "    if [ -d \"$ROOT\" ]; then",
      "      find \"$ROOT\" -type f -name '*.js' | LC_ALL=C sort | while IFS= read -r f; do h=$(/usr/bin/sha256sum -- \"$f\"); h=${h%% *}; printf '%s\\0%s\\0' \"${f#$ROOT/}\" \"$h\"; done | head -c -1 | /usr/bin/sha256sum | cut -d' ' -f1",
      "    else printf '%s\\n' MISSING; fi",
      "    ;;",
      "  *\"echo MISSING\"*) printf '%s\\n' 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881 ;;",
      "  *printf\\ %s*) printf '%s\\n' /home/fleet255-svc ;;",
      '  *"mktemp -d"*)',
      "    d=$(mktemp -d /tmp/fleet-deploy.XXXXXX)",
      '    chmod 711 "$d"',
      "    printf '%s\\n' \"FLEET_STAGE=$d\"",
      "    ;;",
      "  *)",
      "    printf '%s\\n' \"FLEET_INSTALL_RC=0\"",
      "    exit 0 ;;",
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const scpBin = join(dir, "scp");
  // scp [-opts] src host:path — the shim copies locally, stripping the host:
  // prefix from the destination operand.
  writeFileSync(
    scpBin,
    [
      "#!/bin/sh",
      "scpn=$#",
      "i=1",
      'for a in "$@"; do',
      '  if [ "$i" = "$((scpn-1))" ]; then scpsrc="$a"; fi',
      '  if [ "$i" = "$scpn" ]; then scpdst="$a"; fi',
      "  i=$((i+1))",
      "done",
      'cp -- "$scpsrc" "${scpdst#*:}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // sha256sum passthrough (renamed out of the PATH shadow): prints only the
  // hash field — the manager compares it with the remote checksum's first
  // field, and the fake build's content is 'x' for dist/index.js.
  writeFileSync(join(dir, "sha256sum_real"), "#!/bin/sh\n/usr/bin/sha256sum \"$@\" | cut -d' ' -f1\n", { mode: 0o755 });
  return {
    dir,
    calls: () => (existsNothrow(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l.length > 0) : []),
  };
}

function existsNothrow(p: string): boolean {
  try {
    return readFileSync(p, "utf8") !== undefined;
  } catch {
    return false;
  }
}

const REPO_FIXTURE = `{
  "name": "openclaw-plugin-opencode-fleet",
  "version": "0.1.0",
  "main": "dist/index.js",
  "type": "module"
}
`;

let dirs: string[] = [];
let prevPath = "";

beforeEach(() => {
  prevPath = process.env.PATH ?? "";
  dirs = [];
});

afterEach(() => {
  process.env.PATH = prevPath;
  delete process.env.FLEET255_REPO;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshPluginRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fleet255-repo-"));
  dirs.push(repo);
  writeFileSync(join(repo, "package.json"), REPO_FIXTURE);
  process.env.FLEET255_REPO = repo;
  return repo;
}

function withShimmedPath(): { restore: () => void; calls: () => string[] } {
  const shim = makeShimDir();
  dirs.push(shim.dir);
  process.env.PATH = `${shim.dir}:${prevPath}`;
  return { restore: () => void (process.env.PATH = prevPath), calls: shim.calls };
}

function baseReq(pluginDir: string) {
  return { pluginDir, nodes: ["node-a"], nodeUsers: { "node-a": "opworker" }, restartNodes: false, selfCheck: false };
}

describe("#255: deployPlugin with skipGateway:true", () => {
  it("skips the gateway install: openclaw plugins install is never invoked, step reported ok:true 'skipped by request (skipGateway)'", async () => {
    const shim = withShimmedPath();
    const r = await deployPlugin({ ...baseReq(freshPluginRepo()), skipGateway: true });
    expect(r.ok).toBe(true);
    expect(shim.calls().filter((c) => c.includes("plugins install"))).toEqual([]);
    const gw = r.steps.find((s) => s.step === "install-gateway");
    expect(gw).toBeDefined();
    expect(gw!.ok).toBe(true);
    expect(gw!.detail).toBe("skipped by request (skipGateway)");
  });

  it("build and pack still run (nodes need the tarball)", async () => {
    withShimmedPath();
    const repo = freshPluginRepo();
    const r = await deployPlugin({ ...baseReq(repo), skipGateway: true });
    expect(r.steps.find((s) => s.step === "build")?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === "pack")?.ok).toBe(true);
    expect(r.steps.find((s) => s.step === "pack")?.detail).toMatch(/\.tgz$/);
  });

  it("no gateway restart required", async () => {
    withShimmedPath();
    const r = await deployPlugin({ ...baseReq(freshPluginRepo()), skipGateway: true });
    expect(r.gatewayRestartRequired).toBe(false);
  });
});

describe("#255: deployPlugin default (no skipGateway) is unchanged", () => {
  it("invokes the gateway install step", async () => {
    const shim = withShimmedPath();
    const r = await deployPlugin(baseReq(freshPluginRepo()));
    expect(r.ok).toBe(true);
    const installCalls = shim.calls().filter((c) => c.includes("plugins install"));
    expect(installCalls.length).toBe(1);
    expect(installCalls[0]).toContain("plugins install");
    expect(installCalls[0]).toContain(".tgz");
    const gw = r.steps.find((s) => s.step === "install-gateway");
    expect(gw?.ok).toBe(true);
    expect(r.gatewayRestartRequired).toBe(true);
  });
});

/**
 * Anti-drift pins on the gateway wiring itself (testkit/src.ts source scan,
 * the established style for tool-level pins in this repo): the tool schema
 * declares skipGateway and threads it into deployPlugin. Red if the tool
 * drops the param — a skipGateway deploy request could then never reach the
 * behavior pinned above.
 */
describe("#255: fleet_deploy wiring", () => {
  it("the fleet_deploy schema declares skipGateway and passes it to deployPlugin", async () => {
    const { gatewaySrc } = await import("./testkit/src.js");
    const src = gatewaySrc();
    expect(src).toContain('name: "fleet_deploy"');
    expect(src).toContain("skipGateway");
    expect(src).toMatch(/skipGateway:\s*p\.skipGateway/);
  });
});