/**
 * Issue #152 regression guards.
 *
 * The bug: `git clone <bundle>` leaves the node checkout's `origin` pointing
 * at the TRANSIENT staging bundle (…/state/xfer-<id>/bundle) that the manager
 * deletes right after provisioning. Every later `git fetch`/`pull` on the node
 * then failed with "does not appear to be a git repository"; the node silently
 * ran against a stale base with no usable upstream.
 *
 * Contract:
 *   1. the provision unpack path rewrites `origin` to the manager's known
 *      stable repo URL (or the issue-#152 placeholder) right after the bundle
 *      clone — a transient `xfer-*` bundle path is NEVER persisted;
 *   2. a preflight detects a transient/unfetchable origin and repairs or
 *      reports it (an unfetchable origin is never silently ignored);
 *   3. a checkout whose origin is already stable/real is left untouched.
 *
 * Every behavioral test drives REAL git against throwaway repos under the OS
 * temp dir (mkdtemp) — never inside this repo checkout.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNSET_ORIGIN_PLACEHOLDER,
  checkOriginReachable,
  isTransientGitPath,
  originPreflightCommand,
  parseOriginPreflight,
  parseStableOriginSentinel,
  provisionToNode,
  stableOriginCommand,
  stableOriginFor,
} from "./provision.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("issue #152: transient-origin detection and stable-origin selection (pure helpers)", () => {
  it("isTransientGitPath matches the xfer staging layouts only", () => {
    // The exact shape from the issue report: node-side private staging.
    expect(isTransientGitPath("/root/.openclaw/fleet/state/xfer-1791135203283/bundle")).toBe(true);
    expect(isTransientGitPath("/home/u/.openclaw/fleet/state/xfer-sync-123/bundle.git")).toBe(true);
    // The channel-path accumulation bundle shape.
    expect(isTransientGitPath("/root/.openclaw/fleet/state/xfer-42.bundle")).toBe(true);
    // Real repo URLs and ordinary paths are NOT transient.
    expect(isTransientGitPath("https://github.com/o/r.git")).toBe(false);
    expect(isTransientGitPath("/srv/repo")).toBe(false);
    // Near-misses must not match.
    expect(isTransientGitPath("/srv/xfer-1/bundlex")).toBe(false);
    expect(isTransientGitPath("/srv/xfer-1.tar.bundle-old")).toBe(false);
    expect(isTransientGitPath("")).toBe(false);
  });

  it("stableOriginFor yields a stable repo URL and refuses transient paths", () => {
    expect(stableOriginFor("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
    // GitHub shorthand normalizes to the HTTPS URL (stable, fetchable later).
    expect(stableOriginFor("org/repo")).toBe("https://github.com/org/repo.git");
    // A transient staging path is never a stable origin.
    expect(stableOriginFor("/root/.openclaw/fleet/state/xfer-1/bundle")).toBeUndefined();
    expect(stableOriginFor("/root/.openclaw/fleet/state/xfer-1.bundle")).toBeUndefined();
    expect(stableOriginFor("   ")).toBeUndefined();
  });

  it("stableOriginCommand rewrites (or adds) origin and installs the placeholder when no URL is known", () => {
    const cmd = stableOriginCommand("/srv/checkout", "https://github.com/org/repo.git");
    expect(cmd).toContain("git remote set-url origin 'https://github.com/org/repo.git'");
    expect(cmd).toContain("|| git remote add origin 'https://github.com/org/repo.git'");
    // The effective URL rides a sentinel so it never pollutes stdout parsed
    // downstream (e.g. the unpack chain's commit SHA).
    expect(cmd).toContain("---FLEET_STABLE_ORIGIN=$(git remote get-url origin 2>/dev/null)");
    // No stable URL: the placeholder (never a transient path).
    const unset = stableOriginCommand("/srv/checkout");
    expect(unset).toContain(UNSET_ORIGIN_PLACEHOLDER);
    expect(isTransientGitPath(UNSET_ORIGIN_PLACEHOLDER)).toBe(false);
    // Values are shell-quoted (injection-safe).
    expect(stableOriginCommand("/srv/o'; rm -rf /", "https://x/y")).toContain("'https://x/y'");
    // Sentinel parsing: the URL value, not the surrounding text.
    expect(parseStableOriginSentinel("---FLEET_STABLE_ORIGIN=https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(parseStableOriginSentinel("noise\n---FLEET_STABLE_ORIGIN=/srv/repo\n")).toBe("/srv/repo");
    expect(parseStableOriginSentinel("---FLEET_STABLE_ORIGIN=")).toBeNull();
    expect(parseStableOriginSentinel("nothing here")).toBeNull();
  });

  it("the preflight command reads the origin URL and probes fetchability", () => {
    const cmd = originPreflightCommand("/srv/checkout");
    expect(cmd).toContain("cd '/srv/checkout'");
    expect(cmd).toContain("git remote get-url origin");
    expect(cmd).toContain("git ls-remote origin");
    expect(cmd).toContain("---FLEET_ORIGIN=");
    expect(cmd).toContain("---FLEET_ORIGIN_RC=");
  });

  it("parses the node sentinels: fetchable, unfetchable, absent", () => {
    const ok = parseOriginPreflight("---FLEET_ORIGIN=https://github.com/org/repo.git\n---FLEET_ORIGIN_RC=0");
    expect(ok).toEqual({ origin: "https://github.com/org/repo.git", fetchable: true, transient: false });
    const dead = parseOriginPreflight("---FLEET_ORIGIN=/root/.openclaw/fleet/state/xfer-1/bundle\n---FLEET_ORIGIN_RC=128");
    expect(dead.transient).toBe(true);
    expect(dead.fetchable).toBe(false);
    const none = parseOriginPreflight("---FLEET_ORIGIN=\n---FLEET_ORIGIN_RC=none");
    expect(none).toEqual({ origin: "", fetchable: null, transient: false });
  });

  it("the provisioned unpack chain runs the origin repair right after the bundle clone", () => {
    const provision = readFileSync(join(here, "provision.ts"), "utf8");
    // The repair must sit AFTER the bundle clone inside unpackCmd.
    const cloneIx = provision.indexOf("`git clone -q ${shq(remoteBundle)} ${shq(req.cwd)}`");
    const repairIx = provision.indexOf("stableOriginCommand(req.cwd, stableOrigin)");
    expect(cloneIx).toBeGreaterThan(-1);
    expect(repairIx).toBeGreaterThan(cloneIx);
    // And the channel unpack call carries the stable origin to the node op.
    expect(provision).toContain("stableOrigin }");
  });

  it("the node-channel __UNPACK__ op applies the same repair (no transient origin survives)", () => {
    const handler = readFileSync(join(here, "node", "handler.ts"), "utf8");
    const unpackIx = handler.indexOf("OPS[\"xfer.unpack\"]");
    expect(unpackIx).toBeGreaterThan(-1);
    const section = handler.slice(unpackIx, unpackIx + 3500);
    const cloneIx = section.indexOf("`git clone -q ${shq(bundlePath)} ${shq(task.cwd)}`");
    expect(cloneIx).toBeGreaterThan(-1);
    const repairIx = section.indexOf("stableOriginCommand(task.cwd");
    expect(repairIx).toBeGreaterThan(cloneIx);
  });

  it("fleet_sync runs the preflight before node reads and repairs a transient origin", () => {
    const provision = readFileSync(join(here, "provision.ts"), "utf8");
    // The preflight runs inside the SSH sync path BEFORE the working-tree
    // detection, and a detected transient origin is repaired to the stable URL.
    const syncIx = provision.indexOf("export async function syncFromNode");
    expect(syncIx).toBeGreaterThan(-1);
    const syncSection = provision.slice(syncIx);
    const preIx = syncSection.indexOf("originPreflightCommand(cwd)");
    const statusIx = syncSection.indexOf("git status --porcelain");
    expect(preIx).toBeGreaterThan(-1);
    expect(statusIx).toBeGreaterThan(preIx);
    expect(syncSection).toContain("originRepairedTo");
    expect(syncSection).toContain("stableOriginCommand(cwd, stable)");
  });
});

describe("issue #152: repair shell is correct against real git (local repos)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fleet152sh-")); dirs.push(d); return d; };
  afterEach(() => {
    for (const d of dirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
  });
  const extractOrigin = (repoPath: string): string =>
    execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();

  it("set-url path: after a bundle clone, origin is repointed to the stable repo (fetch succeeds)", () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const seed = join(base, "seed");
    git(base, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "f.txt"), "x\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    // Stage the bundle at the transient shape the manager really uses.
    const stage = join(base, "state", "xfer-777");
    mkdirSync(stage, { recursive: true });
    const bundle = join(stage, "bundle");
    git(seed, "bundle", "create", bundle, "--all");
    const node = join(base, "node");
    execFileSync("git", ["clone", "-q", bundle, node], { encoding: "utf8" });
    // Bug reproduced: origin IS the transient staging path.
    expect(extractOrigin(node)).toBe(bundle);
    expect(isTransientGitPath(extractOrigin(node))).toBe(true);
    execFileSync("git", ["-C", node, "ls-remote", "origin"], { encoding: "utf8" }); // still works NOW…

    // …the repair the manager emits:
    execFileSync("/bin/sh", ["-c", stableOriginCommand(node, originGit)], { encoding: "utf8" });
    // After staging cleanup the stable origin must still fetch.
    rmSync(stage, { recursive: true, force: true });
    expect(extractOrigin(node)).toBe(originGit);
    execFileSync("git", ["-C", node, "ls-remote", "origin"], { encoding: "utf8" }); // …and still works AFTER
  });

  it("add-origin path: repairs a checkout that has no origin remote at all", () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const node = join(base, "node");
    git(base, "init", "-q", node);
    writeFileSync(join(node, "f.txt"), "x\n");
    git(node, "add", "-A");
    git(node, "commit", "-q", "-m", "init");
    execFileSync("/bin/sh", ["-c", stableOriginCommand(node, originGit)], { encoding: "utf8" });
    expect(extractOrigin(node)).toBe(originGit);
    execFileSync("git", ["-C", node, "ls-remote", "origin"], { encoding: "utf8" });
  });

  it("with no stable URL the placeholder is installed — never a transient path", () => {
    const base = tmp();
    const node = join(base, "node");
    git(base, "init", "-q", node);
    writeFileSync(join(node, "f.txt"), "x\n");
    git(node, "add", "-A");
    git(node, "commit", "-q", "-m", "init");
    execFileSync("/bin/sh", ["-c", stableOriginCommand(node)], { encoding: "utf8" });
    const url = extractOrigin(node);
    expect(url).toBe(UNSET_ORIGIN_PLACEHOLDER);
    expect(isTransientGitPath(url)).toBe(false);
  });

  it("a stable origin is left untouched (idempotent re-apply produces the same URL)", () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const node = join(base, "node");
    git(base, "clone", "-q", originGit, node);
    execFileSync("/bin/sh", ["-c", stableOriginCommand(node, originGit)], { encoding: "utf8" });
    expect(extractOrigin(node)).toBe(originGit);
  });
});

describe("issue #152: origin preflight against real checkouts", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fleet152pre-")); dirs.push(d); return d; };
  afterEach(() => {
    for (const d of dirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
  });

  it("originPreflightCommand + parseOriginPreflight verify a FETCHABLE origin", () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const node = join(base, "node");
    git(base, "clone", "-q", originGit, node);
    writeFileSync(join(node, "f.txt"), "x\n");
    git(node, "add", "-A");
    git(node, "commit", "-q", "-m", "init");
    git(node, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(node, "remote", "set-url", "origin", originGit);
    const out = execFileSync("/bin/sh", ["-c", `${originPreflightCommand(node)}; exit 0`], { encoding: "utf8" });
    const pre = parseOriginPreflight(out);
    expect(pre.origin).toBe(originGit);
    expect(pre.fetchable).toBe(true);
    expect(pre.transient).toBe(false);
  });

  it("the preflight DETECTS an unfetchable origin (staging deleted after provision)", () => {
    const base = tmp();
    const seed = join(base, "seed");
    git(base, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "f.txt"), "x\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    const stage = join(base, "state", "xfer-999");
    mkdirSync(stage, { recursive: true });
    const bundle = join(stage, "bundle");
    git(seed, "bundle", "create", bundle, "--all");
    const node = join(base, "node");
    execFileSync("git", ["clone", "-q", bundle, node], { encoding: "utf8" });
    // The manager deletes the staging dir — the node origin dies silently.
    rmSync(stage, { recursive: true, force: true });
    const out = execFileSync("/bin/sh", ["-c", `${originPreflightCommand(node)}; exit 0`], { encoding: "utf8" });
    const pre = parseOriginPreflight(out);
    expect(pre.origin).toBe(bundle);
    expect(pre.fetchable).toBe(false); // detected, not silent
    expect(pre.transient).toBe(true);
  });

  it("checkOriginReachable flags a transient origin without any network", async () => {
    const base = tmp();
    const repo = join(base, "repo");
    git(base, "init", "-q", repo);
    // Origin points at the (long-gone) manager staging bundle.
    git(repo, "remote", "add", "origin", join(base, "state", "xfer-42", "bundle"));
    const r = await checkOriginReachable(repo);
    expect(r.ok).toBe(false);
    expect(r.stable).toBe(false);
    expect(r.detail).toMatch(/transient provisioning staging path/);
    expect(r.origin).toBe(join(base, "state", "xfer-42", "bundle"));
  });

  it("checkOriginReachable fails an unfetchable origin (deleted remote) and reports it", async () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const repo = join(base, "repo");
    git(base, "clone", "-q", originGit, repo);
    rmSync(originGit, { recursive: true, force: true });
    const r = await checkOriginReachable(repo);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ls-remote origin failed/);
  });

  it("checkOriginReachable passes a stable, fetchable local origin untouched", async () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    git(base, "init", "-q", "--bare", originGit);
    const repo = join(base, "repo");
    git(base, "clone", "-q", originGit, repo);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
    const r = await checkOriginReachable(repo);
    expect(r.ok).toBe(true);
    expect(r.stable).toBe(true);
    expect(r.origin).toBe(originGit);
  });
});

describe("issue #152: provisionToNode unpack path (real git, command-aware ssh stand-in)", () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fleet152-")); dirs.push(d); return d; };
  afterEach(() => {
    for (const d of dirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
  });

  it("provisions through a staging bundle, repoints origin to the stable repo, and the checkout still fetches", async () => {
    const base = tmp();
    const originGit = join(base, "origin.git");
    const seed = join(base, "seed");
    git(base, "init", "-q", "--bare", originGit);
    git(base, "clone", "-q", originGit, seed);
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    // The manager-side bundle provisionToNode ships.
    const managerBundle = join(base, "repo.bundle");
    git(seed, "bundle", "create", managerBundle, "--all");

    // A REAL-execution ssh stand-in: it actually RUNS the command line the
    // manager sends (so the unpack chain builds a genuine checkout with real
    // git), except that the stage-dir step is answered with a REAL staging dir
    // under this host's temp dir. Every command is logged so the test can
    // assert what ran. `GIT_CONFIG_SYSTEM` keeps the safe.directory step off
    // the host's real system config (this suite does not run as root).
    const nodeWork = tmp();
    const stageRoot = join(nodeWork, "state");
    mkdirSync(stageRoot, { recursive: true });
    const nodeCheckout = join(nodeWork, "checkout");
    const bin = tmp();
    const seenFile = join(bin, "seen.log");
    const sysCfg = join(bin, "gitconfig");
    const ssh = join(bin, "ssh");
    writeFileSync(ssh, [
      "#!/bin/sh",
      // ssh argv: [opts...] -- host command…  → drop until past '--', drop host.
      "while [ \"$1\" != \"--\" ]; do shift; done; shift; shift",
      "printf '%s\\n' \"$*\" >> " + JSON.stringify(seenFile),
      "cmd=\"$*\"",
      "case \"$cmd\" in",
      // Stage-dir command: echo the resolved staging dir (contract of
      // remoteStageDirCmd — the dir is the last stdout line). Keyed on
      // FLEET_STATE_DIR: only the staging command names it, so the unpack
      // chain's own `mkdir -p` never matches this arm.
      `  *FLEET_STATE_DIR*)`,
      `    xid=$(printf '%s\\n' "$cmd" | sed -n 's/.*xfer-\\([A-Za-z0-9_-]\\{1,64\\}\\).*/\\1/p')`,
      `    d='${stageRoot}/xfer-'"$xid"`,
      `    mkdir -p "$d" && printf '%s\\n' "$d" ;;`,
      // Everything else RUNS for real, with harmless git env.
      "  *) GIT_CONFIG_SYSTEM=" + JSON.stringify(sysCfg)
        + " GIT_CONFIG_GLOBAL=/dev/null bash -c \"$cmd\" ;;",
      "esac",
    ].join("\n") + "\n");
    const scp = join(bin, "scp");
    // scp stand-in with the real contract: scp [opts] -- local host:path —
    // it actually copies the bundle into the node-side staging dir.
    writeFileSync(scp, [
      "#!/bin/sh",
      "local_src=\"\"",
      "remote_dst=\"\"",
      "for a in \"$@\"; do",
      "  case \"$a\" in",
      "    -*) ;;",
      "    --) ;;",
      "    *:*) remote_dst=\"$a\" ;;",
      "    *) local_src=\"$a\" ;;",
      "  esac",
      "done",
      "cp \"$local_src\" \"${remote_dst#*:}\"",
      "exit 0",
    ].join("\n") + "\n");
    chmodSync(ssh, 0o755);
    chmodSync(scp, 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const r = await provisionToNode("dev2", managerBundle, {
        repo: originGit,
        cwd: nodeCheckout,
        branch: "main",
      });
      expect(r.ok).toBe(true);
      // The result names the STABLE origin — never the transient bundle path.
      expect(r.stableOrigin).toBe(originGit);
      expect(isTransientGitPath(r.stableOrigin!)).toBe(false);
      expect(r.originUnset).toBeUndefined();
      // The REAL node checkout produced by the unpack chain: origin must be
      // the stable repo and a fetch against it must succeed AFTER staging
      // cleanup (the transient path is gone — exactly the #152 scenario).
      rmSync(stageRoot, { recursive: true, force: true });
      const url = execFileSync("git", ["-C", nodeCheckout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      expect(isTransientGitPath(url)).toBe(false);
      expect(url).toBe(originGit);
      execFileSync("git", ["-C", nodeCheckout, "ls-remote", "origin"], { encoding: "utf8" });
      // The repair ran as part of the unpack chain on the node.
      const seen = readFileSync(seenFile, "utf8");
      expect(seen).toContain("git remote set-url origin");
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("issue #152: node-channel __UNPACK__ path (real handler, real bundle bytes)", () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fleet152ch-")); dirs.push(d); return d; };
  afterEach(() => {
    for (const d of dirs.splice(0).reverse()) rmSync(d, { recursive: true, force: true });
  });

  it("unpacks a bundle, installs the stable URL (placeholder without one), and never keeps the xfer path", async () => {
    // Harness: isolated node state + allowed roots, a real origin, a real
    // bundle shipped through the REAL node handler (xfer.receive → xfer.unpack
    // → xfer.clean), exactly like an SSH-free provision.
    const workRoot = tmp();
    const stateDir = join(workRoot, "state-dir");
    const prev = { state: process.env.FLEET_STATE_DIR, roots: process.env.FLEET_ALLOWED_ROOTS };
    process.env.FLEET_STATE_DIR = stateDir;
    process.env.FLEET_ALLOWED_ROOTS = workRoot;
    const base = tmp();
    try {
      const originGit = join(base, "origin.git");
      const seed = join(base, "seed");
      git(base, "init", "-q", "--bare", originGit);
      git(base, "clone", "-q", originGit, seed);
      writeFileSync(join(seed, "README.md"), "hi\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", "init");
      git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
      const bundle = join(base, "repo.bundle");
      git(seed, "bundle", "create", bundle, "--all");
      const b64 = readFileSync(bundle).toString("base64");
      const sha256 = (await import("node:crypto")).createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
      const nodeCheckout = join(workRoot, "repo");
      const call = async (p: Record<string, unknown>) =>
        JSON.parse(await (await import("./node/handler.js")).handleOpencodeRun(JSON.stringify(p)));

      // Ship + unpack WITHOUT a stable URL: the placeholder must be installed.
      const { createHash: ch } = await import("node:crypto");
      void ch;
      expect((await call({ prompt: "__RECEIVE__", cwd: "/", transport: "http", transferId: "t152a", chunkIndex: 0, chunks: [{ index: 0, data: b64 }] })).ok).toBe(true);
      const un1 = await call({ prompt: "__UNPACK__", cwd: nodeCheckout, transport: "http", transferId: "t152a", sha256 });
      expect(un1.ok).toBe(true);
      const url1 = execFileSync("git", ["-C", nodeCheckout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      expect(url1).toBe(UNSET_ORIGIN_PLACEHOLDER);
      expect(isTransientGitPath(url1)).toBe(false);
      expect((await call({ prompt: "__RECEIVE_CLEAN__", cwd: "/", transport: "http", transferId: "t152a" })).ok).toBe(true);

      // Now with the manager's stable URL: origin points at the REAL repo and
      // fetches AFTER the staging dir is deleted.
      const nodeCheckout2 = join(workRoot, "repo2");
      expect((await call({ prompt: "__RECEIVE__", cwd: "/", transport: "http", transferId: "t152b", chunkIndex: 0, chunks: [{ index: 0, data: b64 }] })).ok).toBe(true);
      const un2 = await call({ prompt: "__UNPACK__", cwd: nodeCheckout2, transport: "http", transferId: "t152b", sha256, stableOrigin: originGit });
      expect(un2.ok).toBe(true);
      const url2 = execFileSync("git", ["-C", nodeCheckout2, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      expect(url2).toBe(originGit);
      expect(isTransientGitPath(url2)).toBe(false);
      expect((await call({ prompt: "__RECEIVE_CLEAN__", cwd: "/", transport: "http", transferId: "t152b" })).ok).toBe(true);
      // Stage the transient bundle would have lived in is long gone (its
      // accumulation dir was removed by xfer.clean) — ls-remote still works.
      execFileSync("git", ["-C", nodeCheckout2, "ls-remote", "origin"], { encoding: "utf8" });
    } finally {
      process.env.FLEET_STATE_DIR = prev.state;
      process.env.FLEET_ALLOWED_ROOTS = prev.roots;
      if (prev.state === undefined) delete process.env.FLEET_STATE_DIR;
      if (prev.roots === undefined) delete process.env.FLEET_ALLOWED_ROOTS;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});