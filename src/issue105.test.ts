import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deriveIsolationLevels, parseIsolationFacts, detectNodeCapabilities } from "./capabilities.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply, type FakeNode, type Loaded } from "./testkit/plugin.js";
import { loadLedger } from "./ledger.js";
import { parseTaskSpec } from "./spec.js";
import { createRunClone, runCloneDir } from "./node/runtime.js";
import { handleOpencodeRun } from "./node/handler.js";
import { buildManifest } from "./audit.js";
import { FEATURE_MIN_PROTOCOL, PROTOCOL_VERSION, requiredProtocol, resolveOp } from "./protocol.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";

/**
 * Issue #105 — capability-probe slice ONLY.
 *
 * Scope enforced by the task: report supported ISOLATION levels per node in
 * fleet_capabilities, and have fleet_dispatch REFUSE an isolation level the
 * node cannot honour BEFORE launching. No bwrap wrapping/sandbox policy here
 * (held for an owner decision); no policy change.
 *
 * Structure mirrors issue51b.test.ts (same fake-ssh testkit approach, no real
 * git, no network):
 *   1. PURE level-derivation helper (no nodes).
 *   2. Pure parse of the probe transcript.
 *   3. detectNodeCapabilities surfaces the three fields from the one probe pass.
 *   4. fleet_dispatch refuses an unsupported `isolation` (hard, no launch).
 *   5. fleet_dispatch with no `isolation` behaves exactly as before.
 */

const entry = await loadEntry();

const CAPS_FACTS = [
  "CPU=8", "MEM=31", "DISK=90", "GPU=none",
  "TOOLS=node,npm,python3", "OPENCODE=1.18.26",
  "PYVER=Python 3.12.3", "PYVENV=yes", "PYPEP668=yes", "PIPUSER=yes",
];

describe("#105: pure isolation-level derivation (deriveIsolationLevels)", () => {
  it("git present + bwrap usable => [\"clone\",\"bwrap\"]", () => {
    expect(deriveIsolationLevels(true, true)).toEqual(["clone", "bwrap"]);
  });
  it("git present + bwrap absent => [\"clone\"]", () => {
    expect(deriveIsolationLevels(true, false)).toEqual(["clone"]);
  });
  it("bwrap present but non-zero exit (unusable) => [\"clone\"]", () => {
    // "Present but broken" IS git-yes/bwrap-no for the derivation: the probe
    // maps a failing `bwrap --version` to bwrap=false, and the level list
    // must not include bwrap for it.
    expect(deriveIsolationLevels(true, false)).toEqual(["clone"]);
  });
  it("no usable git but usable bwrap => [\"bwrap\"] only", () => {
    expect(deriveIsolationLevels(false, true)).toEqual(["bwrap"]);
  });
  it("nothing usable => []", () => {
    expect(deriveIsolationLevels(false, false)).toEqual([]);
  });
});

describe("#105: probe echo parsing (parseIsolationFacts)", () => {
  it("yes on both lines => both capabilities true", () => {
    expect(parseIsolationFacts("GITCLONE=yes\nBWRAP=yes\n")).toEqual({ gitClone: true, bwrap: true });
  });
  it("no echoes => both false", () => {
    expect(parseIsolationFacts("GITCLONE=no\nBWRAP=no\n")).toEqual({ gitClone: false, bwrap: false });
  });
  it("a missing echo counts as unsupported (never assumed usable)", () => {
    expect(parseIsolationFacts("GITCLONE=yes\n")).toEqual({ gitClone: true, bwrap: false });
    expect(parseIsolationFacts("")).toEqual({ gitClone: false, bwrap: false });
  });
  it("anything but the yes sentinel is false (empty value, garbage, whitespace)", () => {
    expect(parseIsolationFacts("GITCLONE=\nBWRAP=maybe\n")).toEqual({ gitClone: false, bwrap: false });
    expect(parseIsolationFacts("  GITCLONE=yes  \n BWRAP=yes\n")).toEqual({ gitClone: true, bwrap: true });
  });
});

