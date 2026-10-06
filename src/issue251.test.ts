import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PUBLISH_FAILURES, tick, type PublishResult, type TickDeps } from "./mission-runner.js";
import { createMission, loadMission, readJournal, setPhase, validateRecord } from "./mission-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet251-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const specs = [{ id: "a", goal: "first", deps: [], scope: { files: ["a/"] } }, { id: "b", goal: "second", deps: ["a"], scope: { files: ["b/"] } }];
const start = async () => { await createMission(root, "m1", specs); await setPhase(root, "m1", "awaiting-approval", "d"); await setPhase(root, "m1", "executing", "ok"); };
const rec = async () => { const m = await loadMission(root, "m1"); if (!m.ok) throw new Error(m.error); return m.record; };
const OK = { ok: true, verified: true as const };

const harness = (publish?: TickDeps["publish"]) => {
  const finished: Record<string, { runId?: string; signals: never }> = {};
  let n = 0;
  const known: Record<string, string> = {};
  const deps: TickDeps = {
    nowMs: () => 1_000_000,
    freeSlots: async () => ({ n1: 4 }),
    launch: async (a) => { const runId = `run-${a.specId}-${++n}`; known[a.key] = runId; return { ok: true, runId }; },
    reconcile: async (a) => (known[a.key] ? { state: "running", runId: known[a.key]! } : { state: "unknown" }),
    poll: async (running) => Object.fromEntries(running.filter((r) => finished[r.specId]).map((r) => [r.specId, finished[r.specId]!])),
    ...(publish ? { publish } : {}),
  };
  return { finished, deps };
};

describe("#251: each verified spec is published during the loop", () => {
  it("publishes a spec as it verifies, in dependency order, once each, and delivers only when all are published", async () => {
    await start();
    const calls: string[] = [];
    const { finished, deps } = harness(async (id) => { calls.push(id); return { ok: true, ref: `pr#1@${id}` }; });
    await tick(root, "m1", deps);                      // launches a
    finished.a = { signals: OK as never };
    let r = await tick(root, "m1", deps);              // a verifies -> published this tick; b launches
    expect(r).toMatchObject({ outcomes: ["a"], published: ["a"], launched: ["b"] });
    finished.b = { signals: OK as never };
    r = await tick(root, "m1", deps);                  // b verifies -> published; mission delivers
    expect(r).toMatchObject({ published: ["b"], status: "complete", phase: "delivering" });
    expect(calls).toEqual(["a", "b"]);
    expect((await rec()).publications).toMatchObject({ a: { state: "published", ref: "pr#1@a" }, b: { state: "published" } });
    expect((await readJournal(root, "m1")).filter((e) => e.type === "published")).toHaveLength(2);
  });

  it("is deduped: a re-run never publishes a spec twice", async () => {
    await start();
    const calls: string[] = [];
    const { finished, deps } = harness(async (id) => { calls.push(id); return { ok: true, ref: "r" }; });
    await tick(root, "m1", deps);
    finished.a = { signals: OK as never };
    await tick(root, "m1", deps);
    await tick(root, "m1", deps);
    await tick(root, "m1", deps);
    expect(calls.filter((c) => c === "a")).toHaveLength(1);
  });

  it("a refusal is retried once, then escalates to a human and blocks delivery (no silent loop)", async () => {
    await start();
    let attempts = 0;
    const { finished, deps } = harness(async (): Promise<PublishResult> => { attempts++; return { ok: false, error: "review FAIL: blocking finding" }; });
    await tick(root, "m1", deps);
    finished.a = { signals: OK as never };
    let r = await tick(root, "m1", deps);
    expect(r.publishRefused).toEqual(["a"]);
    expect((await rec()).publications!.a).toMatchObject({ state: "failed", failures: 1 });
    finished.b = { signals: OK as never };
    r = await tick(root, "m1", deps);
    expect(attempts).toBe(MAX_PUBLISH_FAILURES);
    expect((await rec()).publications!.a).toMatchObject({ state: "escalated", failures: MAX_PUBLISH_FAILURES, lastError: expect.stringContaining("review FAIL") });
    const j = (await readJournal(root, "m1")).map((e) => e.type);
    expect(j).toEqual(expect.arrayContaining(["publish-refused", "publish-escalated"]));
    await tick(root, "m1", deps);
    expect(attempts).toBe(MAX_PUBLISH_FAILURES); // escalated: not retried
    expect((await rec()).phase).not.toBe("delivering");
  });

  it("a non-retryable refusal escalates at once; a dependent spec is never published past a refused one", async () => {
    await start();
    const calls: string[] = [];
    const { finished, deps } = harness(async (id) => { calls.push(id); return { ok: false, error: "scope violation", retryable: false }; });
    await tick(root, "m1", deps);
    finished.a = { signals: OK as never };
    await tick(root, "m1", deps);
    expect((await rec()).publications!.a).toMatchObject({ state: "escalated", failures: 1 });
    expect(calls).toEqual(["a"]);
  });

  it("without a publish dep nothing changes: no publications, delivery as before", async () => {
    await start();
    const { finished, deps } = harness();
    await tick(root, "m1", deps);
    finished.a = { signals: OK as never };
    await tick(root, "m1", deps);
    finished.b = { signals: OK as never };
    const r = await tick(root, "m1", deps);
    expect(r).toMatchObject({ status: "complete", phase: "delivering", published: [] });
    expect((await rec()).publications).toBeUndefined();
  });

  it("the intent is persisted BEFORE publishing, and a crash mid-publish resumes (never blindly republishes)", async () => {
    await start();
    const seen: Array<{ id: string; state: string | undefined; resume: boolean }> = [];
    let crashOnce = true;
    const { finished, deps } = harness(async (id, record, ctx) => {
      seen.push({ id, state: record.publications?.[id]?.state, resume: ctx.resume });
      if (crashOnce) { crashOnce = false; throw new Error("process died after the remote publish"); }
      return { ok: true, ref: "found-existing" };
    });
    await tick(root, "m1", deps);
    finished.a = { signals: OK as never };
    await tick(root, "m1", deps);
    // The call saw the durable intent; a throw is recorded as a failure, not a publication.
    expect(seen[0]).toEqual({ id: "a", state: "publishing", resume: false });
    expect((await rec()).publications!.a).toMatchObject({ state: "failed", failures: 1 });
    // A real crash leaves `publishing` on disk: simulate it and check the next call resumes.
    const { updateMission } = await import("./mission-store.js");
    await updateMission(root, "m1", (r) => ({ ...r, publications: { ...r.publications, a: { state: "publishing", failures: 0, at: "t" } } }));
    await tick(root, "m1", deps);
    expect(seen[seen.length - 1]).toMatchObject({ id: "a", resume: true });
    expect((await rec()).publications!.a).toMatchObject({ state: "published", ref: "found-existing" });
  });

  it("the record validator keeps publications and refuses a malformed entry", async () => {
    await start();
    const r = await rec();
    expect(validateRecord({ ...r, publications: { a: { state: "published", failures: 0, at: "t" } } }).ok).toBe(true);
    expect(validateRecord({ ...r, publications: { a: { state: "bogus", failures: 0, at: "t" } } }).ok).toBe(false);
    expect(validateRecord({ ...r, publications: { a: { state: "failed", failures: -1, at: "t" } } }).ok).toBe(false);
  });
});
