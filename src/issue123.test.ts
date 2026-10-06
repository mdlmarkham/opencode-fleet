import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAssumption, appendJournal, canTransition, createMission, listMissions, loadMission, mirrorToRepo, readJournal, resolveAssumption, setPhase, updateMission, validateRecord } from "./mission-store.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fleet123-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const specs = [{ id: "a", goal: "first", deps: [] }, { id: "b", goal: "second", deps: ["a"] }];
const recFile = (id = "m1") => join(root, ".opencode-fleet", "missions", id, "record.json");

describe("#123: create, load, validate", () => {
  it("creates a typed record and refuses to overwrite one", async () => {
    const c = await createMission(root, "m1", specs, { charterRef: ".fleet/charter.md", autonomy: { level: "gated" } });
    expect(c).toMatchObject({ ok: true, record: { phase: "designing", rev: 1, planVersion: 1, charterRef: ".fleet/charter.md" } });
    expect(await createMission(root, "m1", specs)).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(await createMission(root, "bad id", specs)).toMatchObject({ ok: false });
    expect(await createMission(root, "m2", [{ id: "a", goal: "x", deps: ["zzz"] }])).toMatchObject({ ok: false });
  });
  it("a corrupted record is refused with a clear error, never guessed", async () => {
    await createMission(root, "m1", specs);
    writeFileSync(recFile(), "{ not json");
    expect(await loadMission(root, "m1")).toMatchObject({ ok: false, error: expect.stringMatching(/corrupt.*refusing/) });
    const good = JSON.parse(JSON.stringify((await createMission(root, "m3", specs) as { record: object }).record));
    for (const bad of [{ ...good, phase: "weird" }, { ...good, schemaVersion: 9 }, { ...good, rev: 0 }, { ...good, assumptions: [{ id: 1 }] }, { ...good, supervisor: { ...good.supervisor, missionId: "other" } }]) {
      expect(validateRecord(bad).ok).toBe(false);
    }
    writeFileSync(recFile("m3"), JSON.stringify({ ...good, phase: "weird" }));
    expect(await updateMission(root, "m3", (r) => r)).toMatchObject({ ok: false, error: expect.stringContaining("corrupt") });
  });
});

describe("#123: durable updates", () => {
  it("phase moves follow the transition table and are journaled", async () => {
    await createMission(root, "m1", specs);
    expect(canTransition("designing", "executing")).toBe(false);
    expect(await setPhase(root, "m1", "executing", "skip")).toMatchObject({ ok: false });
    expect((await setPhase(root, "m1", "awaiting-approval", "design done")).ok).toBe(true);
    expect((await setPhase(root, "m1", "executing", "human approved")).ok).toBe(true);
    expect((await setPhase(root, "m1", "aborted", "stop")).ok).toBe(true);
    expect(await setPhase(root, "m1", "executing", "again")).toMatchObject({ ok: false });
  });
  it("a stale writer is refused; concurrent updates are serialized, none lost", async () => {
    await createMission(root, "m1", specs);
    expect(await updateMission(root, "m1", (r) => r, 5)).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
    await Promise.all(Array.from({ length: 8 }, (_, i) => addAssumption(root, "m1", `assumption ${i}`, "agent")));
    const m = await loadMission(root, "m1");
    expect(m.ok && m.record.assumptions.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    expect(m.ok && m.record.rev).toBe(9);
    const j = await readJournal(root, "m1");
    expect(j.map((e) => e.seq)).toEqual([...j.keys()].map((i) => i + 1));
  });
  it("assumptions can be confirmed or overturned, with the reason journaled; a bad id is refused", async () => {
    await createMission(root, "m1", specs);
    await addAssumption(root, "m1", "notes are small", "agent");
    expect((await resolveAssumption(root, "m1", "a1", "overturned", "found 50k notes")).ok).toBe(true);
    expect(await resolveAssumption(root, "m1", "zz", "confirmed", "x")).toMatchObject({ ok: false });
    const j = await readJournal(root, "m1");
    expect(j.map((e) => e.type)).toEqual(["mission-created", "assumption-made", "assumption-overturned"]);
    expect(j[2]!.why).toBe("found 50k notes");
  });
  it("redacts secrets on the way in and bounds text", async () => {
    await createMission(root, "m1", specs);
    await addAssumption(root, "m1", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 " + "x".repeat(2000), "agent");
    const raw = readFileSync(recFile(), "utf8") + readFileSync(join(root, ".opencode-fleet", "missions", "m1", "journal.jsonl"), "utf8");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(raw).toContain("[REDACTED");
  });
});

describe("#123: journal, restart and mirror", () => {
  it("reads since a seq and skips torn lines; a mission survives a 'restart' (fresh reads from disk)", async () => {
    await createMission(root, "m1", specs);
    await appendJournal(root, "m1", { type: "spec-verified", why: "gate passed", runId: "run-1" });
    writeFileSync(join(root, ".opencode-fleet", "missions", "m1", "journal.jsonl"), readFileSync(join(root, ".opencode-fleet", "missions", "m1", "journal.jsonl"), "utf8") + '{"seq": 99, "type"\n');
    expect((await readJournal(root, "m1", 1)).map((e) => [e.seq, e.type, e.runId])).toEqual([[2, "spec-verified", "run-1"]]);
    expect(await listMissions(root)).toEqual([{ missionId: "m1", phase: "designing", rev: 1 }]);
  });
  it("mirrors into the repo, and refuses a symlinked .fleet", async () => {
    await createMission(root, "m1", specs);
    const repo = mkdtempSync(join(tmpdir(), "fleet123r-"));
    const other = mkdtempSync(join(tmpdir(), "fleet123o-"));
    try {
      const r = await mirrorToRepo(root, "m1", repo);
      expect(r.ok).toBe(true);
      expect(existsSync(join(repo, ".fleet", "missions", "m1", "record.json"))).toBe(true);
      symlinkSync(other, join(repo, "ln"));
      mkdirSync(join(other, "x"));
      const bad = mkdtempSync(join(tmpdir(), "fleet123b-"));
      symlinkSync(other, join(bad, ".fleet"));
      expect(await mirrorToRepo(root, "m1", bad)).toMatchObject({ ok: false, error: expect.stringContaining("symlink") });
      expect(existsSync(join(other, "missions"))).toBe(false);
      rmSync(bad, { recursive: true, force: true });
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
  });
});

describe("#123: fleet_mission_show", () => {
  it("lists, shows record plus journal, honours since, and reports a corrupt mission", async () => {
    const t = loadPlugin((await loadEntry())!, {});
    try {
      await createMission(t.rootDir, "m1", specs);
      await addAssumption(t.rootDir, "m1", "a thing", "agent");
      expect(await t.call("fleet_mission_show", {})).toMatchObject({ missions: [{ missionId: "m1", phase: "designing" }] });
      const r = await t.call("fleet_mission_show", { missionId: "m1" });
      expect(r.mission).toMatchObject({ phase: "designing", assumptions: [{ id: "a1" }], specs: { a: { status: "pending" }, b: { deps: ["a"] } } });
      expect(r.journal.length).toBe(2);
      expect((await t.call("fleet_mission_show", { missionId: "m1", since: 1 })).journal).toHaveLength(1);
      writeFileSync(join(t.rootDir, ".opencode-fleet", "missions", "m1", "record.json"), "garbage");
      expect(await t.call("fleet_mission_show", { missionId: "m1" })).toMatchObject({ ok: false, error: expect.stringContaining("corrupt") });
      expect((await t.call("fleet_mission_show", { missionId: "nope" })).ok).toBe(false);
    } finally { t.dispose(); }
  });
});
