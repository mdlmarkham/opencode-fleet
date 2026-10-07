import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMission, loadMission, readJournal } from "./mission-store.js";
import { readinessOfRecord } from "./mission-plan.js";
import { fakeSshMultiline, loadEntry, loadPlugin } from "./testkit/plugin.js";

const good = (id: string, files: string[], deps: string[] = []) => ({ id, goal: `do ${id}`, deps, scope: { files }, task: { goal: `do ${id}`, acceptance: [`${id}() returns 1`], verify: { command: "./scripts/verify.sh" }, scope: { files } } });

describe("#129: a stored mission must be ready before approval", () => {
  let root: string;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));
  const make = async (specs: unknown[], opts: Parameters<typeof createMission>[3] = {}) => {
    root = mkdtempSync(join(tmpdir(), "fleet129b-"));
    const m = await createMission(root, "m1", specs as never, { target: { cwd: "/w/p" }, ...opts });
    if (!m.ok) throw new Error(m.error);
    return m.record;
  };

  it("complete specs and disjoint scopes: no blockers; the gaps the record cannot carry are warnings only", async () => {
    const r = readinessOfRecord(await make([good("a", ["a/"]), good("b", ["b/"], ["a"])]));
    expect(r.blocking).toEqual([]);
    const areas = r.warnings.map((w) => w.area);
    expect(areas).toContain("budget");
    expect(areas).not.toContain("test plan"); // the record cannot carry one yet: never reported as a gap
  });

  it("a spec with no acceptance, verify or scope BLOCKS, naming exactly what is missing", async () => {
    const r = readinessOfRecord(await make([{ id: "a", goal: "vague", deps: [], task: { goal: "vague" } }]));
    expect(r.verdict).toBe("needs-more");
    expect(r.blocking.map((m) => `${m.area}: ${m.what}`)).toEqual(expect.arrayContaining(["spec a: no acceptance criteria", "spec a: no verify gate", "spec a: no scope"]));
  });

  it("overlapping scopes with no dependency BLOCK", async () => {
    const r = readinessOfRecord(await make([good("a", ["src/"]), good("b", ["src/x.ts"])]));
    expect(r.blocking.some((m) => m.area === "scopes")).toBe(true);
  });

  it("a budget, once set, clears its warning", async () => {
    const r = readinessOfRecord(await make([good("a", ["a/"])], { budget: { maxCostUsd: 5 } }));
    expect(r.warnings.map((w) => w.area)).not.toContain("budget");
  });
});

describe("#129: fleet_mission_run refuses to approve an unready plan", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  it("blocks with the readiness detail and leaves the phase untouched; a ready plan is approved and the warnings journaled", async () => {
    const loaded = await loadEntry();
    if (!loaded) return;
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
    const t = loadPlugin(loaded, { nodes: [{ nodeId: "n1", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }], config: { nodes: { dev2: { roles: ["worker"], ssh: false } } } });
    try {
      // A mission created outside the tool (no task on its spec) is not ready.
      await createMission(t.rootDir, "bad", [{ id: "a", goal: "vague", deps: [] }] as never, { target: { cwd: "/w/p" } });
      const refused = await t.call("fleet_mission_run", { missionId: "bad", approve: true }) as Record<string, any>;
      expect(refused).toMatchObject({ ok: false, error: "the plan is not ready to approve", readiness: { verdict: "needs-more" } });
      expect(refused.readiness.blocking.length).toBeGreaterThan(0);
      expect((await loadMission(t.rootDir, "bad") as { record: { phase: string } }).record.phase).toBe("designing");

      const made = await t.call("fleet_mission_run", { missionId: "ok", create: { cwd: "/w/p", specs: [{ id: "a", goal: "do a", task: { goal: "do a", acceptance: ["a() returns 1"], verify: { command: "./scripts/verify.sh" }, scope: { files: ["a/"] } } }] } }) as Record<string, any>;
      expect(made.ok).not.toBe(false);
      const go = await t.call("fleet_mission_run", { missionId: "ok", approve: true }) as Record<string, any>;
      expect(go.ok === false).toBe(false);
      const j = await readJournal(t.rootDir, "ok");
      expect(j.some((e) => e.type === "approved-with-warnings")).toBe(true);
    } finally { t.dispose(); }
  });
});
