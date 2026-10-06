import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, mergeAnswers, normalizeAnswers, renderCharter, renderDecision, validateBacklog, writeProject } from "./project-start.js";
import { loadProjectRecord } from "./project-load.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

const full = {
  name: "demo",
  goal: "A CLI that converts markdown notes into a searchable static site for the team",
  users: ["the docs team"],
  constraints: ["Node 22 only"],
  nonGoals: ["no hosted service"],
  successCriteria: [{ criterion: "a build of the sample notes produces an index page", check: "npm run build && test -f dist/index.html" }],
  riskiestAssumptions: ["notes are under 10k files"],
};

describe("#116: assess", () => {
  it("an agent that refuses to define success cannot get ready, nor can it defer it", () => {
    for (const a of [{ ...full, successCriteria: [] }, { ...full, successCriteria: [{ criterion: "it works well enough", check: "" }] }]) {
      expect(assess(normalizeAnswers(a)).verdict).toBe("needs-more");
    }
    const d = assess(normalizeAnswers({ ...full, successCriteria: [], deferred: ["successCriteria"] }));
    expect(d.verdict).toBe("needs-more");
    expect(d.missing[0]!.field).toBe("successCriteria");
  });
  it("one sentence is not enough: vague goal and missing non-goals get specific follow-ups", () => {
    const a = assess(normalizeAnswers({ goal: "make a thing" }));
    expect(a.verdict).toBe("needs-more");
    expect(a.missing.map((m) => m.field)).toEqual(expect.arrayContaining(["goal", "successCriteria", "nonGoals", "users"]));
    expect(a.missing.find((m) => m.field === "goal")!.ask).toMatch(/too vague/);
  });
  it("complete answers are ready; a deferred non-goal is risky-but-proceed and recorded as a risk", () => {
    expect(assess(normalizeAnswers(full)).verdict).toBe("ready");
    const r = assess(normalizeAnswers({ ...full, nonGoals: [], deferred: ["nonGoals"] }));
    expect(r.verdict).toBe("risky-but-proceed");
    expect(r.risks[0]).toMatch(/nonGoals deferred/);
  });
  it("later rounds replace only the fields they send", () => {
    const prev = normalizeAnswers(full);
    const next = normalizeAnswers({ goal: "A different goal that is long enough to count" });
    expect(mergeAnswers(prev, next, new Set(["goal"]))).toMatchObject({ goal: "A different goal that is long enough to count", users: ["the docs team"] });
  });
});

describe("#116: charter and decision writing", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet116-"))); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const dec = () => { const r = renderDecision(1, { title: "Use a static site generator", decision: "Build with plain Node, no framework.", alternativesRejected: "A hosted service." }, "2026-10-06"); if ("error" in r) throw new Error(r.error); return r; };

  it("writes a charter and decision that the project loader accepts, deferred items recorded as risks", async () => {
    const a = normalizeAnswers({ ...full, nonGoals: [], deferred: ["nonGoals"] });
    const w = await writeProject(dir, renderCharter(a), [dec()]);
    expect(w).toEqual({ ok: true, written: [".fleet/charter.md", `.fleet/decisions/${dec().name}`] });
    const loaded = await loadProjectRecord(dir);
    expect(loaded.present && loaded.record.errors).toEqual([]);
    expect(loaded.present && loaded.record.charter?.goal).toContain("static site");
    expect(loaded.present && loaded.record.charter?.riskiestAssumptions?.join("|")).toContain("UNKNOWN (deferred at intake): nonGoals");
    expect(loaded.present && loaded.record.decisions).toHaveLength(1);
  });
  it("never clobbers an existing charter, decision number, or a symlinked .fleet", async () => {
    const c = renderCharter(normalizeAnswers(full));
    expect((await writeProject(dir, c, [])).ok).toBe(true);
    expect(await writeProject(dir, c, [])).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(readFileSync(join(dir, ".fleet", "charter.md"), "utf8")).toBe(c);
    const d2 = realpathSync(mkdtempSync(join(tmpdir(), "fleet116b-")));
    try {
      mkdirSync(join(d2, ".fleet", "decisions"), { recursive: true });
      writeFileSync(join(d2, ".fleet", "decisions", "0001-old.md"), "x");
      expect(await writeProject(d2, c, [dec()])).toMatchObject({ ok: false, error: expect.stringContaining("0001") });
      expect(existsSync(join(d2, ".fleet", "charter.md"))).toBe(false);
      const d3 = realpathSync(mkdtempSync(join(tmpdir(), "fleet116c-")));
      symlinkSync(d2, join(d3, ".fleet"));
      expect(await writeProject(d3, c, [])).toMatchObject({ ok: false, error: expect.stringContaining("symlink") });
      rmSync(d3, { recursive: true, force: true });
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });
  it("refuses a decision that does not validate", () => {
    expect(renderDecision(1, { title: "", decision: "x" }, "2026-10-06")).toHaveProperty("error");
    expect(renderDecision(1, { title: "ok", decision: "x" }, "yesterday")).toHaveProperty("error");
  });
});

