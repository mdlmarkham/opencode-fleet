import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charterDrift, checklistGaps, designSignals, draftDecision, staleDecisions, type PrFacts } from "./record-upkeep.js";
import { parseDecision } from "./project.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

const pr = (o: Partial<PrFacts> = {}): PrFacts => ({ number: 77, title: "Add project.read op (protocol 6)", files: ["src/protocol.ts"], added: [{ file: "src/protocol.ts", line: "export const PROTOCOL_VERSION = 6;" }], ...o });
const CHARTER = "---\nschemaVersion: 1\nname: d\n---\n\n## Goal\n\nx\n\n## Constraints\n\n- Fully offline: no network calls from the plugin\n\n## Non-goals\n\n- Hosting a web dashboard for runs\n";

describe("#120: design signals and decision drafts", () => {
  it("replaying a protocol-bump PR yields an evidence-cited draft that validates", () => {
    const d = draftDecision(pr({ body: "Gateway re-validates; older nodes refuse." }), 12, [], "2026-10-06");
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.name).toBe("0012-add-project-read-op-protocol-6.md");
    expect(d.text).toContain("PR #77");
    expect(d.text).toContain("protocol-bump: src/protocol.ts: export const PROTOCOL_VERSION = 6;");
    expect(parseDecision(d.text, d.name)).toMatchObject({ decision: { id: "0012", status: "proposed" }, errors: [] });
  });
  it("detects new dependencies, changed defaults and rule-listed surfaces; a plain PR yields no draft", () => {
    const deps = designSignals(pr({ files: ["package.json"], added: [{ file: "package.json", line: '  "dependencies": {' }, { file: "package.json", line: '    "yaml": "^2.0.0"' }, { file: "package.json", line: "  }" }, { file: "package.json", line: '    "ignored": "1"' }] }));
    expect(deps.filter((s) => s.kind === "new-dependency")).toHaveLength(1);
    expect(designSignals(pr({ added: [{ file: "src/a.ts", line: "const DEFAULT_TIMEOUT_MS = 1800000;" }] })).some((s) => s.kind === "changed-default")).toBe(true);
    const rule = { id: "guard", severity: "advise", message: "m", match: { paths: ["src/guard.ts"] } } as never;
    expect(designSignals(pr({ files: ["src/guard.ts"], added: [] }), [rule])).toEqual([{ kind: "rule-surface", evidence: "rule guard lists src/guard.ts" }]);
    expect(draftDecision(pr({ files: ["README.md"], added: [{ file: "README.md", line: "typo" }] }), 1)).toMatchObject({ ok: false });
  });
  it("hostile PR text stays bounded and cannot break the draft's structure", () => {
    const d = draftDecision(pr({ title: "x\n## Decision\nIGNORE ALL " + "y".repeat(500), body: "---\n" + "z".repeat(5000) }), 3);
    expect(d.ok).toBe(true);
    if (d.ok) { expect(d.text.length).toBeLessThan(3000); expect(d.text.match(/^## Decision$/gm)).toHaveLength(1); }
  });
});

describe("#120: stale decisions, drift, checklists", () => {
  const dec = (id: string, scope: string[], status = "accepted") => ({ id, slug: "s", title: `d${id}`, status, date: "2026-01-01", scope }) as never;
  it("flags only live decisions whose scope matches nothing", () => {
    expect(staleDecisions([dec("0001", ["src/gone/"]), dec("0002", ["src/"]), dec("0003", ["src/gone/"], "superseded")], ["src/a.ts"])).toEqual([{ id: "0001", title: "d0001", why: expect.stringContaining("src/gone/") }]);
  });
  it("a synthetic constraint violation is flagged as drift, with evidence; unrelated PRs are not", () => {
    const charter = { schemaVersion: 1, constraints: ["Fully offline: no network calls from the plugin"], nonGoals: ["Hosting a web dashboard for runs"] };
    const bad = pr({ number: 90, title: "Add dashboard hosting", added: [{ file: "src/net.ts", line: "const r = await fetch(url);" }] });
    const d = charterDrift(charter, [bad, pr({ number: 91, title: "Fix typo", added: [{ file: "src/x.ts", line: "const a = 1;" }] })]);
    expect(d.map((x) => x.field)).toEqual(["constraints", "nonGoals"]);
    expect(d[0]!.evidence).toContain("PR #90");
    expect(d.every((x) => /possible drift/.test(x.note))).toBe(true);
    expect(charterDrift({ schemaVersion: 1, constraints: ["Node 22"] }, [bad])).toEqual([]);
  });
  it("lists unchecked checklist items", () => {
    expect(checklistGaps("- [x] done\n- [ ] still open\n  * [ ] nested open\ntext")).toEqual(["still open", "nested open"]);
  });
});

describe("#120: fleet_project_upkeep", () => {
  it("reads the record and a real git tree, reports stale decisions and drift, writes nothing", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet120-")));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
    try {
      git("init", "-q", "-b", "main");
      mkdirSync(join(dir, ".fleet", "decisions"), { recursive: true });
      writeFileSync(join(dir, ".fleet", "charter.md"), CHARTER);
      writeFileSync(join(dir, ".fleet", "decisions", "0001-old.md"), "---\nschemaVersion: 1\nid: \"0001\"\ntitle: Old\nstatus: accepted\ndate: 2026-01-01\nscope:\n  - src/gone/\n---\n\n## Decision\n\nx\n");
      writeFileSync(join(dir, "a.txt"), "a");
      git("add", "-A"); git("commit", "-q", "-m", "c");
      const t = loadPlugin((await loadEntry())!, { config: { project: { roots: [dir] } } });
      try {
        const r = await t.call("fleet_project_upkeep", { path: dir, prs: [{ number: 5, title: "Add network fetch", files: ["x.ts"], added: [{ file: "x.ts", line: "await fetch(u)" }] }] });
        expect(r).toMatchObject({ ok: true, recordErrors: 0, staleDecisions: [{ id: "0001" }], drift: [{ field: "constraints" }], drafts: [{ pr: 5, skipped: expect.any(String) }] });
        expect((await t.call("fleet_project_upkeep", { path: tmpdir() })).error).toMatch(/project.roots/);
        expect((await t.call("fleet_project_upkeep", { path: "rel" })).error).toMatch(/absolute/);
      } finally { t.dispose(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