describe("#105: detectNodeCapabilities surfaces the isolation fields (fake ssh, one probe pass)", () => {
  it("a git+bwrap capable node reports gitClone, bwrap and both levels", async () => {
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=yes"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "iso-node", "svcuser");
      expect(caps.error).toBeUndefined();
      expect(caps.gitClone).toBe(true);
      expect(caps.bwrap).toBe(true);
      expect(caps.isolationLevels).toEqual(["clone", "bwrap"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("git present + bwrap absent => gitClone true, bwrap false, levels [\"clone\"]", async () => {
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=no"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "clone-only", "svcuser");
      expect(caps.gitClone).toBe(true);
      expect(caps.bwrap).toBe(false);
      expect(caps.isolationLevels).toEqual(["clone"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("bwrap present but unusable (non-zero exit) => BWRAP=no => levels [\"clone\"]", async () => {
    // The probe command itself encodes "usable": a failing `bwrap --version`
    // collapses to the BWRAP=no echo, so a present-but-broken binary is
    // reported exactly like an absent one — and bwrap never lands in levels.
    const restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes", "BWRAP=no"]);
    try {
      const caps = await detectNodeCapabilities("node.example", "broken-bwrap", "svcuser");
      expect(caps.bwrap).toBe(false);
      expect(caps.gitClone).toBe(true);
      expect(caps.isolationLevels).toEqual(["clone"]);
    } finally {
      restore();
    }
  }, 30_000);

  it("the isolation facts ride the SAME single probe pass (no second round-trip)", async () => {
    // The full-fleet probe command is ONE `cmd` array joined into a single
    // `&&` shell chain with every fact echo; GITCLONE/BWRAP sit inline with
    // CPU/MEM/etc. The other GITCLONE/BWRAP occurrences are the standalone
    // dispatcher probe helper and its pure parse keys.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./capabilities.ts", import.meta.url), "utf8");
    expect(src).toContain('`echo "GITCLONE=$(git --version >/dev/null 2>&1 && echo yes || echo no)"`');
    expect(src).toContain('`echo "BWRAP=$(bwrap --version >/dev/null 2>&1 && echo yes || echo no)"`');
    // The single chain: between `const cmd = [` and its `].join(" && ")` sit
    // BOTH the pre-existing fact echoes AND the isolation echoes — one probe
    // command, so the isolation facts add no round-trip.
    const fullPass = src.slice(
      src.indexOf("const cmd = [") + "const cmd = [".length,
      src.indexOf('].join(" && ");'),
    );
    for (const key of ["CPU=$", "TOOLS=$", "OPENCODE=$", "PYVER=$", "GITCLONE=$", "BWRAP=$"]) {
      expect(fullPass.includes(key), key).toBe(true);
    }
  });
});

describe.skipIf(!process.env.CI)("#105 CI: the plugin entry loads, so the tool-level tests really ran", () => {
  it("entry", () => {
    expect(entry).toBeDefined();
  });
});

describe("#164: the isolation-gate probe host matches the cwd probe (loginUser set, remoteIp absent)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  const NODES: FakeNode[] = [{
    nodeId: "n-dev2",
    displayName: "dev2",
    connected: true,
    invocableCommands: ["opencode.run"],
    // The membership `user` (the SSH login user) lives in the CONFIG entry
    // below — resolveFleetNodes takes `member` from config, not the node
    // record. Deliberately NO remoteIp on the node record: the broken gate
    // then probed bare "dev2" while the cwd probe used "walt@dev2".
  } as unknown as (typeof NODES)[number]];
  const cfg: Record<string, unknown> = { nodes: { dev2: { roles: ["worker"], ssh: false, user: "walt" } } };
  const ack = () =>
    nodeReply({ ok: true, detached: true, runId: "r", pid: 42, isolation: "clone", runCwd: "/w/.fleet-runs/r/repo", branch: "fleet/r", sourceDirty: false });
  const dispatch = (args: Record<string, unknown>) =>
    p!.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it", ...args });
  const nodeRes = (res: Record<string, unknown>): Record<string, unknown> => (res.dev2 ?? res["n-dev2"]) as Record<string, unknown>;

  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  /**
   * A stand-in `ssh` that LOGS the host it was given (one line per call to
   * `${FLEET_SSH_ARGLOG}`) while answering each probe with a cwd-ok,
   * isolation-capable transcript. sshPrefix's argv is
   * [options..., "--", host, remoteCommand], so the host is the arg right
   * after the first `--` — logged verbatim, whatever the gate chose. This is
   * the discriminator: with the pre-#164 code the gate's probe ran against
   * the bare node key, with the fix it runs against `loginUser@nodeKey`.
   */
  const fakeSshArgLog = (): (() => void) => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-fakesshlog-"));
    const bin = join(dir, "ssh");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        // Find the first `--`; the NEXT arg is the host (options may reorder,
        // but sshPrefix guarantees "--" then host then remote command).
        "for a; do if [ \"$seen\" = 1 ]; then printf '%s\\n' \"$a\" >> \"${FLEET_SSH_ARGLOG:?}\"; break; fi; [ \"$a\" = -- ] && seen=1; done",
        // The cwd guard runs under sudo as the worker principal and expects
        // the guard's own output line; then the isolation facts.
        "printf '%s\\n' 'FLEET_CWD=ok'",
        "printf '%s\\n' 'GITCLONE=yes'",
        "printf '%s\\n' 'BWRAP=no'",
        "exit 0",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "scp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    return () => {
      process.env.PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    };
  };
  const argLog = (rootDir: string): string[] => {
    try { return readFileSync(join(rootDir, "ssh-args.log"), "utf8").split("\n").filter(Boolean); }
    catch { return []; };
  };

  it.skipIf(!entry)("the gate probes the SAME host string the cwd probe uses (sshHost, not remoteIp-preferred)", async () => {
    restore = fakeSshArgLog();
    p = loadPlugin(entry!, { nodes: NODES, config: cfg, invoke: () => ack() });
    process.env.FLEET_SSH_ARGLOG = join(p.rootDir, "ssh-args.log");
    try {
      const res = nodeRes(await dispatch({ isolation: "clone" }));
      const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
      const hosts = argLog(p.rootDir);
      // Failure context on every assertion, so a regression points at the argv.
      expect(start, `dispatch result: ${JSON.stringify(res)}`).toBeDefined();
      expect(start!.params.isolation, `dispatch result: ${JSON.stringify(res)}`).toBe("clone");
      // The cwd probe and the capability probe both ran against the node's
      // login-user host — the SAME string for both (issue: gate must probe
      // the cwd probe's host, not prefer a remoteIp when it is absent, and
      // not the bare node key when a loginUser is set).
      const sshUserHost = "walt@dev2";
      expect(hosts, `ssh argv hosts: ${JSON.stringify(hosts)}`).toContain(sshUserHost);
      expect(hosts, `ssh argv hosts: ${JSON.stringify(hosts)}`).not.toContain("dev2");
    } finally {
      delete process.env.FLEET_SSH_ARGLOG;
    }
  }, 30_000);

  // Issue #164 review: the case that ACTUALLY distinguishes pre-fix from post-fix —
  // remoteIp PRESENT *and* a login user set. Pre-fix `entryHostForCaps = remoteIp ?? sshHost`
  // picks the bare remoteIp; the cwd probe still uses `loginUser@nodeKey`. The two must MATCH,
  // so the gate must NOT prefer remoteIp. This test FAILS on master (the divergent branch).
  it.skipIf(!entry)("the gate ignores remoteIp when a login user is set (the divergent branch)", async () => {
    restore = fakeSshArgLog();
    const NODES_WITH_IP: FakeNode[] = [{
      nodeId: "n-dev2",
      displayName: "dev2",
      remoteIp: "192.0.2.7",
      connected: true,
      invocableCommands: ["opencode.run"],
    } as unknown as FakeNode];
    p = loadPlugin(entry!, { nodes: NODES_WITH_IP, config: cfg, invoke: () => ack() });
    process.env.FLEET_SSH_ARGLOG = join(p.rootDir, "ssh-args.log");
    try {
      const res = nodeRes(await dispatch({ isolation: "clone" }));
      const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
      const hosts = argLog(p.rootDir);
      expect(start, `dispatch result: ${JSON.stringify(res)}`).toBeDefined();
      // The capability/gate probe must use the SAME host as the cwd probe ("walt@dev2"),
      // NOT the bare remoteIp the pre-fix code preferred.
      expect(hosts, `ssh argv hosts: ${JSON.stringify(hosts)}`).toContain("walt@dev2");
      expect(hosts, `ssh argv hosts: ${JSON.stringify(hosts)}`).not.toContain("192.0.2.7");
    } finally {
      delete process.env.FLEET_SSH_ARGLOG;
    }
  }, 30_000);
});

describe("#105: fleet_dispatch refuses an unsupported isolation level (tool level, fake ssh + fake node)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  // Fake node channel: would ack any launch — proving the gate stops the run
  // BEFORE the node is ever invoked.
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const cfg = (extra: Record<string, unknown> = {}) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...extra });
  const ack = () =>
    nodeReply({ ok: true, detached: true, runId: "r", pid: 42, isolation: "clone", runCwd: "/w/.fleet-runs/r/repo", branch: "fleet/r", sourceDirty: false });
  const dispatch = (args: Record<string, unknown>) =>
    p!.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", prompt: "do it", ...args });
  const nodeRes = (res: Record<string, unknown>): Record<string, unknown> => (res.dev2 ?? res["n-dev2"]) as Record<string, unknown>;

  beforeEach(() => { restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  it("isolation on a node that cannot honour it is REFUSED with a clear error and NOTHING is launched (ledger untouched)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "bwrap" }));
    expect(res.ok, String(res.error)).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "bwrap"/);
    // Hard refusal: no node invoke, no ledger record — not a downgrade.
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("isolation:clone on a git-less node is REFUSED the same way (the probe, not the enum, decides)", async () => {
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=no", "BWRAP=no"]);
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    expect(res.ok, String(res.error)).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "clone"/);
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("unsupported level is not silently downgraded: the error names the supported levels", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "bwrap" }));
    expect(String(res.error)).toMatch(/supported levels: clone/);
    expect(String(res.error)).toMatch(/No run was launched/);
  }, 30_000);

  it("a probe failure fails CLOSED (a node whose capabilities cannot be probed never gets the run)", async () => {
    // The cwd check succeeds but the isolation probe call fails non-zero with
    // no output (models an unreachable/partially-broken node): levels [] =>
    // refuse, never assume support.
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok"], { failOn: "GITCLONE=" });
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/does not support isolation "clone"/);
    expect(String(res.error)).toMatch(/capability probe failed/);
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it("an isolation level the node CAN honour launches exactly as before (the gate is additive)", async () => {
    p = loadPlugin(entry!, { nodes: NODES, config: cfg(), invoke: () => ack() });
    const res = nodeRes(await dispatch({ isolation: "clone" }));
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect(start!.params.isolation).toBe("clone");
    // A detached ack result reports the run handle (ok:true is only added on
    // failure rows, so assert the handle fields, as isolation-tool.test.ts does).
    expect(res).toMatchObject({ runId: expect.anything(), detached: true, pid: 42, runCwd: "/w/.fleet-runs/r/repo" });
  }, 30_000);

  it("no isolation param => no change: today's behavior, even against a git-less node with a config default", async () => {
    // Only an EXPLICIT isolation is gated (scope: isolation absent => exactly
    // today). A config default of clone plus a git-less node still dispatches
    // — the node-side #41 machinery remains its backstop.
    restore?.();
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=no", "BWRAP=no"]);
    p = loadPlugin(entry!, { nodes: NODES, config: cfg({ isolation: "clone" }), invoke: () => ack() });
    await dispatch({});
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__");
    expect(start!.params.isolation).toBe("clone");
  }, 30_000);
});

