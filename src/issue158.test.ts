import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOpencodeRun } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { ingestRemoteProject } from "./project-remote.js";
import { OP_MIN_PROTOCOL, PROTOCOL_VERSION } from "./protocol.js";
import { loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

let root: string;
let dir: string;
const prevRoots = process.env.FLEET_ALLOWED_ROOTS;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet158-")));
  dir = join(root, "repo");
  mkdirSync(dir);
  process.env.FLEET_ALLOWED_ROOTS = root;
});
afterEach(() => {
  if (prevRoots === undefined) delete process.env.FLEET_ALLOWED_ROOTS; else process.env.FLEET_ALLOWED_ROOTS = prevRoots;
  rmSync(root, { recursive: true, force: true });
});
const read = async (cwd: string) => JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__PROJECT_READ__", op: "project.read", cwd })));
const fleet = (root: string) => { mkdirSync(join(root, ".fleet", "decisions"), { recursive: true }); return join(root, ".fleet"); };
const CHARTER = "---\nschemaVersion: 1\nname: demo\n---\n\n## Goal\n\nShip it\n";

describe("#158: node-side project.read", () => {
  it("returns raw text of exactly the known files and does not parse them", async () => {
    const f = fleet(dir);
    writeFileSync(join(f, "charter.md"), CHARTER);
    writeFileSync(join(f, "rules.yml"), "rules: [not even checked here\n");
    writeFileSync(join(f, "decisions", "0001-x.md"), "# d\n");
    writeFileSync(join(f, "decisions", "notes.txt"), "ignored");
    writeFileSync(join(f, "other.md"), "ignored");
    const r = await read(dir);
    expect(r).toMatchObject({ ok: true, present: true, protocol: PROTOCOL_VERSION });
    expect(r.raw.charterText).toBe(CHARTER);
    expect(r.raw.rulesText).toBe("rules: [not even checked here\n");
    expect(r.raw.decisionFiles).toEqual([{ name: "0001-x.md", text: "# d\n" }]);
    expect(r.raw.ignored).toEqual(expect.arrayContaining(["other.md", "decisions/notes.txt"]));
    expect(r.record).toBeUndefined();
  });
  it("reports present:false without a .fleet directory", async () => {
    expect(await read(dir)).toMatchObject({ ok: true, present: false });
  });
  it("refuses a symlinked file and an oversize file instead of reading them", async () => {
    const f = fleet(dir);
    writeFileSync(join(dir, "secret.txt"), "TOP-SECRET");
    symlinkSync(join(dir, "secret.txt"), join(f, "charter.md"));
    writeFileSync(join(f, "rules.yml"), "x".repeat(70 * 1024));
    const r = await read(dir);
    expect(JSON.stringify(r)).not.toContain("TOP-SECRET");
    expect(r.raw.charterText).toBeUndefined();
    expect(r.raw.rulesText).toBeUndefined();
    expect(r.raw.errors.map((e: { message: string }) => e.message).join("|")).toMatch(/symlink.*\|.*larger than/);
  });
  it("refuses a .fleet that is a symlink out of the repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fleet158-out-"));
    try {
      writeFileSync(join(outside, "charter.md"), "OUTSIDE");
      symlinkSync(outside, join(dir, ".fleet"));
      const r = await read(dir);
      expect(JSON.stringify(r)).not.toContain("OUTSIDE");
      expect(r.raw.errors[0].message).toMatch(/symlink/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("confines cwd to FLEET_ALLOWED_ROOTS on the node", async () => {
    const other = mkdtempSync(join(tmpdir(), "fleet158-other-"));
    try {
      fleet(other);
      writeFileSync(join(other, ".fleet", "charter.md"), "NOPE");
      const r = await read(other);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/refused/);
      expect(JSON.stringify(r)).not.toContain("NOPE");
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe("#158: the gateway never trusts the node's reply", () => {
  it("re-applies the caps and name rules to a hostile reply", () => {
    const ing = ingestRemoteProject({
      ok: true, present: true,
      raw: {
        charterText: "x".repeat(70 * 1024),
        rulesText: "rules: []\n",
        decisionFiles: [{ name: "../../etc/passwd", text: "p" }, { name: "0001-ok.md", text: "# ok" }, { name: 5, text: "x" }],
        errors: [{ file: "a", message: "m".repeat(5000) }, "junk", null],
        ignored: ["ok", 7, { a: 1 }],
      },
    });
    expect(ing.ok).toBe(true);
    if (!ing.ok || !ing.result.present) throw new Error("unreachable");
    expect(ing.result.files.sort()).toEqual(["decisions/0001-ok.md", "rules.yml"]);
    const msgs = ing.result.record.errors.map((e) => `${e.file}: ${e.message}`).join("\n");
    expect(msgs).toMatch(/charter\.md: node sent \d+ bytes, larger than/);
    expect(msgs).toMatch(/not a decision file/);
    expect(ing.result.record.errors.every((e) => e.message.length <= 200)).toBe(true);
    expect(ing.result.ignored).toEqual(["ok"]);
  });
  it("rejects garbage and a node's refusal without throwing", () => {
    expect(ingestRemoteProject("nope")).toMatchObject({ ok: false });
    expect(ingestRemoteProject({ ok: true, present: true, raw: 5 })).toMatchObject({ ok: false });
    expect(ingestRemoteProject({ ok: false, error: "refused: x" })).toMatchObject({ ok: false, error: expect.stringContaining("refused") });
    expect(ingestRemoteProject({ ok: true, present: false })).toEqual({ ok: true, result: { present: false } });
  });
  it("a node cannot smuggle a validated record: the gateway builds it from text, ignoring any `record`", () => {
    const ing = ingestRemoteProject({ ok: true, present: true, record: { rules: [{ id: "evil" }], errors: [] }, raw: { decisionFiles: [], errors: [], files: [], ignored: [] } });
    if (!ing.ok || !ing.result.present) throw new Error("unreachable");
    expect(JSON.stringify(ing.result.record)).not.toContain("evil");
  });
});

describe("#158: fleet_project_show {node, path}", () => {
  it("reads through the node and validates on the gateway", async () => {
    const entry = await loadEntry();
    const t = loadPlugin(entry!, {
      nodes: [{ nodeId: "n1", displayName: "kev", connected: true }],
      invoke: () => nodeReply({ ok: true, present: true, raw: { charterText: CHARTER, decisionFiles: [], errors: [], files: [], ignored: [] } }),
    });
    try {
      const r = await t.call("fleet_project_show", { node: "kev", path: "/srv/x" });
      expect(r).toMatchObject({ present: true, node: "kev" });
      expect(t.invokes[0]!.params).toMatchObject({ prompt: "__PROJECT_READ__", op: "project.read", cwd: "/srv/x" });
      expect(JSON.stringify(r.record)).toContain("Ship it");
    } finally { t.dispose(); }
  }, 30_000);
  it("reports an unknown node and a relative path", async () => {
    const entry = await loadEntry();
    const t = loadPlugin(entry!, { nodes: [] });
    try {
      expect((await t.call("fleet_project_show", { node: "nope", path: "/x" })).error).toMatch(/not found/);
      expect((await t.call("fleet_project_show", { node: "nope", path: "x" })).error).toMatch(/absolute/);
    } finally { t.dispose(); }
  }, 30_000);
});

describe("#158: protocol gate (older node)", () => {
  it("declares protocol 6 for the op", () => {
    expect(OP_MIN_PROTOCOL["project.read"]).toBe(6);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(6);
  });
  for (const pv of [0, 3, 5]) {
    it(`a protocol-${pv} node is refused by the gateway; only the probe is sent`, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const ctx = {
        params: { prompt: "__PROJECT_READ__", op: "project.read", cwd: "/srv/x" }, node: { nodeId: "n1" },
        invokeNode: async (a: { params: Record<string, unknown> }) => { seen.push(a.params); return { ok: true as const, payload: { ok: true, ...(pv > 0 ? { protocol: pv } : {}) } }; },
      } as unknown as PolicyCtx;
      const r = await handleOpencodeRunPolicy(ctx, newProtocolCache());
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/cannot honor op project.read/);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ prompt: "__RUN_STATUS__" });
    });
  }
});
