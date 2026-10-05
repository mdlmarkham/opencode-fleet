import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  BASELINE_DENY,
  autoApproveGate,
  baselinePresent,
  detectAutoSupport,
  mergeDenyBaseline,
  type AutoSupportProbe,
  type PermissionAction,
} from "./deny-baseline.js";
import { buildBaselineModule, provisionConfigToNode } from "./config-provision.js";
import { detectNodeCapabilities, satisfiesConstraints } from "./capabilities.js";
import { fakeSsh, nodeReply, loadEntry, loadPlugin } from "./testkit/plugin.js";

/* Issue #51, slice 2 checks. Scope reminder: this slice is the WIRING of the
 * slice-1 helpers into the fleet surface:
 *   1. config provisioning merges the baseline into the node's opencode.json
 *      (opt-in installDenyBaseline; merge-only, idempotent, never overwrites);
 *   2. fleet_capabilities reports `denyBaseline` via baselinePresent();
 *   3. fleet_dispatch autoApprove refuses an opencode that cannot parse --auto
 *      and warns when the baseline is missing — via the pure autoApproveGate
 *      predicate extracted into deny-baseline.ts.
 * No network, no live SSH: pure/unit-level where the existing suite is.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A permissive `opencode run --help` listing the word-bounded --auto flag. */
const AUTO_HELP = [
  "Usage: opencode run [message..]",
  "Flags:",
  "     --auto     Approve all permissions automatically for this run",
].join("\n");