describe("#105: fleet_capabilities surfaces the new fields per node (tool level)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  it.skipIf(!entry)("each node's result carries gitClone, bwrap and isolationLevels", async () => {
    restore = fakeSshMultiline([...CAPS_FACTS, "GITCLONE=yes"]); // no BWRAP echo => absent
    p = loadPlugin(entry!, {
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", remoteIp: "node.example", connected: true }],
    });
    const res = await p.call("fleet_capabilities", {});
    expect(res.dev2).toMatchObject({
      node: "dev2",
      gitClone: true,
      bwrap: false,
      isolationLevels: ["clone"],
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Issue #105b (retry): spec.base names the commit/branch an isolated clone
// starts from. Parse shapes, clone-base (tmp repos), dispatch refusal seams,
// protocol derivation + the older-node refusal.
// ---------------------------------------------------------------------------

const gitCmd = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();

/** A two-commit repo with a `feature` branch BEHIND master (master has one commit feature lacks). */
function makeBaseRepo(dir: string): { repo: string; featureTip: string; masterTip: string; first: string } {
  const repo = join(dir, "work", "proj");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });
  gitCmd(repo, "config", "user.email", "t@t");
  gitCmd(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "v1");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "first"], { stdio: "pipe" });
  const first = gitCmd(repo, "rev-parse", "HEAD");
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"], { stdio: "pipe" });
  const featureTip = gitCmd(repo, "rev-parse", "HEAD");
  execFileSync("git", ["-C", repo, "checkout", "-q", "master"], { stdio: "pipe" });
  writeFileSync(join(repo, "g.txt"), "v2");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "second (feature does not have it)"], { stdio: "pipe" });
  const masterTip = gitCmd(repo, "rev-parse", "HEAD");
  return { repo, featureTip, masterTip, first };
}

