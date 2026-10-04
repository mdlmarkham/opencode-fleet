import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./tasks.js";
import {
  MAX_ATTEMPTS, drain, enqueue, markerFor, openProjectionStore, planProjection, project, renderViews, sanitizeForGithub, summaryLabel,
  type GitHubProjectionClient, type ProjectionStore,
} from "./task-projection.js";

const T0 = "2026-10-04T00:00:00.000Z";
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "spec", title: `title ${id}`, state: "pending", deps: [], attempts: 0, createdAt: T0, updatedAt: T0, refs: { issue: 7 }, ...over });

class Fake implements GitHubProjectionClient {
  comments: Array<[number, string, string]> = [];
  labels: Array<[number, string[], string[]]> = [];
  fail = false;
  async upsertComment(issue: number, marker: string, body: string) {
    if (this.fail) throw new Error("GitHub is down");
    this.comments.push([issue, marker, body]);
    return { commentId: 100 + issue };
  }
  async setLabels(issue: number, add: string[], remove: string[]) {
    if (this.fail) throw new Error("GitHub is down");
    this.labels.push([issue, add, remove]);
  }
}

describe("#132 T-1a: rendering", () => {
  it("one checklist comment per linked issue, with state, waiting-on and failure text", () => {
    const tasks = [
      task("T-1", { state: "done" }),
      task("T-2", { state: "claimed" }),
      task("T-3", { deps: ["T-1", "T-2"] }),
      task("T-4", { state: "failed", error: "tests red" }),
      task("T-5", { refs: { issue: 9 } }),
      task("T-6", { refs: undefined }),
    ];
    const views = renderViews(tasks);
    expect(views.map((v) => v.issue)).toEqual([7, 9]);
    const b = views[0].body;
    expect(b).toContain(markerFor(7));
    expect(b).toContain("1/4 done");
    expect(b).toContain("- [x] `T-1` title T-1");
    expect(b).toContain("- [ ] `T-2` title T-2 — in progress");
    expect(b).toContain("- [ ] `T-3` title T-3 — waiting on `T-2`");
    expect(b).toContain("— failed: tests red");
    expect(b).not.toContain("T-6");
  });
  it("summary label: failed beats done beats in-progress; all-blocked is blocked; nothing is none", () => {
    expect(summaryLabel([])).toBeUndefined();
    expect(summaryLabel([task("a", { state: "done" }), task("b", { state: "failed" })])).toBe("fleet:failed");
    expect(summaryLabel([task("a", { state: "done" }), task("b", { state: "done" })])).toBe("fleet:done");
    expect(summaryLabel([task("a", { state: "claimed" }), task("b")])).toBe("fleet:in-progress");
    expect(summaryLabel([task("a"), task("b", { deps: ["a"] })])).toBe("fleet:in-progress");
    expect(summaryLabel([task("a", { deps: ["b"] }), task("b", { deps: ["a"] })])).toBe("fleet:blocked");
  });
  it("untrusted task text cannot forge the marker, ping people, or carry secrets", () => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const evil = task("T-1", { title: `x <!-- fleet-projection:issue:99 --> ping @octocat ${secret}\nnew line` });
    const body = renderViews([evil])[0].body;
    expect(body).not.toContain("issue:99");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("@octocat");
    expect(body.split(markerFor(7)).length).toBe(2);
    expect(sanitizeForGithub("a".repeat(500), 20)).toBe(`${"a".repeat(20)}…`);
    expect(sanitizeForGithub("a\nb\tc", 20)).toBe("a b c");
  });
  it("a large issue is truncated with a count, not unbounded", () => {
    const many = Array.from({ length: 130 }, (_, i) => task(`T-${i + 1}`));
    const body = renderViews(many)[0].body;
    expect(body).toContain("… and 30 more");
    expect(body.split("\n").filter((l) => l.startsWith("- [")).length).toBe(100);
  });
});

