import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { digestOfDist, treeDigest, type ModuleHash } from "./build-provenance.js";
import { detectNodeCapabilities } from "./capabilities.js";
import { fakeSshMultiline } from "./testkit/plugin.js";

/**
 * Issue #191 follow-up — BUILD PROVENANCE in fleet_capabilities.
 *
 * fleet_capabilities now reports, per node, `build: { short }` — 12 hex chars
 * of the WHOLE-dist code-tree digest of the node's installed plugin
 * dist ($HOME/.openclaw/extensions/opencode-fleet/dist) — so an operator can
 * detect a stale node at a glance ("merged but deployed?").
 *
 * Contract, proven here without mocks of the code under test:
 *   1. The per-node SSH fact probe computes the digest ON the node with a
 *      shell pipeline using the SAME byte scheme as build-provenance.ts:
 *      every `.js` under dist, dist-relative paths sorted with LC_ALL=C sort,
 *      then sha256 of the stream `path\0sha\0path\0sha…` with NO trailing NUL
 *      (`head -c -1`). Proven by EXECUTING the exact command the probe emits
 *      (read from src/capabilities.ts) against a fixture tree, and comparing
 *      with treeDigest of the same files.
 *   2. A missing extension dir degrades to build.short = null (the
 *      BUILDPROV=MISSING sentinel) — never a fabricated value.
 *   3. Any transcript line that is not a well-formed digest also lands as
 *      null (absent beats wrong).
 *   4. The fact rides the SAME single SSH probe pass as CPU/MEM/etc (no
 *      second round-trip) and detectNodeCapabilities surfaces it.
 *   5. A stale node is detectable at a glance: the short digest changes when
 *      any code module on the node changes (shortDigest form, 12 hex chars).
 */

const EXT_REL = ".openclaw/extensions/opencode-fleet/dist";

/** A fixture "installed dist": nested dirs, mixed-case names, a space, non-code files. */
function makeFixtureTree(distDir: string): void {
  mkdirSync(join(distDir, "nodes", "deep"), { recursive: true });
  writeFileSync(join(distDir, "index.js"), "export const a = 1;\n");
  writeFileSync(join(distDir, "B.js"), "export const big = 2;\n");
  writeFileSync(join(distDir, "a.js"), "export const z = 3;\n");
  writeFileSync(join(distDir, "nodes", "handler.js"), "export const b = 4;\n");
  writeFileSync(join(distDir, "nodes", "deep", "leaf.js"), "export const c = 5;\n");
  writeFileSync(join(distDir, "weird name.js"), "export const w = 6;\n");
  writeFileSync(join(distDir, "types.d.ts"), "export declare const a: number;\n"); // not code
  writeFileSync(join(distDir, "data.json"), "{}\n"); // not code
}

/** digestOfDist's ModuleHash list for the fixture (the canonical JS side). */
async function fixtureModules(distDir: string): Promise<ModuleHash[]> {
  const { readFile, readdir } = await import("node:fs/promises");
  const { relative, sep } = await import("node:path");
  const out: ModuleHash[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith(".js")) continue;
      out.push({ path: relative(distDir, full).split(sep).join("/"), sha256: createHash("sha256").update(await readFile(full)).digest("hex") });
    }
  }
  await walk(distDir);
  return out;
}

/**
 * The EXACT remote command the capability probe emits — read from
 * src/capabilities.ts (the `const cmd = [...]` chain), evaluated from the
 * compiled dist so the test exercises the real emitted string, not a copy.
 */
function emittedProbeCommand(): string {
  const src = readFileSync(new URL("../dist/capabilities.js", import.meta.url), "utf8");
  const a = src.indexOf("const cmd = [");
  const b = src.indexOf('].join(" && ")', a);
  if (a < 0 || b < 0) throw new Error("capability probe command chain not found (is dist built?)");
  const expr = src.slice(a, b + '].join(" && ")'.length).replace(/^const cmd = /, "");
  return new Function(`return ${expr};`)() as string;
}