describe("#105b: parseTaskSpec validates spec.base", () => {
  const ok = (spec: Record<string, unknown>) => parseTaskSpec({ goal: "g", ...spec });
  it("no base => unchanged behavior (undefined spec.base accepted as-is)", () => {
    expect(ok({})).toEqual({ ok: true, spec: { goal: "g" } });
    expect(parseTaskSpec({ goal: "g", base: null }).ok).toBe(true);
  });
  it("a branch or a commit alone is accepted verbatim", () => {
    expect(ok({ base: { branch: "feature" } })).toEqual({ ok: true, spec: { goal: "g", base: { branch: "feature" } } });
    expect(ok({ base: { commit: "a".repeat(40) } })).toEqual({ ok: true, spec: { goal: "g", base: { commit: "a".repeat(40) } } });
    expect(ok({ base: { commit: "b".repeat(64) } }).ok).toBe(true);
  });
  it("both, neither, bad shapes and unknown keys are refused", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ base: { branch: "feature", commit: "c".repeat(40) } }, /exactly one of branch or commit/],
      [{ base: {} }, /exactly one of branch or commit/],
      [{ base: { branch: "feat..ure" } }, /plain ref name/],
      [{ base: { branch: "-x" } }, /plain ref name/],
      [{ base: { branch: "a b" } }, /plain ref name/],
      [{ base: { commit: "nothex" } }, /hex commit sha/],
      [{ base: { commit: "c".repeat(39) } }, /hex commit sha/],
      [{ base: { branch: "feature", extra: 1 } }, /unknown key/],
      [{ base: "feature" }, /base must be an object/],
      [{ base: ["feature"] }, /base must be an object/],
    ];
    for (const [spec, re] of bad) {
      const r = ok(spec);
      expect(r.ok, JSON.stringify(spec)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(spec)).toMatch(re);
      expect(r.ok === false && r.error.startsWith("spec."), JSON.stringify(spec)).toBe(true);
    }
  });
});

