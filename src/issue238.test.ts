import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deployPlugin, validatePluginDir } from "./deploy.js";
import { gatewaySrc } from "./testkit/src.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Issue #238: fleet_deploy's build step ran `npm run build` with cwd = pluginDir, which for an
 * INSTALLED plugin defaults to the gateway's extensions root (/root/.openclaw/extensions) where no
 * package.json exists — every deploy died with a bare "build failed" / ENOENT instead of a precise
 * refusal, and the operator had no way to name the real repo checkout. The fix: validate the dir
 * BEFORE any npm call (precise error naming the path), and let an explicit `deploy.pluginDir`
 * config (or the `pluginDir` tool param) point at the repo checkout.
 */

describe("#238: validatePluginDir", () => {
  const dirs: string[] = [];
  beforeEach(() => { dirs.length = 0; });
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("a dir without package.json is refused, naming the path and the remedy", () => {
    const bad = mkdtempSync(join(tmpdir(), "fleet238-bad-"));
    dirs.push(bad);
    const v = validatePluginDir(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toContain(bad);
      expect(v.error).toContain("package.json");
      expect(v.error).toContain("deploy.pluginDir");
    }
  });

  it("a dir with package.json passes", () => {
    const good = mkdtempSync(join(tmpdir(), "fleet238-good-"));
    dirs.push(good);
    writeFileSync(join(good, "package.json"), "{}\n");
    expect(validatePluginDir(good).ok).toBe(true);
  });
});

describe("#238: deployPlugin refuses a non-repo pluginDir before build", () => {
  let bad: string;
  let goodButNotARepo: string;
  const dirs: string[] = [];
  beforeEach(() => {
    bad = mkdtempSync(join(tmpdir(), "fleet238-refuse-"));
    dirs.push(bad);
    goodButNotARepo = mkdtempSync(join(tmpdir(), "fleet238-good-"));
    dirs.push(goodButNotARepo);
    writeFileSync(join(goodButNotARepo, "package.json"), "{}\n");
  });
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("refuses before any npm run, with the precise error (never the bare 'build failed')", async () => {
    const r = await deployPlugin({ pluginDir: bad, nodes: [], restartNodes: false, selfCheck: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("package.json");
    expect(r.error).toContain(bad);
    const firstFail = r.steps.find((s) => !s.ok);
    expect(firstFail).toBeDefined();
    expect(firstFail!.step).not.toBe("build");
  });

  it("with no package.json the build step is never reached", async () => {
    const r = await deployPlugin({ pluginDir: bad, nodes: [], restartNodes: false, selfCheck: false });
    expect(r.steps.some((s) => s.step === "build")).toBe(false);
  });

  it("the derived default dir (no package.json) fails the same way — the tool's old default was the bug", async () => {
    // the installed plugin's dir .. IS the parent of a package-less root: same refusal
    const r = await deployPlugin({ pluginDir: dirname(bad), nodes: [], restartNodes: false, selfCheck: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("package.json");
  });

  it("the remedy is wired: the tool honors deploy.pluginDir config and the manifest allows it", () => {
    const src = gatewaySrc();
    expect(src).toContain("cfg.deploy?.pluginDir");
    const manifest = JSON.parse(readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8")) as {
      configSchema: { properties: Record<string, { properties?: Record<string, { type?: string }> }> };
    };
    const deploy = manifest.configSchema.properties.deploy;
    expect(deploy?.properties?.pluginDir?.type).toBe("string");
  });
});