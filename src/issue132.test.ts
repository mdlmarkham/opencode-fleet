import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError, foldJournal, openTaskTracker } from "./tasks.js";

const dir = () => mkdtempSync(join(tmpdir(), "tasks-"));
const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "ok"; } catch (e) { return e instanceof TaskError ? e.code : `other:${(e as Error).message}`; }
};

describe("#132 T-0: items and dependencies", () => {
  it("creates items with stable ids, deps gate readiness, blocked says what it waits on", async () => {
    const t = openTaskTracker(dir());
    const a = await t.create({ type: "spec", title: "schema" });
    const b = await t.create({ type: "spec", title: "api", deps: [a.id] });
    const c = await t.create({ type: "checkpoint", title: "review", deps: [a.id, b.id], refs: { issue: 7 } });
    expect([a.id, b.id, c.id]).toEqual(["T-1", "T-2", "T-3"]);
    expect((await t.ready()).map((x) => x.id)).toEqual(["T-1"]);
    expect((await t.blocked()).map((x) => [x.task.id, x.waitingOn])).toEqual([["T-2", ["T-1"]], ["T-3", ["T-1", "T-2"]]]);
    const got = await t.claim("w1");
    await t.complete(got!.id, "w1", { ok: true });
    expect((await t.ready()).map((x) => x.id)).toEqual(["T-2"]);
  });
  it("rejects unknown deps, duplicate ids, bad ids and cycles", async () => {
    const t = openTaskTracker(dir());
    await t.create({ id: "a", type: "spec", title: "a" });
    const b = await t.create({ id: "b", type: "spec", title: "b", deps: ["a"] });
    expect(await code(t.create({ type: "spec", title: "x", deps: ["nope"] }))).toBe("not-found");
    expect(await code(t.create({ id: "a", type: "spec", title: "dup" }))).toBe("exists");
    expect(await code(t.create({ id: "../x", type: "spec", title: "bad" }))).toBe("invalid");
    expect(await code(t.create({ type: "bogus" as never, title: "bad" }))).toBe("invalid");
    expect(await code(t.link("a", b.id))).toBe("cycle");
    expect(await code(t.link("a", "a"))).toBe("cycle");
  });
  it("update changes title/refs/data only, never state", async () => {
    const t = openTaskTracker(dir());
    const a = await t.create({ type: "spec", title: "old" });
    const u = await t.update(a.id, { title: "new", refs: { pr: 3 }, data: { goal: "g" } });
    expect(u).toMatchObject({ title: "new", refs: { pr: 3 }, data: { goal: "g" }, state: "pending" });
  });
});