describe("#105b: createRunClone honors the base (tmp repos)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet105b-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("base behind branch: clone starts at the feature tip, heads recorded, sourceMoved derivable", async () => {
    const { repo, featureTip, masterTip } = makeBaseRepo(dir);
    const r = await createRunClone("run-b1", repo, { branch: "feature" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(gitCmd(r.cwd, "rev-parse", "HEAD")).toBe(featureTip);
    expect(gitCmd(r.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fleet/run-b1");
    expect(r.baseHead).toBe(featureTip);
    expect(r.sourceHead).toBe(masterTip);
    expect(r.baseHead !== r.sourceHead).toBe(true);
    expect(existsSync(join(r.cwd, "g.txt"))).toBe(false); // the master-only commit is NOT in the clone
  });
  it("base commit: clone HEAD is exactly that sha", async () => {
    const { repo, first } = makeBaseRepo(dir);
    const r = await createRunClone("run-b2", repo, { commit: first });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(gitCmd(r.cwd, "rev-parse", "HEAD")).toBe(first);
    expect(r.baseHead).toBe(first);
  });
  it("a missing branch or commit fails the run NAMING it, and removes the run dir", async () => {
    const { repo } = makeBaseRepo(dir);
    const missBr = await createRunClone("run-b3", repo, { branch: "nosuch" });
    expect(missBr.ok).toBe(false);
    if (!missBr.ok) expect(missBr.error).toMatch(/base branch nosuch not present in the clone/);
    expect(existsSync(runCloneDir(repo, "run-b3"))).toBe(false);
    const missCo = await createRunClone("run-b4", repo, { commit: "d".repeat(40) });
    expect(missCo.ok).toBe(false);
    if (!missCo.ok) expect(missCo.error).toMatch(/base commit [d]{40} not present in the clone/);
    expect(existsSync(runCloneDir(repo, "run-b4"))).toBe(false);
  });
  it("no base: byte-identical today — HEAD at source HEAD, no baseHead/sourceHead fields", async () => {
    const { repo, masterTip } = makeBaseRepo(dir);
    const r = await createRunClone("run-b5", repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(gitCmd(r.cwd, "rev-parse", "HEAD")).toBe(masterTip);
    expect("baseHead" in r).toBe(false);
    expect("sourceHead" in r).toBe(false);
  });
});

describe("#105b: dispatch-level pure seams (fail-closed spec.base)", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); restore = undefined; });

  it("spec.base with isolation none (explicit or config default) is refused BEFORE any node call", async () => {
    const entry2 = entry ?? (await loadEntry());
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
    const nodes = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
    const cfg = { nodes: { dev2: { roles: ["worker"], ssh: false } } };
    const ack = () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
    p = loadPlugin(entry2!, { nodes, config: cfg, invoke: () => ack() });
    const refused = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", spec: { goal: "g", base: { branch: "feature" } }, isolation: "none" }) as { ok?: boolean; error?: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('spec.base requires isolation: "clone"');
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
    p.dispose();
    // config-default isolation none + spec.base => refused too (never silently ignored).
    p = loadPlugin(entry2!, { nodes, config: cfg, invoke: () => ack() });
    const cfgRefused = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", spec: { goal: "g", base: { commit: "c".repeat(40) } } }) as { ok?: boolean; error?: string };
    expect(cfgRefused.ok).toBe(false);
    expect(cfgRefused.error).toBe('spec.base requires isolation: "clone"');
    expect(p.invokes).toHaveLength(0);
    expect(await loadLedger(p.rootDir)).toEqual([]);
  }, 30_000);

  it.skipIf(!entry)("spec.base with clone is accepted; base rides the run.start payload", async () => {
    const entry2 = entry ?? (await loadEntry());
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
    const nodes = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
    const cfg = { nodes: { dev2: { roles: ["worker"], ssh: false } } };
    p = loadPlugin(entry2!, { nodes, config: cfg, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    const res = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w/proj", spec: { goal: "g", base: { branch: "feature" } }, isolation: "clone" }) as Record<string, unknown>;
    const row = (res.dev2 ?? res["n-dev2"]) as Record<string, unknown> | undefined;
    expect(row, JSON.stringify(res).slice(0, 300)).toBeDefined();
    const start = await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__" && c.params.base !== undefined);
    expect(start, JSON.stringify(res).slice(0, 300)).toBeDefined();
    expect(start!.params.isolation).toBe("clone");
    expect(start!.params.base).toEqual({ branch: "feature" });
  }, 30_000);
});