describe("#132 T-1a: planning is a diff against what was delivered", () => {
  it("first plan has a comment and a label op; the same state plans nothing", () => {
    const tasks = [task("T-1", { state: "claimed" })];
    const ops = planProjection(tasks, {});
    expect(ops.map((o) => o.kind)).toEqual(["comment", "labels"]);
    const v = renderViews(tasks)[0];
    expect(planProjection(tasks, { "7": { bodyHash: v.bodyHash, label: v.label } })).toEqual([]);
  });
  it("a state change re-plans only what changed, and swaps the fleet label", () => {
    const before = [task("T-1", { state: "claimed" })];
    const v = renderViews(before)[0];
    const done = [task("T-1", { state: "done" })];
    const ops = planProjection(done, { "7": { bodyHash: v.bodyHash, label: v.label } });
    expect(ops.map((o) => o.kind)).toEqual(["comment", "labels"]);
    expect(ops[1]).toMatchObject({ add: ["fleet:done"], remove: ["fleet:in-progress"] });
  });
  it("only fleet: labels are ever named", () => {
    for (const o of planProjection([task("T-1", { state: "failed" })], {})) {
      if (o.kind === "labels") for (const l of [...o.add, ...o.remove]) expect(l.startsWith("fleet:")).toBe(true);
    }
  });
});

describe("#132 T-1a: delivery", () => {
  it("delivers, records what it delivered, and a second run is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    const c = new Fake();
    const tasks = [task("T-1", { state: "claimed" })];
    const r1 = await project(dir, tasks, c, 1000);
    expect(r1).toMatchObject({ added: 2, delivered: 2, failed: 0, pending: 0 });
    expect(c.comments).toHaveLength(1);
    expect(c.labels[0]).toEqual([7, ["fleet:in-progress"], ["fleet:blocked", "fleet:done", "fleet:failed"]]);
    const r2 = await project(dir, tasks, c, 2000);
    expect(r2).toMatchObject({ added: 0, delivered: 0 });
    expect(c.comments).toHaveLength(1);
    expect(openProjectionStore(dir).file).toBeTruthy();
    expect(statSync(join(dir, "projection.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "projection.json"), "utf8")).state["7"].commentId).toBe(107);
  });
  it("GitHub down: nothing throws, ops stay queued with backoff, and the next drain delivers them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    const c = new Fake();
    c.fail = true;
    const tasks = [task("T-1")];
    const r1 = await project(dir, tasks, c, 1000);
    expect(r1).toMatchObject({ delivered: 0, failed: 2, pending: 2 });
    const queued = JSON.parse(readFileSync(join(dir, "projection.json"), "utf8")).queue;
    expect(queued[0]).toMatchObject({ attempts: 1, lastError: "GitHub is down" });
    expect(queued[0].nextAttemptAt).toBeGreaterThan(1000);
    // not due yet: left alone, even though GitHub is back
    c.fail = false;
    expect(await project(dir, tasks, c, 1500)).toMatchObject({ delivered: 0, pending: 2 });
    // due: delivered
    expect(await project(dir, tasks, c, 1000 + 60_000)).toMatchObject({ delivered: 2, pending: 0 });
    expect(c.comments).toHaveLength(1);
  });
  it("a repeated call while ops are queued does not stack duplicates, and newer state replaces the queued op", () => {
    let store: ProjectionStore = { state: {}, queue: [] };
    store = enqueue(store, [task("T-1")], 0).store;
    expect(store.queue).toHaveLength(2);
    expect(enqueue(store, [task("T-1")], 1).added).toBe(0);
    const next = enqueue(store, [task("T-1", { state: "done" })], 2);
    expect(next.store.queue).toHaveLength(2);
    expect(next.store.queue.find((q) => q.op.kind === "comment")!.op).toMatchObject({ body: expect.stringContaining("1/1 done") });
  });
  it("an op that keeps failing is dropped after MAX_ATTEMPTS and counted, not retried forever", async () => {
    const c = new Fake();
    c.fail = true;
    let store: ProjectionStore = enqueue({ state: {}, queue: [] }, [task("T-1")], 0).store;
    let dropped = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 1 && store.queue.length; i++) {
      const r = await drain(store, c, (i + 1) * 10 * 3600_000); // always past the backoff
      store = r.store;
      dropped += r.result.dropped;
    }
    expect(store.queue).toEqual([]);
    expect(dropped).toBe(2);
  });
  it("a corrupt store file is treated as empty, never a throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    await (await import("node:fs/promises")).writeFile(join(dir, "projection.json"), "{nope");
    expect(await project(dir, [task("T-1")], new Fake(), 1)).toMatchObject({ delivered: 2 });
  });
});