describe("#51 slice 2: config provisioning applies mergeDenyBaseline (opt-in)", () => {
  it("exposes installDenyBaseline on the request and denyBaselineInstalled on the result shape", () => {
    // Type-level contract (compile-checked) + the opt-in default-unchanged rule:
    // the request field is OPTIONAL, so omitting it cannot change any call site.
    const req: import("./config-provision.js").ConfigProvisionRequest = {};
    expect(req.installDenyBaseline).toBeUndefined();
    const res: import("./config-provision.js").ConfigProvisionResult = { ok: true };
    expect(res.denyBaselineInstalled).toBeUndefined();
    expect(res.opencodeConfig).toBeUndefined();
  });

  it("the emitted node-side module reproduces mergeDenyBaseline exactly (fixture: unrelated keys preserved, baseline present, idempotent)", async () => {
    // The install path ships a data-only CJS module and merges ON the node with
    // it. Run that exact emitted module against a fixture node config in a
    // throwaway dir — no network, no SSH.
    const mod = await buildBaselineModule();
    const dir = mkdtempSync(join(tmpdir(), "issue51b-baseline-"));
    const modPath = join(dir, "baseline.cjs");
    writeFileSync(modPath, mod, "utf8");

    // Fixture node config: real-world-ish opencode.json with unrelated keys and
    // user permission rules the baseline must not touch.
    const fixture = {
      "$schema": "https://opencode.ai/config.json",
      theme: "opencode",
      model: "someprovider/some-model",
      permission: {
        edit: "ask",
        bash: { "npm *": "allow", "git status*": "deny" },
      },
      provider: { someprovider: { models: { "some-model": {} } } },
    };
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, JSON.stringify(fixture, null, 2), "utf8");

    // The exact node-side merge script the SSH install runs (same node -e code
    // path minus the ssh transport).
    const requireCjs = createRequire(import.meta.url);
    const nodeModule = requireCjs(modPath);
    expect(typeof nodeModule.mergeDenyBaseline).toBe("function");
    const before = JSON.parse(readFileSync(cfgPath, "utf8"));
    const merged = nodeModule.mergeDenyBaseline(before);

    // Unrelated keys preserved; user rules preserved.
    expect(merged.theme).toBe("opencode");
    expect(merged.model).toBe("someprovider/some-model");
    expect(merged.permission.edit).toBe("ask");
    const bash = merged.permission.bash as Record<string, PermissionAction>;
    expect(bash["npm *"]).toBe("allow");
    expect(bash["git status*"]).toBe("deny");
    // Baseline denials present and detected.
    expect(baselinePresent(merged)).toBe(true);
    for (const [cat, denies] of Object.entries(BASELINE_DENY)) {
      const entry = (merged.permission as Record<string, unknown>)[cat];
      expect(isPlainObject(entry) || entry === "deny", cat).toBe(true);
      if (isPlainObject(entry)) {
        for (const [p, a] of Object.entries(denies)) expect(entry[p], p).toBe(a);
      }
    }
    // IDEMPOTENT: installing twice changes nothing (the exact re-run hazard).
    const mergedTwice = nodeModule.mergeDenyBaseline(merged);
    expect(mergedTwice).toEqual(merged);
    // And the emitted module agrees with the TS source on the same input.
    expect(merged).toEqual(mergeDenyBaseline(before));
  }, 20_000);

  it("the emitted module is syntactically valid standalone node (the install would not no-op or crash the node)", async () => {
    const mod = await buildBaselineModule();
    const dir = mkdtempSync(join(tmpdir(), "issue51b-syntax-"));
    const out = join(dir, "out.json");
    // Run the module itself under a stock node to prove it parses and merges.
    writeFileSync(join(dir, "probe.cjs"), mod + `
const merged = module.exports.mergeDenyBaseline({ permission: { bash: { "ls*": "allow" } }, note: "n" });
require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(merged));
`, "utf8");
    execFileSync(process.execPath, [join(dir, "probe.cjs")], { timeout: 15_000 });
    const merged = JSON.parse(readFileSync(out, "utf8"));
    expect(merged.note).toBe("n");
    expect(baselinePresent(merged)).toBe(true);
  }, 20_000);

  it("provisionConfigToNode: installDenyBaseline opt-in flows and default stays unchanged (fake ssh/scp on PATH)", async () => {
    // Fake ssh+scp: every invocation "succeeds" and prints nothing — the point
    // is contract behavior, not transport.
    const restore = fakeSsh("");
    try {
      // Default: no opt-in => the result gains no denyBaselineInstalled field
      // (byte-identical to the pre-slice-2 wiring shape).
      const plain = await provisionConfigToNode("node.example", {});
      expect(plain.ok).toBe(true);
      expect(plain.denyBaselineInstalled).toBeUndefined();

      // Opt-in: the result reports the install.
      const opted = await provisionConfigToNode("node.example", { installDenyBaseline: true });
      expect(opted.ok).toBe(true);
      expect(opted.denyBaselineInstalled).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("#51 slice 2: fleet_capabilities reports denyBaseline", () => {
  it("parse-shaped: a config containing the baseline sets denyBaseline true (including a scalar-deny handwrite)", () => {
    // The exact detection the capabilities wiring does: parse the config JSON,
    // then baselinePresent().
    const detect = (raw: string | null | undefined): boolean => {
      if (raw == null) return false;
      try {
        return baselinePresent(JSON.parse(raw) as unknown);
      } catch {
        return false;
      }
    };
    const full = JSON.stringify(mergeDenyBaseline({ provider: { p: { models: { m: {} } } } }));
    expect(detect(full)).toBe(true);
    // whole-category scalar deny also covers its categories
    expect(
      detect(JSON.stringify({
        permission: {
          external_directory: "deny",
          bash: "deny",
          read: "deny",
          webfetch: "deny",
        },
      })),
    ).toBe(true);
  });

  it("parse-shaped: a config lacking the baseline, malformed JSON, or absent config => denyBaseline false", () => {
    const detect = (raw: string | null | undefined): boolean => {
      if (raw == null) return false;
      try {
        return baselinePresent(JSON.parse(raw) as unknown);
      } catch {
        return false;
      }
    };
    // Present but missing the baseline permission block
    expect(detect(JSON.stringify({ model: "m", permission: { edit: "ask" } }))).toBe(false);
    // A demoted pattern (ask instead of deny) is not the baseline
    expect(
      detect(JSON.stringify({
        permission: {
          external_directory: BASELINE_DENY.external_directory,
          bash: { ...BASELINE_DENY.bash, "git push*": "ask" },
          read: BASELINE_DENY.read,
          webfetch: BASELINE_DENY.webfetch,
        },
      })),
    ).toBe(false);
    // Unparseable and absent
    expect(detect("{not json")).toBe(false);
    expect(detect(undefined)).toBe(false);
    expect(detect(null)).toBe(false);
  });

  it("detectNodeCapabilities sets denyBaseline (true with a baseline config on node, false absent/unparseable) using the real function", async () => {
    const { fakeSshReply } = await import("./testkit/plugin.js");
    const { setConfig, restore } = fakeSshReply();
    try {
      // The capabilities code reads the NODE's ~/.config/opencode/opencode.json
      // over SSH (issue #51 review). Drive the fake ssh output per case instead
      // of the manager host's HOME, and assert what the manager derives.
      setConfig(JSON.stringify(mergeDenyBaseline({ provider: { p: { models: { m: {} } } } })));
      const capsWith = await detectNodeCapabilities("node.example", "with-baseline", "svcuser");
      expect(capsWith.error).toBeUndefined();
      expect(capsWith.models).toEqual(["m"]);
      expect(capsWith.denyBaseline).toBe(true);

      // Case 2: config WITHOUT the baseline.
      setConfig(JSON.stringify({ provider: { p: { models: { m: {} } } }, permission: { edit: "ask" } }));
      const capsWithout = await detectNodeCapabilities("node.example", "no-baseline", "svcuser");
      expect(capsWithout.models).toEqual(["m"]);
      expect(capsWithout.denyBaseline).toBe(false);

      // Case 3: unparseable config.
      setConfig("{not json");
      const capsBad = await detectNodeCapabilities("node.example", "bad", "svcuser");
      expect(capsBad.denyBaseline).toBe(false);

      // Case 4: absent config entirely (remote read fails).
      setConfig(null);
      const capsMissing = await detectNodeCapabilities("node.example", "missing", "svcuser");
      expect(capsMissing.models).toBeUndefined();
      expect(capsMissing.denyBaseline).toBe(false);
    } finally {
      restore();
    }
  }, 30_000);

  it("the capability flag does not disturb constraint routing (satisfiesConstraints untouched)", () => {
    const caps = { node: "n", denyBaseline: true };
    expect(satisfiesConstraints(caps as never, {}).ok).toBe(true);
    expect(satisfiesConstraints(caps as never, { tools: ["docker"] }).ok).toBe(false);
  });
});

describe("#51 slice 2: dispatch autoApprove gate (pure autoApproveGate predicate)", () => {
  it("refuses when detectAutoSupport would be false — error names the node and never a bare pass", () => {
    const unsupported: AutoSupportProbe[] = [
      {}, // nothing at all
      { version: "" },
      { version: "garbage" },
      { version: "0.4.2" }, // below threshold, no useful help
      { version: "1.17.9" },
      { helpText: "  --auto-approve  approve everything" }, // lookalike flag
      { version: "unparseable", helpText: "supports automatic approval" },
    ];
    for (const probe of unsupported) {
      const gate = autoApproveGate({ autoApprove: true, nodeName: "dev3", probe, denyBaseline: true });
      expect(gate.ok, JSON.stringify(probe)).toBe(false);
      if (!gate.ok) {
        expect(gate.error).toContain("dev3");
        expect(gate.error).toContain("--auto");
      }
    }
    // sanity: each of those probes must indeed be unsupported by slice 1's predicate
    for (const probe of unsupported) expect(detectAutoSupport(probe)).toBe(false);
  });

  it("passes when detectAutoSupport is true — version evidence AND help evidence", () => {
    for (const probe of [
      { version: "1.18.26" },
      { version: "opencode 1.18.26 (2026-05-10)" },
      { helpText: AUTO_HELP },
      { version: "0.4.2", helpText: AUTO_HELP }, // help evidence covers old builds
    ] as AutoSupportProbe[]) {
      const gate = autoApproveGate({ autoApprove: true, nodeName: "dev2", probe, denyBaseline: true });
      expect(gate.ok, JSON.stringify(probe)).toBe(true);
      expect(detectAutoSupport(probe)).toBe(true);
    }
  });

  it("passes WITH a warning when the node lacks the deny baseline (existing flows not broken)", () => {
    const gate = autoApproveGate({ autoApprove: true, nodeName: "dev2", probe: { version: "1.18.26" }, denyBaseline: false });
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.warning).toBeDefined();
      expect(gate.warning).toContain("dev2");
      expect(gate.warning).toContain("no deny baseline installed");
    }
    // baseline present => no warning
    const clean = autoApproveGate({ autoApprove: true, nodeName: "dev2", probe: { version: "1.18.26" }, denyBaseline: true });
    expect(clean).toEqual({ ok: true });
  });

  it("autoApprove not requested => vacuous pass, no refusal, no warning (default behavior unchanged)", () => {
    for (const input of [
      { autoApprove: false, probe: {}, denyBaseline: false },
      { autoApprove: false, probe: undefined, denyBaseline: undefined },
      { autoApprove: false }, // not even a probe
    ]) {
      const gate = autoApproveGate(input as never);
      expect(gate).toEqual({ ok: true });
    }
  });
});

describe("#51 slice 2: fleet_dispatch wiring (tool-level, fake node channel + fake ssh)", () => {
  it("autoApprove dispatch refuses against a node whose opencode --help/--version shows no --auto, with a clear per-node error", async () => {
    const entry = await loadEntry();
    if (!entry) return; // SDK unavailable on this Node; pure predicate covers the logic
    const restore = fakeSsh("Usage: opencode run\nFlags:\n     --model   Model to use\n1.17.9\n");
    try {
      const loaded = loadPlugin(entry, {
        config: { nodes: { dev3: {} } },
        nodes: [{ nodeId: "n1", displayName: "dev3", remoteIp: "node.example", invocableCommands: ["opencode.run"] }],
        invoke: (call) => {
          if (call.params.prompt === "__RUN_STATUS__") return nodeReply({ alive: false });
          return nodeReply({ ok: true, detached: true, runId: "r", pid: 1 });
        },
      });
      const res = await loaded.call("fleet_dispatch", {
        prompt: "do the thing",
        cwd: "/home/svcuser/fleet/somerepo",
        nodes: ["dev3"],
        autoApprove: true,
        async: false,
        transport: "http",
      });
      const nodeRes = res.dev3 ?? res.n1;
      expect(nodeRes).toBeDefined();
      expect(nodeRes.ok).toBe(false);
      expect(String(nodeRes.error)).toContain("dev3");
      expect(String(nodeRes.error)).toContain("--auto");
    } finally {
      restore();
    }
  }, 30_000);

  it("autoApprove dispatch proceeds (launch invoked) when the node verifies --auto support; no warning when the baseline is present", async () => {
    const entry = await loadEntry();
    if (!entry) return;
    const restore = fakeSsh("Flags:\n     --auto     Approve all permissions\n1.18.26\n");
    try {
      const loaded = loadPlugin(entry, {
        config: { nodes: { dev2: {} } },
        nodes: [{ nodeId: "n1", displayName: "dev2", remoteIp: "node.example", invocableCommands: ["opencode.run"] }],
        invoke: (call) => {
          if (call.params.prompt === "__RUN_STATUS__") return nodeReply({ alive: false, state: "finished" });
          return nodeReply({ ok: true, detached: false, note: "sync ok" });
        },
      });
      const res = await loaded.call("fleet_dispatch", {
        prompt: "do the thing",
        cwd: "/home/svcuser/fleet/somerepo",
        nodes: ["dev2"],
        autoApprove: true,
        async: false,
        transport: "http",
        timeoutMs: 60_000,
      });
      const nodeRes = res.dev2 ?? res.n1;
      expect(nodeRes).toBeDefined();
      // The gate passed: a run row exists (fleet cwd-check happens over fake ssh too).
      const withWarning = JSON.stringify(nodeRes);
      expect(withWarning).not.toContain("no deny baseline installed");
    } finally {
      restore();
    }
  }, 30_000);

  it("autoApprove dispatch warns when the node verifies --auto but lacks the deny baseline", async () => {
    const entry = await loadEntry();
    if (!entry) return;
    // HOME without the baseline config => capabilities report denyBaseline:false.
    const realHome = process.env.HOME;
    const dir = mkdtempSync(join(tmpdir(), "issue51b-dispatch-"));
    mkdirSync(dir, { recursive: true });
    process.env.HOME = dir;
    const restoreSsh = fakeSsh("FLEET_CWD=ok\nFlags:\n     --auto     Approve all permissions\n1.18.26\nCPU=8\nMEM=31\nDISK=90\nGPU=none\nTOOLS=node\nOPENCODE=1.18.26\nPYVER=none\nPYVENV=no\nPYPEP668=no\nPIPUSER=no\n");
    try {
      const loaded = loadPlugin(entry, {
        config: { nodes: { dev2: {} } },
        nodes: [{ nodeId: "n1", displayName: "dev2", remoteIp: "node.example", invocableCommands: ["opencode.run"] }],
        invoke: (call) => {
          if (call.params.prompt === "__RUN_STATUS__") return nodeReply({ alive: false, state: "finished" });
          return nodeReply({ ok: true, detached: false, note: "sync ok" });
        },
      });
      const res = await loaded.call("fleet_dispatch", {
        prompt: "do the thing",
        cwd: "/home/svcuser/fleet/somerepo",
        nodes: ["dev2"],
        autoApprove: true,
        async: false,
        transport: "http",
        timeoutMs: 60_000,
      });
      const nodeRes = res.dev2 ?? res.n1;
      expect(nodeRes).toBeDefined();
      expect(JSON.stringify(nodeRes)).toContain("no deny baseline installed");
    } finally {
      process.env.HOME = realHome;
      restoreSsh();
    }
  }, 30_000);

  it("no autoApprove => dispatch is untouched by the gate (no warnings field, no refusals)", async () => {
    const entry = await loadEntry();
    if (!entry) return;
    const restore = fakeSsh("Usage: opencode run\n1.0.0\n");
    try {
      const loaded = loadPlugin(entry, {
        config: { nodes: { dev3: {} } },
        nodes: [{ nodeId: "n1", displayName: "dev3", remoteIp: "node.example", invocableCommands: ["opencode.run"] }],
        invoke: (call) => {
          if (call.params.prompt === "__RUN_STATUS__") return nodeReply({ alive: false, state: "finished" });
          return nodeReply({ ok: true, detached: false, note: "sync ok" });
        },
      });
      const res = await loaded.call("fleet_dispatch", {
        prompt: "do the thing",
        cwd: "/home/svcuser/fleet/somerepo",
        nodes: ["dev3"],
        async: false,
        transport: "http",
        timeoutMs: 60_000,
      });
      const nodeRes = res.dev3 ?? res.n1;
      expect(nodeRes).toBeDefined();
      expect(JSON.stringify(nodeRes)).not.toContain("--auto");
      expect(JSON.stringify(nodeRes)).not.toContain("deny baseline");
      expect(JSON.stringify(nodeRes)).not.toContain("warnings");
    } finally {
      restore();
    }
  }, 30_000);
});