describe("#105b: protocol — a base-bearing task needs protocol 7 and an older node refuses", () => {
  it("a task with a base derives protocol 7 naming the feature; without one protocol 0", () => {
    expect(FEATURE_MIN_PROTOCOL.base).toBe(7);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
    const r = requiredProtocol({ isolation: "clone", base: { branch: "feature" } });
    expect(r.version).toBe(7);
    expect(r.feature).toMatch(/spec\.base/);
    expect(requiredProtocol({ isolation: "clone" }).version).toBe(4);
    expect(requiredProtocol({}).version).toBe(0);
    // a non-object or empty base needs nothing (the gateway validates the shape first)
    expect(requiredProtocol({ base: "feature" }).version).toBe(0);
    expect(requiredProtocol({ base: {} }).version).toBe(0);
  });
  // pv 6 is TODAY's shipped protocol (project.read, #210): the exact skew case —
  // it must be refused for a base-bearing task, never silently cloning from HEAD.
  for (const pv of [0, 1, 4, 5, 6]) {
    it(`a protocol-${pv} node refuses a base-bearing task (never clones from HEAD)`, async () => {
      expect(pv).toBeLessThan(7);
      const seen: Array<Record<string, unknown>> = [];
      const ctx = (params: Record<string, unknown>): PolicyCtx => ({
        params, node: { nodeId: "n1" },
        invokeNode: async (a: { params: Record<string, unknown> }) => { seen.push(a.params); return { ok: true as const, payload: { ok: true, ...(pv > 0 ? { protocol: pv } : {}) } }; },
      } as unknown as PolicyCtx);
      const r = await handleOpencodeRunPolicy(ctx({ prompt: "__RUN_START__", op: "run.start", cwd: "/w", runId: "r1", realPrompt: "x", isolation: "clone", base: { branch: "feature" } }), newProtocolCache());
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/spec\.base/);
      expect(seen).toHaveLength(1); // only the probe was sent; the task itself never rode to the old node
      expect(seen[0]).toMatchObject({ prompt: "__RUN_STATUS__" });
    });
  }
  it("the node itself refuses a request stamped above its protocol (end to end, naming versions)", async () => {
    const out = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__RUN_START__", op: "run.start", cwd: "/", runId: "r-prot", realPrompt: "x", protocol: PROTOCOL_VERSION + 1 })));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(`needs protocol ${PROTOCOL_VERSION + 1}.*newer than this node's protocol`));
  });
  it("the reviewer's probe: a node answering protocol 6 is refused a base-bearing task at the same policy seam (c6bff095 ACCEPTED this)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = (params: Record<string, unknown>): PolicyCtx => ({
      params, node: { nodeId: "n-probe6" },
      invokeNode: async (a: { params: Record<string, unknown> }) => { seen.push(a.params); return { ok: true as const, payload: { ok: false, error: "never reached: the gateway refuses first", protocol: 6 } }; },
    } as unknown as PolicyCtx);
    const r = await handleOpencodeRunPolicy(ctx({ prompt: "__RUN_START__", op: "run.start", cwd: "/w", runId: "r-probe6", realPrompt: "x", isolation: "clone", base: { branch: "feature" } }), newProtocolCache());
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/spec\.base/);
    expect((r as { message: string }).message).toMatch(/protocol 6 \(< 7\)/);
    // Not dispatched: only the probe rode to the node; no base-bearing task ever did.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: "__RUN_STATUS__" });
  });
  it("an older-node refusal names the feature through the gateway (the #76 rule: refuse, never drop)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = (params: Record<string, unknown>): PolicyCtx => ({
      params, node: { nodeId: "n-old" },
      invokeNode: async (a: { params: Record<string, unknown> }) => { seen.push(a.params); return { ok: true as const, payload: { ok: false, error: "never reached: the gateway refuses first", protocol: 5 } }; },
    } as unknown as PolicyCtx);
    const r = await handleOpencodeRunPolicy(ctx({ prompt: "__RUN_START__", op: "run.start", cwd: "/w", runId: "r-prot2", realPrompt: "x", isolation: "clone", base: { commit: "e".repeat(40) } }), newProtocolCache());
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/spec\.base/);
    expect(seen).toHaveLength(1);
  });
});

