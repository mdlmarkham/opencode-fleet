import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { isServiceUserName, ownershipProbeCommand, ownershipProbeScript, parseOwnership } from "./ownership.js";

const me = userInfo().username;
const run = (cmd: string): string => { try { return execFileSync("bash", ["-c", cmd], { encoding: "utf8" }); } catch (e) { return String((e as { stdout?: string }).stdout ?? ""); } };

function checkout(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet189-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "x");
  writeFileSync(join(dir, "docs", "b.md"), "y");
  writeFileSync(join(dir, ".git", "HEAD"), "ref");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("#189: ownership probe", () => {
  it("only well-formed service user names are accepted into the command", () => {
    expect(isServiceUserName("svcuser")).toBe(true);
    for (const bad of ["", "a b", "x;rm -rf /", "$(id)", "a".repeat(40), 5, undefined]) expect(isServiceUserName(bad), String(bad)).toBe(false);
    expect(ownershipProbeCommand("/w", "x;rm -rf /")).toBeUndefined();
    expect(ownershipProbeScript("/w", "x;rm -rf /")).toBeUndefined();
    // Same shape provisioning accepts: dotted and capitalised names are fine, a leading dash is not.
    for (const ok of ["deploy.bot", "SvcUser", "svc-user_1"]) expect(isServiceUserName(ok), ok).toBe(true);
    expect(isServiceUserName("-evil")).toBe(false);
  });

  it("a checkout owned by the service user reports clean (probe command run for real)", () => {
    const c = checkout();
    try {
      const r = parseOwnership(run(ownershipProbeScript(c.dir, me)!), me, c.dir);
      expect(r).toMatchObject({ ok: true, worktree: 0, git: 0 });
    } finally { c.cleanup(); }
  });

  it("paths owned by someone else are counted, split into worktree and .git, with a warning and the fix", () => {
    const c = checkout();
    try {
      let expectedOwner = me;
      let wtMin = 0;
      let gitMin = 0;
      if (me === "root") {
        // Running as root: hand some paths to another uid, then ask whether root-owned is what we expect.
        for (const f of ["a.txt", "docs", join("docs", "b.md"), join(".git", "HEAD")]) chownSync(join(c.dir, f), 65534, 65534);
        wtMin = 3; // a.txt, docs, docs/b.md
        gitMin = 1; // .git/HEAD
      } else {
        // Not root: every path is ours, so ask for `root` as the expected owner.
        expectedOwner = "root";
        wtMin = 4;
        gitMin = 3;
      }
      const r = parseOwnership(run(ownershipProbeScript(c.dir, expectedOwner)!), expectedOwner, c.dir);
      expect(r).toMatchObject({ ok: false });
      if ("worktree" in r) {
        expect(r.worktree).toBeGreaterThanOrEqual(wtMin);
        expect(r.git).toBeGreaterThanOrEqual(gitMin);
        expect(r.warning).toContain(`not owned by ${expectedOwner}`);
        expect(r.fix).toContain(`chown -R ${expectedOwner}:${expectedOwner}`);
      } else throw new Error("expected a report");
    } finally { c.cleanup(); }
  });

  it("an unknown service user is an error, never a clean 0", () => {
    const c = checkout();
    try {
      const out = run(ownershipProbeScript(c.dir, "no_such_user_zz")!);
      expect(parseOwnership(out, "no_such_user_zz", c.dir)).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
    } finally { c.cleanup(); }
  });

  it("a missing checkout or unparseable output is an error, never clean", () => {
    expect(parseOwnership(run(ownershipProbeScript("/nonexistent/fleet189", me)!), me, "/nonexistent")).toMatchObject({ ok: false, error: expect.any(String) });
    expect(parseOwnership("", me, "/w")).toMatchObject({ ok: false });
    expect(parseOwnership("garbage", me, "/w")).toMatchObject({ ok: false });
  });

  it("a path with spaces or a quote is handled (shell-quoted)", () => {
    const base = mkdtempSync(join(tmpdir(), "fleet189-"));
    const dir = join(base, "my repo's dir");
    try {
      mkdirSync(join(dir, ".git"), { recursive: true });
      expect(parseOwnership(run(ownershipProbeScript(dir, me)!), me, dir)).toMatchObject({ ok: true });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("#189 review: the probe runs as the service user and cannot read clean by accident", () => {
  it("the remote command runs the quoted script via sudo -n -u as the service principal", () => {
    const cmd = ownershipProbeCommand("/home/svc/it's repo", "svcuser")!;
    expect(cmd.startsWith("sudo -n -u 'svcuser' -H bash -c ")).toBe(true);
    expect(spawnSync("bash", ["-n", "-c", cmd]).status).toBe(0); // a quote-heavy cwd stays one well-formed command
  });
  it("a directory that is not a checkout is an error, not a clean 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet189-nogit-"));
    try {
      writeFileSync(join(dir, "a.txt"), "x");
      expect(parseOwnership(run(ownershipProbeScript(dir, me)!), me, dir)).toMatchObject({ ok: false, error: expect.stringContaining("not a checkout") });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a missing directory is its own error", () => {
    expect(parseOwnership(run(ownershipProbeScript("/nonexistent/fleet189", me)!), me, "/nonexistent/fleet189")).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
  });
});

import { afterEach } from "vitest";
import { loadEntry, loadPlugin, nodeReply, fakeSsh, type Loaded } from "./testkit/plugin.js";

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the fleet_cleanup ownership tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#189: fleet_cleanup reports ownership", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const inv = () => nodeReply({ ok: true, files: [] });
  const cfg = (extra: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: true, ...extra } } });

  it("poisoned checkout: counts, warning and fix are reported; nothing is changed", async () => {
    restore = fakeSsh("FLEET_OWN wt=27 git=314");
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ serviceUser: "svcuser" }), invoke: inv });
    const r = await p.call("fleet_cleanup", { cwd: "/home/svcuser/fleet/repo", pruneOlderThanDays: 0 });
    expect(r.dev2.ownership).toMatchObject({ ok: false, serviceUser: "svcuser", worktree: 27, git: 314 });
    expect(r.dev2.ownership.warning).toContain("docs/STAGING.md");
    expect(r.dev2.ownership.fix).toContain("chown -R svcuser:svcuser");
  });

  it("clean checkout reports ok", async () => {
    restore = fakeSsh("FLEET_OWN wt=0 git=0");
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ serviceUser: "svcuser" }), invoke: inv });
    expect((await p.call("fleet_cleanup", { cwd: "/w/repo", pruneOlderThanDays: 0 })).dev2.ownership).toMatchObject({ ok: true, worktree: 0, git: 0 });
  });

  it("only serviceUser counts: a login `user` alone is NOT treated as the worker (it is often root)", async () => {
    restore = fakeSsh("FLEET_OWN wt=0 git=0");
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ user: "root" }), invoke: inv });
    expect((await p.call("fleet_cleanup", { cwd: "/w/repo", pruneOlderThanDays: 0 })).dev2.ownership).toMatchObject({ ok: false, error: expect.stringContaining("no serviceUser") });
  });

  it("serviceUser is used, the probe runs BEFORE the gc, and the gc runs as the service user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet189-ssh-"));
    const log = join(dir, "cmds.log");
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s\\n' "$last" >> "${log}"\necho "FLEET_OWN wt=0 git=0"\n`, { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    restore = () => { process.env.PATH = prev; rmSync(dir, { recursive: true, force: true }); };
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ serviceUser: "svcuser", user: "root" }), invoke: inv });
    const r = await p.call("fleet_cleanup", { cwd: "/w/repo", pruneOlderThanDays: 0 });
    expect(r.dev2.ownership).toMatchObject({ ok: true, serviceUser: "svcuser" });
    const cmds = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const probe = cmds.findIndex((c) => c.includes("FLEET_OWN"));
    const gc = cmds.findIndex((c) => c.includes("git gc"));
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(gc).toBeGreaterThan(probe);
    expect(cmds[gc]).toContain("sudo -n -u 'svcuser'");
    expect(cmds[probe]).toContain("sudo -n -u 'svcuser'");
  });

  it("no service user configured, or no cwd: said plainly / not run", async () => {
    restore = fakeSsh("FLEET_OWN wt=0 git=0");
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg(), invoke: inv });
    expect((await p.call("fleet_cleanup", { cwd: "/w/repo", pruneOlderThanDays: 0 })).dev2.ownership).toMatchObject({ ok: false, error: expect.stringContaining("no serviceUser") });
    expect((await p.call("fleet_cleanup", { pruneOlderThanDays: 0 })).dev2.ownership).toBeUndefined();
  });

  it("an unparseable probe is an error, never reported as clean", async () => {
    restore = fakeSsh("something else entirely");
    p = loadPlugin(loaded!, { nodes: NODES, config: cfg({ serviceUser: "svcuser" }), invoke: inv });
    expect((await p.call("fleet_cleanup", { cwd: "/w/repo", pruneOlderThanDays: 0 })).dev2.ownership).toMatchObject({ ok: false });
  });
});
