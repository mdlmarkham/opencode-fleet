import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReview, loadReviews, reviewGate, reviewsPath, validateReview, type ReviewRecord } from "./review.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ok = { command: "npm test", exitCode: 0, outputTail: "63 files passed" };
const base = { verdict: "PASS", headSha: A, reviewer: "rev-1", author: "dev-2", pr: 7, evidence: { commands: [ok] } };
const rec = (over: Record<string, unknown> = {}, id = "rv-1"): ReviewRecord => {
  const v = validateReview({ ...base, ...over }, new Date("2026-10-05T12:00:00Z"), id);
  if (!v.ok) throw new Error(v.error);
  return v.record;
};

describe("#177: validateReview", () => {
  it("accepts a PASS with executed-command evidence", () => {
    expect(validateReview(base).ok).toBe(true);
  });
  it("refuses a PASS without evidence, or with only failing commands", () => {
    expect(validateReview({ ...base, evidence: undefined })).toMatchObject({ ok: false });
    expect(validateReview({ ...base, evidence: { commands: [] } })).toMatchObject({ ok: false });
    expect(validateReview({ ...base, evidence: { commands: [{ ...ok, exitCode: 1 }] } })).toMatchObject({ ok: false });
  });
  it("refuses a PASS whose evidence contains ANY failed command, even next to a passing one (#184)", () => {
    const mixed = { ...base, evidence: { commands: [{ command: "scripts/verify.sh", exitCode: 1, outputTail: "FAIL" }, ok] } };
    const r = validateReview(mixed);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toContain("scripts/verify.sh");
    expect(r.ok === false && r.error).toContain("exit 1");
    // Order must not matter.
    expect(validateReview({ ...base, evidence: { commands: [ok, { command: "npm run build", exitCode: 2, outputTail: "" }] } })).toMatchObject({ ok: false });
    // The same evidence is fine for a FAIL, which is the honest verdict for it.
    expect(validateReview({ ...mixed, verdict: "FAIL", findings: [{ severity: "blocking", summary: "verify fails" }] }).ok).toBe(true);
  });
  it("refuses a PASS carrying a blocking or major finding; minor/nit is fine", () => {
    expect(validateReview({ ...base, findings: [{ severity: "major", summary: "x" }] })).toMatchObject({ ok: false });
    expect(validateReview({ ...base, findings: [{ severity: "nit", summary: "x" }] }).ok).toBe(true);
  });
  it("BLOCKED needs no evidence; FAIL needs findings", () => {
    expect(validateReview({ verdict: "BLOCKED", headSha: A, reviewer: "r" }).ok).toBe(true);
    expect(validateReview({ verdict: "FAIL", headSha: A, reviewer: "r" })).toMatchObject({ ok: false });
    expect(validateReview({ verdict: "FAIL", headSha: A, reviewer: "r", findings: [{ severity: "blocking", summary: "bug" }] }).ok).toBe(true);
  });
  it("requires a full 40-hex sha, a reviewer, and independence from the author", () => {
    expect(validateReview({ ...base, headSha: "abc123" })).toMatchObject({ ok: false });
    expect(validateReview({ ...base, reviewer: "" })).toMatchObject({ ok: false });
    expect(validateReview({ ...base, reviewer: "Dev-2" })).toMatchObject({ ok: false, error: expect.stringContaining("independent") });
  });
  it("redacts and bounds reviewer text; ordinary text (shas, run ids) is untouched", () => {
    const secret = ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
    const r = validateReview({ ...base, evidence: { commands: [{ command: "npm test", exitCode: 0, outputTail: `token ${secret} run-d8b4fb19 ${B}` }] }, note: "x".repeat(5000) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = r.record.evidence.commands[0]!.outputTail;
      expect(t).not.toContain(secret);
      expect(t).toContain("run-d8b4fb19");
      expect(t).toContain(B);
      expect(r.record.note!.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("#178: reviewGate", () => {
  it("allows only a PASS for exactly this head", () => {
    expect(reviewGate([rec()], A)).toMatchObject({ allow: true, status: "PASS" });
  });
  it("no record, malformed sha: refused", () => {
    expect(reviewGate([], A)).toMatchObject({ allow: false, status: "NONE" });
    expect(reviewGate([rec()], "abc")).toMatchObject({ allow: false });
  });
  it("a PASS for an older head is STALE, never a PASS (the head moved)", () => {
    const g = reviewGate([rec()], B, 7);
    expect(g).toMatchObject({ allow: false, status: "STALE" });
    expect(g.reason).toContain("older head");
    // Without the pr the older review is simply not for this head.
    expect(reviewGate([rec()], B)).toMatchObject({ allow: false, status: "NONE" });
  });
  it("the latest record for the sha decides: a later FAIL or BLOCKED withdraws a PASS", () => {
    const fail = rec({ verdict: "FAIL", findings: [{ severity: "blocking", summary: "bug" }], evidence: undefined }, "rv-2");
    expect(reviewGate([rec(), fail], A)).toMatchObject({ allow: false, status: "FAIL" });
    const blocked = rec({ verdict: "BLOCKED", evidence: undefined }, "rv-3");
    expect(reviewGate([rec(), blocked], A)).toMatchObject({ allow: false, status: "BLOCKED" });
    expect(reviewGate([fail, rec({}, "rv-4")], A)).toMatchObject({ allow: true });
  });
});

describe("#177: store", () => {
  it("round-trips, skips a torn tail, and ignores foreign lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-rv-"));
    expect(await loadReviews(root)).toEqual([]);
    await appendReview(root, rec());
    appendFileSync(reviewsPath(root), '{"verdict":"PASS","headSha":"nope"}\n{"verdict":"PA');
    const got = await loadReviews(root);
    expect(got).toHaveLength(1);
    expect(readFileSync(reviewsPath(root), "utf8")).toContain("rv-1");
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the review tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#177/#178: tools", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  const NODES = [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }];
  const load = (sync?: Record<string, unknown>) => (p = loadPlugin(loaded!, { nodes: NODES, invoke: () => nodeReply({ ok: false, error: "stub node" }), config: { nodes: { dev2: { roles: ["worker"], ssh: false } }, ...(sync ? { sync } : {}) } }));
  const sync = (extra: Record<string, unknown> = {}) => p!.call("fleet_sync", { node: "dev2", cwd: "/w", repo: "https://example.invalid/r.git", ...extra });

  it("record refuses a PASS without evidence, then records one with it; check reflects the sha", async () => {
    load();
    expect(await p!.call("fleet_review", { action: "record", headSha: A, verdict: "PASS", reviewer: "r" })).toMatchObject({ ok: false });
    expect(await p!.call("fleet_review", { action: "check", headSha: A })).toMatchObject({ allow: false, status: "NONE" });
    expect(await p!.call("fleet_review", { action: "record", ...base })).toMatchObject({ ok: true, verdict: "PASS" });
    expect(await p!.call("fleet_review", { action: "check", headSha: A })).toMatchObject({ allow: true, status: "PASS" });
    expect(await p!.call("fleet_review", { action: "check", headSha: B, pr: 7 })).toMatchObject({ allow: false, status: "STALE" });
  });

  it("a PASS with a failed evidence command is refused through the tool, and the head stays unreviewed (#184)", async () => {
    load({ requireReview: true });
    const mixed = { action: "record", ...base, evidence: { commands: [{ command: "scripts/verify.sh", exitCode: 1, outputTail: "FAIL" }, ok] } };
    expect(await p!.call("fleet_review", mixed)).toMatchObject({ ok: false, error: expect.stringContaining("failed command") });
    expect(await p!.call("fleet_review", { action: "check", headSha: A })).toMatchObject({ allow: false, status: "NONE" });
    expect(await sync({ head: A })).toMatchObject({ ok: false, review: "NONE" });
  });

  it("sync.requireReview refuses with no head, no review, a stale head and a BLOCKED review", async () => {
    load({ requireReview: true });
    expect(await sync()).toMatchObject({ ok: false, error: expect.stringContaining("requireReview") });
    expect(await sync({ head: A })).toMatchObject({ ok: false, review: "NONE" });
    await p!.call("fleet_review", { action: "record", ...base });
    expect(await sync({ head: B })).toMatchObject({ ok: false, review: "NONE" });
    await p!.call("fleet_review", { action: "record", verdict: "BLOCKED", headSha: A, reviewer: "r2" });
    expect(await sync({ head: A })).toMatchObject({ ok: false, review: "BLOCKED" });
  });

  it("with a PASS for the head the review gate lets sync proceed; with requireReview off it never looks", async () => {
    load({ requireReview: true });
    await p!.call("fleet_review", { action: "record", ...base });
    const r = await sync({ head: A });
    expect(JSON.stringify(r)).not.toContain("requireReview");
    p!.dispose();
    load();
    const off = await sync();
    expect(JSON.stringify(off)).not.toContain("requireReview");
  });
});
