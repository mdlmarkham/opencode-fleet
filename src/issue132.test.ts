import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetLabels, flushProjection, marker, renderProgress, restTransport, tokenFromEnv, type Fetch, type GitHubTransport } from "./projection.js";
import { addAssumption, createMission, loadMission, updateMission } from "./mission-store.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet132-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const specs = [{ id: "a", goal: "first", deps: [] }, { id: "b", goal: "second", deps: ["a"] }];
const mission = async (id = "m1") => { await createMission(root, id, specs); const m = await loadMission(root, id); if (!m.ok) throw new Error(m.error); return m.record; };

class Fake implements GitHubTransport {
  comments: Array<{ id: number; body: string }> = [];
  labels: string[] = ["bug", "fleet:old"];
  calls: string[] = [];
  fail: Error | undefined;
  private n = 100;
  async listComments() { this.calls.push("list"); if (this.fail) throw this.fail; return this.comments; }
  async createComment(_i: number, body: string) { this.calls.push("create"); if (this.fail) throw this.fail; const c = { id: ++this.n, body }; this.comments.push(c); return { id: c.id }; }
  async updateComment(id: number, body: string) { this.calls.push("update"); if (this.fail) throw this.fail; this.comments.find((c) => c.id === id)!.body = body; }
  async setFleetLabels(_i: number, ls: string[]) { this.calls.push("labels"); if (this.fail) throw this.fail; this.labels = [...this.labels.filter((l) => !l.startsWith("fleet:")), ...ls]; }
}

describe("#132: rendering", () => {
  it("is deterministic, carries the marker, and clips/strips hostile mission text", async () => {
    const r = await mission();
    await addAssumption(root, "m1", "ghp_abcdefghijklmnopqrstuvwxyz0123456789 <script>x</script> | `rm`", "agent");
    const m = await loadMission(root, "m1");
    const rec = (m as unknown as { record: typeof r }).record;
    const a = renderProgress(rec), b = renderProgress(rec);
    expect(a).toBe(b);
    expect(a.startsWith(marker("m1"))).toBe(true);
    expect(a).toContain("0/2 specs verified");
    expect(a).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(a).not.toMatch(/<script>|`rm`/);
  });
  it("labels come from state only", async () => {
    const r = await mission();
    expect(fleetLabels(r)).toEqual(["fleet:designing"]);
    const esc = { ...r, supervisor: { ...r.supervisor, specs: { ...r.supervisor.specs, a: { ...r.supervisor.specs.a!, status: "escalated" as const } } } };
    expect(fleetLabels(esc)).toEqual(["fleet:designing", "fleet:escalated"]);
  });
});

describe("#132: flush is idempotent and one-way", () => {
  it("creates one comment and the fleet labels (leaving other labels), then does nothing when unchanged", async () => {
    const t = new Fake();
    const r = await mission();
    expect(await flushProjection(root, r, 7, t)).toEqual({ ok: true, sent: ["comment-created", "labels"], skipped: false });
    expect(t.labels.sort()).toEqual(["bug", "fleet:designing"]);
    expect(await flushProjection(root, r, 7, t)).toEqual({ ok: true, sent: [], skipped: true });
    expect(t.calls.filter((c) => c === "create")).toHaveLength(1);
  });
  it("edits the same comment when the mission changes", async () => {
    const t = new Fake();
    await flushProjection(root, await mission(), 7, t);
    await addAssumption(root, "m1", "a new assumption", "agent");
    const m = await loadMission(root, "m1");
    const r = await flushProjection(root, (m as unknown as { record: never }).record, 7, t);
    expect(r.sent).toEqual(["comment-updated"]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]!.body).toContain("a new assumption");
  });
  it("adopts an existing marker comment instead of posting a duplicate (state lost)", async () => {
    const t = new Fake();
    t.comments = [{ id: 5, body: `${marker("m1")}\nold` }, { id: 6, body: "someone else's comment" }];
    const r = await flushProjection(root, await mission(), 7, t);
    expect(r.sent[0]).toBe("comment-updated");
    expect(t.comments.map((c) => c.id)).toEqual([5, 6]);
    expect(t.comments[1]!.body).toBe("someone else's comment");
  });
  it("a different target issue starts clean", async () => {
    const t = new Fake();
    const rec = await mission();
    await flushProjection(root, rec, 7, t);
    // issue 8 has no comments of its own (a fresh transport): saved state for issue 7 must not be reused.
    expect((await flushProjection(root, rec, 8, new Fake())).sent).toContain("comment-created");
  });
});