describe("#105b: the base heads surface in audit + run.status (additive fields only)", () => {
  it("buildManifest: no base => byte-identical fields; with base => baseHead/sourceHead and the sourceMoved note", () => {
    const events = { commandsRecorded: false, commands: [], eventCount: 0 };
    const log = { bytes: 0, truncated: false };
    const base: Parameters<typeof buildManifest>[0] = {
      runId: "r", harness: "opencode", cwd: "/w/p", startHead: "a".repeat(40),
      finishedAt: "2026-01-01T00:05:00Z", exitCode: 0, verified: true, changes: { endHead: "a".repeat(40), files: [], diffStat: "" }, events, log,
    };
    const before = buildManifest(base);
    expect("baseHead" in before).toBe(false);
    expect("sourceHead" in before).toBe(false);
    expect("sourceMoved" in before).toBe(false);
    const moved = buildManifest({ ...base, baseHead: "f".repeat(40), sourceHead: "a".repeat(40), baseBranch: "feature" });
    expect(moved.baseHead).toBe("f".repeat(40));
    expect(moved.sourceHead).toBe("a".repeat(40));
    expect(moved.baseBranch).toBe("feature");
    expect(moved.sourceMoved).toBe(`clone started at ${"f".repeat(40)} (base feature); source has moved to ${"a".repeat(40)}`);
    const unmoved = buildManifest({ ...base, baseHead: "a".repeat(40), sourceHead: "a".repeat(40) });
    expect("sourceMoved" in unmoved).toBe(false);
  });
});