describe("#116: validateBacklog", () => {
  const spec = (goal: string, files: string[], extra: Record<string, unknown> = {}) => ({ goal, acceptance: ["it works"], verify: { command: "./v.sh" }, scope: { files }, ...extra });
  it("accepts verifiable, scope-disjoint specs", () => {
    expect(validateBacklog([spec("a", ["src/a/"]), spec("b", ["src/b/"])])).toMatchObject({ ok: true, overlaps: [] });
  });
  it("rejects missing verify/acceptance/scope and overlapping scopes", () => {
    const r = validateBacklog([spec("a", ["src/"]), spec("b", ["src/x.ts"]), { goal: "c" }]);
    expect(r.ok).toBe(false);
    expect(r.overlaps).toEqual([[0, 1]]);
    expect(r.specs[2]!.errors.join("|")).toMatch(/acceptance.*verify.*scope/);
    expect(validateBacklog([]).ok).toBe(false);
    expect(validateBacklog("x").ok).toBe(false);
  });
});

describe("#116: fleet_project_start tool", () => {
  it("walks from one sentence to a written, validated project; resumes by projectId", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet116t-")));
    const t = loadPlugin((await loadEntry())!, { config: { project: { roots: [dir] } } });
    try {
      const r1 = await t.call("fleet_project_start", { answers: { goal: "a thing" } });
      expect(r1.verdict).toBe("needs-more");
      expect(r1.missing.length).toBeLessThanOrEqual(3);
      const id = r1.projectId;
      const refused = await t.call("fleet_project_start", { projectId: id, write: dir });
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("not complete") });
      expect(existsSync(join(dir, ".fleet"))).toBe(false);
      const r2 = await t.call("fleet_project_start", { projectId: id, answers: full });
      expect(r2.verdict).toBe("ready");
      expect(r2.charterPreview).toContain("## Goal");
      const w = await t.call("fleet_project_start", { projectId: id, write: dir, decisions: [{ title: "Use plain Node", decision: "No framework." }], backlog: [{ goal: "a", acceptance: ["x"], verify: { command: "./v.sh" }, scope: { files: ["a/"] } }] });
      expect(w).toMatchObject({ ok: true, write: { ok: true }, backlog: { ok: true } });
      expect(existsSync(join(dir, ".fleet", "charter.md"))).toBe(true);
      const again = await t.call("fleet_project_start", { projectId: id, write: dir });
      expect(again.write).toMatchObject({ ok: false });
    } finally { t.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("needs confirmRisks for a risky verdict and refuses paths outside project.roots", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet116u-")));
    const out = realpathSync(mkdtempSync(join(tmpdir(), "fleet116v-")));
    const t = loadPlugin((await loadEntry())!, { config: { project: { roots: [dir] } } });
    try {
      const a = { ...full, nonGoals: [], deferred: ["nonGoals"] };
      expect(await t.call("fleet_project_start", { answers: a, write: dir })).toMatchObject({ ok: false, error: expect.stringContaining("confirmRisks") });
      const id = (await t.call("fleet_project_start", { answers: a })).projectId;
      expect(await t.call("fleet_project_start", { projectId: id, write: out, confirmRisks: true })).toMatchObject({ ok: false, error: expect.stringContaining("project.roots") });
      expect(existsSync(join(out, ".fleet"))).toBe(false);
      expect((await t.call("fleet_project_start", { projectId: "Bad Id" })).ok).toBe(false);
    } finally { t.dispose(); rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
  });
});