describe("#132: GitHub down never blocks, and the token never leaks", () => {
  it("a failure is pending, advances no state, and the next flush retries", async () => {
    const t = new Fake();
    const rec = await mission();
    t.fail = new Error("HTTP 503 with token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and SECRETVALUE");
    const r = await flushProjection(root, rec, 7, t, ["SECRETVALUE"]);
    expect(r).toMatchObject({ ok: false, pending: true });
    expect(r.error).not.toContain("SECRETVALUE");
    expect(r.error).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    t.fail = undefined;
    expect(await flushProjection(root, rec, 7, t)).toMatchObject({ ok: true, sent: ["comment-created", "labels"] });
  });
  it("a partial failure (comment ok, labels fail) retries only the labels", async () => {
    const t = new Fake();
    const rec = await mission();
    t.setFleetLabels = async () => { t.calls.push("labels"); throw new Error("boom"); };
    expect((await flushProjection(root, rec, 7, t)).pending).toBe(true);
    t.setFleetLabels = Fake.prototype.setFleetLabels.bind(t);
    expect((await flushProjection(root, rec, 7, t)).sent).toEqual(["labels"]);
  });
  it("the token is never written under the root", async () => {
    const t = new Fake();
    await flushProjection(root, await mission(), 7, t, ["TOKEN-VALUE-123"]);
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
    for (const f of all(root)) expect(readFileSync(f, "utf8")).not.toContain("TOKEN-VALUE-123");
  });
});

describe("#132: REST transport and token source", () => {
  it("sends the token only as a bearer header, to api.github.com, and preserves non-fleet labels", async () => {
    const seen: Array<{ url: string; method: string; auth: string; body?: string }> = [];
    const fetchFn: Fetch = async (url, init) => {
      seen.push({ url, method: init.method, auth: init.headers.authorization!, ...(init.body ? { body: init.body } : {}) });
      const json = init.method === "GET" && url.includes("/labels") ? [{ name: "bug" }, { name: "fleet:old" }] : init.method === "GET" ? [] : { id: 1 };
      return { ok: true, status: 200, json: async () => json, text: async () => "" };
    };
    const t = restTransport("o/r", "TOK", fetchFn);
    await t.setFleetLabels(3, ["fleet:done"]);
    await t.createComment(3, "hi");
    expect(seen.every((s) => s.url.startsWith("https://api.github.com/repos/o/r/") && s.auth === "Bearer TOK")).toBe(true);
    expect(JSON.parse(seen.find((s) => s.method === "PUT")!.body!)).toEqual({ labels: ["bug", "fleet:done"] });
    expect(seen.every((s) => !(s.body ?? "").includes("TOK"))).toBe(true);
  });
  it("HTTP errors surface the status (rate limits marked retryable) without the token; bad repo names refused", async () => {
    const t = restTransport("o/r", "TOK", async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" }));
    await expect(t.listComments(1)).rejects.toThrow(/HTTP 403 \(rate limited or forbidden; will retry\)/);
    expect(() => restTransport("not a repo", "TOK", async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }))).toThrow(/owner\/name/);
  });
  it("reads the token from the named env var only (default GITHUB_TOKEN); junk names fall back", () => {
    expect(tokenFromEnv(undefined, { GITHUB_TOKEN: " abc " })).toBe("abc");
    expect(tokenFromEnv("FLEET_GH", { FLEET_GH: "x", GITHUB_TOKEN: "y" })).toBe("x");
    expect(tokenFromEnv("lower; rm", { GITHUB_TOKEN: "y" })).toBe("y");
    expect(tokenFromEnv("FLEET_GH", {})).toBeUndefined();
  });
});

describe("#132: fleet_mission_project", () => {
  const prevFetch = globalThis.fetch;
  const prevTok = process.env.FLEET_TEST_GH;
  afterEach(() => { globalThis.fetch = prevFetch; if (prevTok === undefined) delete process.env.FLEET_TEST_GH; else process.env.FLEET_TEST_GH = prevTok; });
  it("refuses without repo or token, then projects through a stubbed fetch without ever echoing the token", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init: { method: string }) => { calls.push(`${init.method} ${url}`); const j = init.method === "GET" ? [] : { id: 9 }; return { ok: true, status: 200, json: async () => j, text: async () => "" }; }) as never;
    const none = loadPlugin((await loadEntry())!, {});
    try {
      await createMission(none.rootDir, "m1", specs);
      expect((await none.call("fleet_mission_project", { missionId: "m1", issue: 1 })).error).toMatch(/projection.repo is not configured/);
    } finally { none.dispose(); }
    const t = loadPlugin((await loadEntry())!, { config: { projection: { repo: "o/r", tokenEnv: "FLEET_TEST_GH" } } });
    try {
      await createMission(t.rootDir, "m1", specs);
      delete process.env.FLEET_TEST_GH;
      expect((await t.call("fleet_mission_project", { missionId: "m1", issue: 1 })).error).toMatch(/environment variable FLEET_TEST_GH/);
      process.env.FLEET_TEST_GH = "SECRET-TOK";
      const r = await t.call("fleet_mission_project", { missionId: "m1", issue: 4 });
      expect(r).toMatchObject({ ok: true, sent: ["comment-created", "labels"] });
      expect(JSON.stringify(r)).not.toContain("SECRET-TOK");
      expect(calls.some((c) => c.includes("/issues/4/comments"))).toBe(true);
      expect((await t.call("fleet_mission_project", { missionId: "nope", issue: 4 })).ok).toBe(false);
    } finally { t.dispose(); }
  });
});