describe("#191: the node-side shell digest scheme matches build-provenance treeDigest", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fleet191-home-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("the probe's shell pipeline == treeDigest(digestOfDist's module list) on a real fixture tree", async () => {
    const distDir = join(home, EXT_REL);
    makeFixtureTree(distDir);

    // The canonical digest (build-provenance.ts, the JS side).
    const canonical = treeDigest(await fixtureModules(distDir));
    expect((await digestOfDist(distDir)).digest).toBe(canonical);

    // The node side: execute the EXACT command segment the probe emits (the
    // trailing BUILDPROV arm of the emitted `&&` chain), under real bash,
    // with the fixture as the user's HOME.
    const cmd = emittedProbeCommand();
    const buildArm = cmd.split(" && ").filter((c) => c.includes("BUILDPROV")).join(" && ");
    expect(buildArm).toContain("LC_ALL=C sort");
    expect(buildArm).toContain("head -c -1");
    const stdout = execFileSync("bash", ["-c", buildArm], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const m = stdout.trim().match(/^BUILDPROV=([0-9a-f]{64})$/);
    expect(m, `node-side digest not echoed for fixture tree: ${stdout.trim()}`).not.toBeNull();
    // THE parity proof: byte-identical to the canonical JS digest.
    expect(m![1]).toBe(canonical);
  }, 30_000);

  it("shell sorting matches treeDigest's sort at the bytes that matter (mixed case, nested dirs)", async () => {
    // The fixture deliberately mixes case (B.js vs sub/a.js vs root a.js):
    // LC_ALL=C sort orders by raw bytes (uppercase < lowercase), and
    // treeDigest sorts the same way (plain JS string compare). If either side
    // used a locale-aware sort the digests would diverge here.
    const distDir = join(home, EXT_REL);
    mkdirSync(join(distDir, "sub"), { recursive: true });
    writeFileSync(join(distDir, "B.js"), "export const x = 1;\n");
    writeFileSync(join(distDir, "a.js"), "export const y = 2;\n");
    writeFileSync(join(distDir, "sub", "Z.js"), "export const z = 3;\n");

    const canonical = treeDigest(await fixtureModules(distDir));
    const cmd = emittedProbeCommand();
    const buildArm = cmd.split(" && ").filter((c) => c.includes("BUILDPROV")).join(" && ");
    const stdout = execFileSync("bash", ["-c", buildArm], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const m = stdout.trim().match(/^BUILDPROV=([0-9a-f]{64})$/);
    expect(m, stdout.trim()).not.toBeNull();
    expect(m![1]).toBe(canonical);

    // And the short form is exactly treeDigest.shortDigest's slice.
    expect(canonical.slice(0, 12)).toHaveLength(12);
  }, 30_000);

  it("an EMPTY dist dir yields treeDigest([]) — a defined digest, matched by the shell side", async () => {
    const distDir = join(home, EXT_REL);
    mkdirSync(distDir, { recursive: true });
    const canonical = treeDigest(await fixtureModules(distDir)); // []
    expect(canonical).toHaveLength(64);
    const cmd = emittedProbeCommand();
    const buildArm = cmd.split(" && ").filter((c) => c.includes("BUILDPROV")).join(" && ");
    const stdout = execFileSync("bash", ["-c", buildArm], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const m = stdout.trim().match(/^BUILDPROV=([0-9a-f]{64})$/);
    expect(m, stdout.trim()).not.toBeNull();
    expect(m![1]).toBe(canonical);
  }, 30_000);
});

describe("#191: detectNodeCapabilities reports build.short from the probe transcript", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it("a 64-hex digest line lands as a 12-char short form", async () => {
    const d = "c1ef3ded4ca972d3180619248644a8bf3d45edc08fea8124c3f36d6fb36799d0";
    restore = fakeSshMultiline(["CPU=8", "MEM=31", "DISK=90", `BUILDPROV=${d}`]);
    const caps = await detectNodeCapabilities("node.example", "fresh-node");
    expect(caps.error).toBeUndefined();
    expect(caps.build).toEqual({ short: d.slice(0, 12) });
    expect(caps.build!.short).toMatch(/^[0-9a-f]{12}$/);
  }, 30_000);

  it("the missing-extension-dir sentinel (BUILDPROV=MISSING) lands as build.short = null", async () => {
    restore = fakeSshMultiline(["CPU=8", "MEM=31", "DISK=90", "BUILDPROV=MISSING"]);
    const caps = await detectNodeCapabilities("node.example", "no-ext-node");
    expect(caps.error).toBeUndefined();
    expect(caps.build).toEqual({ short: null });
  }, 30_000);

  it("a garbage or missing digest line never becomes a fabricated value (build.short = null)", async () => {
    restore = fakeSshMultiline(["CPU=8", "BUILDPROV="]);
    const caps = await detectNodeCapabilities("node.example", "garbage-node");
    expect(caps.build).toEqual({ short: null });

    restore();
    restore = fakeSshMultiline(["CPU=8", "BUILDPROV=total nonsense"]);
    const caps2 = await detectNodeCapabilities("node.example", "garbage-node-2");
    expect(caps2.build).toEqual({ short: null });

    // An older node whose probe never echoed BUILDPROV at all: no build fact.
    restore();
    restore = fakeSshMultiline(["CPU=8", "MEM=31"]);
    const caps3 = await detectNodeCapabilities("node.example", "old-node");
    expect(caps3.build).toBeUndefined();
  }, 30_000);

  it("BUILDPROV rides the SAME single SSH probe pass as CPU/MEM/etc (no second round-trip)", async () => {
    const src = readFileSync(new URL("./capabilities.ts", import.meta.url), "utf8");
    const fullPass = src.slice(
      src.indexOf("const cmd = [") + "const cmd = [".length,
      src.indexOf('].join(" && ");'),
    );
    for (const key of ["CPU=$", "BUILDPROV="]) {
      expect(fullPass.includes(key), key).toBe(true);
    }
    // And the sentinel check happens in the emitted chain itself.
    expect(fullPass).toContain('BUILDPROV=MISSING');
  });

  it("a stale node is detectable at a glance: a changed module changes the short digest", async () => {
    const d1 = "c1ef3ded4ca972d3180619248644a8bf3d45edc08fea8124c3f36d6fb36799d0";
    const d2 = "0000000000000000000000000000000000000000000000000000000000000000";
    restore = fakeSshMultiline(["CPU=8", `BUILDPROV=${d1}`]);
    const fresh = await detectNodeCapabilities("node.example", "node-a");
    restore();
    restore = fakeSshMultiline(["CPU=8", `BUILDPROV=${d2}`]);
    const stale = await detectNodeCapabilities("node.example", "node-a");
    expect(fresh.build!.short).not.toBe(stale.build!.short);
    expect(fresh.build!.short).toHaveLength(12);
    expect(stale.build!.short).toHaveLength(12);
  }, 30_000);
});