describe("#132 T-0: claim", () => {
  it("concurrent claims of one task: exactly one wins (two tracker instances, one directory)", async () => {
    const d = dir();
    const trackers = Array.from({ length: 6 }, () => openTaskTracker(d));
    await trackers[0].create({ type: "spec", title: "only one" });
    const got = await Promise.all(trackers.map((t, i) => t.claim(`w${i}`)));
    expect(got.filter(Boolean)).toHaveLength(1);
  });
  it("concurrent claims of many tasks never hand out one twice", async () => {
    const d = dir();
    const t = openTaskTracker(d);
    for (let i = 0; i < 5; i++) await t.create({ type: "spec", title: `s${i}` });
    const got = await Promise.all(Array.from({ length: 12 }, (_, i) => openTaskTracker(d).claim(`w${i}`)));
    const ids = got.filter(Boolean).map((x) => x!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
  it("a stale claim is recoverable, a live one is not; only the owner can finish", async () => {
    let now = 1_000_000;
    const t = openTaskTracker(dir(), { now: () => now });
    await t.create({ type: "spec", title: "s" });
    const first = await t.claim("w1", { leaseMs: 5000 });
    expect(first).toMatchObject({ state: "claimed", attempts: 1 });
    now += 4000;
    expect(await t.claim("w2")).toBeNull();
    expect(await code(t.complete("T-1", "w2"))).toBe("not-owner");
    now += 2000;
    expect((await t.ready()).map((x) => x.id)).toEqual(["T-1"]);
    const second = await t.claim("w2");
    expect(second).toMatchObject({ state: "claimed", attempts: 2, claim: { by: "w2" } });
    expect(await code(t.complete("T-1", "w1"))).toBe("not-owner");
    expect((await t.journal()).map((e) => e.op)).toEqual(["create", "claim", "claim-expired", "claim"]);
  });
  it("fail, retry and release", async () => {
    const t = openTaskTracker(dir());
    await t.create({ type: "spec", title: "s" });
    await t.claim("w1");
    expect(await t.fail("T-1", "w1", "boom")).toMatchObject({ state: "failed", error: "boom" });
    expect(await t.claim("w1")).toBeNull();
    expect(await t.retry("T-1")).toMatchObject({ state: "pending" });
    expect(await code(t.retry("T-1"))).toBe("state");
    await t.claim("w1");
    expect(await t.release("T-1", "w1")).toMatchObject({ state: "pending" });
  });
  it("claim by id respects dependencies", async () => {
    const t = openTaskTracker(dir());
    await t.create({ id: "a", type: "spec", title: "a" });
    await t.create({ id: "b", type: "spec", title: "b", deps: ["a"] });
    expect(await t.claim("w", { id: "b" })).toBeNull();
    expect(await code(t.claim("w", { id: "zzz" }))).toBe("not-found");
  });
});

describe("#132 T-0: durability", () => {
  it("state survives reopening; the journal is append-only with a schema header", async () => {
    const d = dir();
    const t = openTaskTracker(d);
    await t.create({ type: "spec", title: "s" });
    await t.claim("w1");
    const again = openTaskTracker(d);
    expect(await again.get("T-1")).toMatchObject({ state: "claimed" });
    const lines = readFileSync(join(d, "tasks.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual({ schemaVersion: 1 });
    expect(lines).toHaveLength(3);
  });
  it("a crash mid-append (torn last line) is ignored and repaired by the next write", async () => {
    const d = dir();
    const t = openTaskTracker(d);
    await t.create({ type: "spec", title: "s" });
    appendFileSync(join(d, "tasks.jsonl"), '{"seq":2,"ts":"2026-01-01T00:00:00.000Z","op":"claim","id":"T-1","by":"w1","lease');
    expect(await t.get("T-1")).toMatchObject({ state: "pending" });
    await t.create({ type: "spec", title: "next" });
    const text = readFileSync(join(d, "tasks.jsonl"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(foldJournal(text).torn).toBe(false);
    expect((await t.list()).map((x) => x.id)).toEqual(["T-1", "T-2"]);
  });
  it("corruption in the middle is an error, not silently skipped", async () => {
    const d = dir();
    const t = openTaskTracker(d);
    await t.create({ type: "spec", title: "s" });
    await t.create({ type: "spec", title: "s2" });
    const f = join(d, "tasks.jsonl");
    const lines = readFileSync(f, "utf8").split("\n");
    lines[1] = "{broken";
    writeFileSync(f, lines.join("\n"));
    expect(await code(t.list())).toBe("corrupt");
  });
  it("refuses a journal from a different schema version", async () => {
    const d = dir();
    writeFileSync(join(d, "tasks.jsonl"), '{"schemaVersion":99}\n');
    expect(await code(openTaskTracker(d).list())).toBe("schema");
  });
  it("a lock left by a dead process is recovered; a live holder times out", async () => {
    const d = dir();
    writeFileSync(join(d, "tasks.lock"), JSON.stringify({ pid: 99999999, ts: Date.now() }));
    const t = openTaskTracker(d, { pidAlive: () => false });
    await t.create({ type: "spec", title: "s" });
    writeFileSync(join(d, "tasks.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const busy = openTaskTracker(d, { pidAlive: () => true, lockTimeoutMs: 100 });
    expect(await code(busy.create({ type: "spec", title: "x" }))).toBe("lock");
  });
  it("journal(since) returns only newer events", async () => {
    const t = openTaskTracker(dir());
    await t.create({ type: "spec", title: "a" });
    await t.create({ type: "spec", title: "b" });
    expect((await t.journal(1)).map((e) => e.id)).toEqual(["T-2"]);
  });
});

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
describe("#132 T-0: real processes", () => {
  it("claims from separate OS processes never double-assign", async () => {
    const d = dir();
    const t = openTaskTracker(d);
    for (let i = 0; i < 4; i++) await t.create({ type: "spec", title: `s${i}` });
    const tasksUrl = new URL("./tasks.ts", import.meta.url).pathname;
    const script = join(d, "worker.ts");
    writeFileSync(script, `import { openTaskTracker } from ${JSON.stringify(tasksUrl)};\nconst by = process.argv[2];\nconst t = openTaskTracker(${JSON.stringify(d)});\nconst got = await t.claim(by);\nconsole.log(JSON.stringify(got ? got.id : null));\n`);
    const bin = fileURLToPath(new URL("../node_modules/.bin/vite-node", import.meta.url));
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<string>((resolve, reject) => {
      const p = spawn(bin, [script, `p${i}`], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("error", reject);
      p.on("close", () => resolve(out.trim().split("\n").pop() ?? ""));
    })));
    const ids = outs.map((o) => JSON.parse(o) as string | null).filter(Boolean);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  }, 60_000);
});
