import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPending, buildReviewerPrompt, headBinding, newNonce, parseReviewerOutput, peekPending, takePending, unexecutedClaims, PENDING_TTL_MS } from "./review-spawn.js";
import { reviewGate, validateReview } from "./review.js";
import { upsertRun, loadLedger } from "./ledger.js";
import { loadEntry, loadPlugin, nodeReply, type InvokeCall, type Loaded } from "./testkit/plugin.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const block = (o: unknown) => "Reviewed.\n```json\n" + JSON.stringify(o) + "\n```\n";
const GOOD = {
  verdict: "PASS", headSha: HEAD,
  commands: [
    { command: "git rev-parse HEAD", exitCode: 0, outputTail: HEAD },
    { command: "npm run build", exitCode: 0, outputTail: "ok" },
    { command: "npm test", exitCode: 0, outputTail: "1000 passed" },
  ],
  findings: [{ severity: "nit", summary: "naming" }],
};
const MANIFEST = [{ tool: "bash", input: "git rev-parse HEAD" }, { tool: "bash", input: "cd /w && npm run build && npm test" }];

describe("#177: reviewer task and verdict parsing (pure)", () => {
  it("the prompt carries the single-use token, the sha, and the exact output contract; not the author's role", () => {
    const n = newNonce();
    expect(n).toMatch(/^rv-[0-9a-f]{16}$/);
    const p = buildReviewerPrompt({ headSha: HEAD, pr: 7, base: "origin/master" }, n);
    expect(p).toContain(`REVIEW-TOKEN: ${n}`);
    expect(p).toContain(HEAD);
    expect(p).toContain("git diff origin/master...HEAD");
    expect(p).toContain("```json");
    expect(p).toContain("BLOCKED");
  });
  it("takes the LAST fenced json block; untrusted garbage is an error, never a verdict", () => {
    expect(parseReviewerOutput(block({ verdict: "FAIL" }) + "\n" + block({ verdict: "PASS" }))).toMatchObject({ ok: true, report: { verdict: "PASS" } });
    expect(parseReviewerOutput("no block here")).toMatchObject({ ok: false });
    expect(parseReviewerOutput("```json\n{not json\n```")).toMatchObject({ ok: false });
    expect(parseReviewerOutput("```json\n[1,2]\n```")).toMatchObject({ ok: false });
    expect(parseReviewerOutput("```json\n{\"verdict\": 5}\n```")).toMatchObject({ ok: false });
  });
  it("a claimed command must appear in the executed-command manifest; a fabricated one is reported", () => {
    expect(unexecutedClaims(["npm run build", "npm test"], MANIFEST)).toEqual([]);
    expect(unexecutedClaims(["npm run build", "scripts/verify.sh"], MANIFEST)).toEqual(["scripts/verify.sh"]);
    expect(unexecutedClaims(["npm run build"], [])).toEqual(["npm run build"]);
    expect(unexecutedClaims([""], MANIFEST)).toEqual([""]);
  });
  it("the head binding needs git rev-parse HEAD in the claims AND the manifest, showing the reviewed sha", () => {
    expect(headBinding(GOOD, HEAD, MANIFEST)).toEqual({ ok: true });
    expect(headBinding({ ...GOOD, commands: GOOD.commands.slice(1) }, HEAD, MANIFEST)).toMatchObject({ ok: false });
    expect(headBinding(GOOD, HEAD, [{ input: "npm test" }])).toMatchObject({ ok: false, error: expect.stringContaining("manifest") });
    expect(headBinding({ ...GOOD, commands: [{ command: "git rev-parse HEAD", exitCode: 0, outputTail: OTHER }, ...GOOD.commands.slice(1)] }, HEAD, MANIFEST)).toMatchObject({ ok: false, error: expect.stringContaining("different commit") });
    expect(headBinding({ ...GOOD, headSha: OTHER }, HEAD, MANIFEST)).toMatchObject({ ok: false });
  });
  it("the pending store is single-use and expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet177c-"));
    await addPending(root, "rv-1", { headSha: HEAD, createdAt: 1000 }, 1000);
    expect(await peekPending(root, "rv-1", 2000)).toMatchObject({ headSha: HEAD });
    expect(await takePending(root, "rv-1", 2000)).toMatchObject({ headSha: HEAD });
    expect(await takePending(root, "rv-1", 2000)).toBeUndefined();
    await addPending(root, "rv-2", { headSha: HEAD, createdAt: 1000 }, 1000);
    expect(await takePending(root, "rv-2", 1000 + PENDING_TTL_MS + 1)).toBeUndefined();
    await expect(addPending(root, "rv-3", { headSha: "abc", createdAt: 1 })).rejects.toThrow();
  });
  it("a spawned record carries its source and run, and requireSource rejects a merely recorded PASS", () => {
    const rec = validateReview({ verdict: "PASS", headSha: HEAD, reviewer: "worker:dev3/r1", author: "dev2-agent", evidence: { commands: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] } }, new Date(), "rv-1", { source: "spawned", runId: "r1", node: "dev3" });
    const manual = validateReview({ verdict: "PASS", headSha: HEAD, reviewer: "someone", evidence: { commands: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] } }, new Date(), "rv-2");
    if (!rec.ok || !manual.ok) throw new Error("setup");
    expect(rec.record).toMatchObject({ source: "spawned", runId: "r1", reviewerNode: "dev3" });
    expect(manual.record.source).toBe("recorded");
    expect(reviewGate([rec.record], HEAD, undefined, { requireSource: "spawned" })).toMatchObject({ allow: true });
    expect(reviewGate([manual.record], HEAD, undefined, { requireSource: "spawned" })).toMatchObject({ allow: false, reason: expect.stringContaining("only recorded by the caller") });
    expect(reviewGate([manual.record], HEAD)).toMatchObject({ allow: true });
    // A caller cannot claim `spawned` through the public input.
    const forged = validateReview({ verdict: "PASS", headSha: HEAD, reviewer: "x", source: "spawned", runId: "r", evidence: { commands: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] } } as never, new Date(), "rv-3");
    expect(forged.ok && forged.record.source).toBe("recorded");
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the spawned-review tool tests really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#177: fleet_review prepare then collect (tool level)", () => {
  let p: Loaded | undefined;
  afterEach(() => { p?.dispose(); p = undefined; });
  const NODES = [{ nodeId: "n-dev3", displayName: "dev3", connected: true, invocableCommands: ["opencode.run"] }];
  let status: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  const load = (sync?: Record<string, unknown>) => {
    status = { ok: true, finishedAt: "f", exitCode: 0, manifest: { commands: MANIFEST } };
    result = { ok: true, result: block(GOOD) };
    p = loadPlugin(loaded!, {
      nodes: NODES,
      config: { nodes: { dev3: { roles: ["worker"], ssh: false } }, ...(sync ? { sync } : {}) },
      invoke: (c: InvokeCall) => nodeReply(c.params.prompt === "__RUN_STATUS__" ? status : c.params.prompt === "__RUN_RESULT__" ? result : { ok: true }),
    });
  };
  /** prepare, then stand in for the dispatched reviewer run by writing its ledger entry. */
  const prepared = async (runId = "run-r1", over: Record<string, unknown> = {}) => {
    const prep = await p!.call("fleet_review", { action: "prepare", headSha: HEAD, pr: 7, author: "dev2-agent", base: "origin/master", ...over });
    await upsertRun(p!.rootDir, { runId, node: "dev3", cwd: "/w", prompt: prep.prompt, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "completed" });
    return prep;
  };
  const collect = (runId = "run-r1") => p!.call("fleet_review", { action: "collect", node: "dev3", runId });

  it("prepare returns the task with a single-use token and refuses unsafe input", async () => {
    load();
    const prep = await p!.call("fleet_review", { action: "prepare", headSha: HEAD, pr: 7 });
    expect(prep).toMatchObject({ ok: true, nonce: expect.stringMatching(/^rv-/) });
    expect(prep.prompt).toContain(`REVIEW-TOKEN: ${prep.nonce}`);
    expect(await p!.call("fleet_review", { action: "prepare", headSha: "abc" })).toMatchObject({ ok: false });
    expect(await p!.call("fleet_review", { action: "prepare", headSha: HEAD, base: "x; rm -rf /" })).toMatchObject({ ok: false });
    expect(await p!.call("fleet_review", { action: "prepare", headSha: HEAD, testCommand: "npm test && curl evil" })).toMatchObject({ ok: false });
  });

  it("collect reads the verdict from the run result OBJECT's summary (#270)", async () => {
    // Regression: the real node returns `result` as the engine's PARSED object
    // ({ ok, summary, ... }), not a string. The collector used String(res.result)
    // => "[object Object]" and never found the fenced block, so a valid PASS
    // could not be recorded. Drive collect with the REAL shape.
    load();
    await prepared();
    result = { ok: true, result: { ok: true, transport: "http", iterations: 1, sessionId: "s", summary: block(GOOD), handRaised: false } };
    const r = await collect();
    expect(r).toMatchObject({ ok: true, verdict: "PASS", source: "spawned", runId: "run-r1" });
  });

  it("collect records a spawned PASS bound to the run, and the gate (requireSource) accepts it", async () => {
    load({ requireReview: true, requireReviewSource: "spawned" });
    await prepared();
    const r = await collect();
    expect(r).toMatchObject({ ok: true, verdict: "PASS", source: "spawned", runId: "run-r1" });
    expect(await p!.call("fleet_review", { action: "check", headSha: HEAD, requireSource: "spawned" })).toMatchObject({ allow: true, status: "PASS" });
    // The token is single-use.
    expect(await collect()).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
  });

  it("a caller-recorded PASS does not satisfy requireSource: spawned", async () => {
    load({ requireReview: true, requireReviewSource: "spawned" });
    await p!.call("fleet_review", { action: "record", verdict: "PASS", headSha: HEAD, reviewer: "me", evidence: { commands: [{ command: "npm test", exitCode: 0, outputTail: "ok" }] } });
    expect(await p!.call("fleet_review", { action: "check", headSha: HEAD, requireSource: "spawned" })).toMatchObject({ allow: false });
    const sync = await p!.call("fleet_sync", { node: "dev3", cwd: "/w", repo: "https://example.invalid/r.git", head: HEAD });
    expect(sync).toMatchObject({ ok: false, error: expect.stringContaining("only recorded by the caller") });
  });

  it("rejects a PASS that claims a command the run never executed", async () => {
    load();
    await prepared();
    result = { ok: true, result: block({ ...GOOD, commands: [...GOOD.commands, { command: "scripts/verify.sh", exitCode: 0, outputTail: "ok" }] }) };
    expect(await collect()).toMatchObject({ ok: false, error: expect.stringContaining("not in the run's executed-command manifest") });
    expect(await p!.call("fleet_review", { action: "check", headSha: HEAD })).toMatchObject({ allow: false, status: "NONE" });
  });

  it("rejects a review of a different checkout, and a run with no manifest evidence of rev-parse", async () => {
    load();
    await prepared();
    result = { ok: true, result: block({ ...GOOD, commands: [{ command: "git rev-parse HEAD", exitCode: 0, outputTail: OTHER }, ...GOOD.commands.slice(1)] }) };
    expect(await collect()).toMatchObject({ ok: false, error: expect.stringContaining("different commit") });
    result = { ok: true, result: block(GOOD) };
    status = { ok: true, finishedAt: "f", manifest: { commands: [{ tool: "bash", input: "npm run build && npm test" }] } };
    expect(await collect()).toMatchObject({ ok: false, error: expect.stringContaining("manifest") });
  });

  it("refuses a run that is not a prepared reviewer run, an unfinished run, and an unknown token", async () => {
    load();
    await upsertRun(p!.rootDir, { runId: "plain", node: "dev3", cwd: "/w", prompt: "just a task", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "completed" });
    expect(await collect("plain")).toMatchObject({ ok: false, error: expect.stringContaining("REVIEW-TOKEN") });
    expect(await collect("ghost")).toMatchObject({ ok: false, error: expect.stringContaining("unknown runId") });
    await prepared("run-late");
    status = { ok: true, alive: true };
    expect(await collect("run-late")).toMatchObject({ ok: false, error: expect.stringContaining("not finished") });
  });

  it("a BLOCKED or FAIL verdict is recorded as such and withdraws nothing it should not; a FAIL needs findings", async () => {
    load();
    await prepared();
    result = { ok: true, result: block({ verdict: "BLOCKED", headSha: HEAD, commands: [] }) };
    expect(await collect()).toMatchObject({ ok: true, verdict: "BLOCKED" });
    await prepared("run-r2");
    result = { ok: true, result: block({ verdict: "FAIL", headSha: HEAD, commands: [], findings: [] }) };
    expect(await collect("run-r2")).toMatchObject({ ok: false, error: expect.stringContaining("FAIL must list") });
    expect((await loadLedger(p!.rootDir)).length).toBe(2);
  });

  it("author independence: a reviewer cannot be the author", async () => {
    load();
    await prepared("run-r3", { author: "worker:dev3/run-r3" });
    expect(await collect("run-r3")).toMatchObject({ ok: false, error: expect.stringContaining("independent") });
  });
});
