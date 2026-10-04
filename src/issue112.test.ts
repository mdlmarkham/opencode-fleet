import { describe, expect, it } from "vitest";
import { loadCorpus, summarize, renderReport, MIN_CONFIDENT_N, type BenchObservation } from "./benchmark.js";

const good = JSON.stringify({
  version: "1",
  tasks: [
    { id: "parse-duration", goal: "Implement parse_duration", expect: { files: ["solution.py"], command: "python3 -m pytest -q" } },
    { id: "fix-dedup", goal: "Fix the dedup bug", acceptance: ["dedup key lowercases"], expect: { command: "pytest -q test_dedup.py" }, tags: ["python"] },
  ],
});

describe("#112: corpus loading", () => {
  it("loads a valid corpus with version + tasks", () => {
    const r = loadCorpus(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe("1");
      expect(r.tasks.map((t) => t.id)).toEqual(["parse-duration", "fix-dedup"]);
    }
  });

  it("REJECTS a task with no expect (a task with no check is not a benchmark)", () => {
    const bad = JSON.stringify({ version: "1", tasks: [{ id: "x", goal: "do a thing" }] });
    const r = loadCorpus(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expect is required/);
  });

  it("rejects an expect with neither files nor command", () => {
    const bad = JSON.stringify({ version: "1", tasks: [{ id: "x", goal: "g", expect: {} }] });
    const r = loadCorpus(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one file or a command/);
  });

  it("requires a version (so a corpus change is traceable)", () => {
    const bad = JSON.stringify({ tasks: [{ id: "x", goal: "g", expect: { command: "true" } }] });
    const r = loadCorpus(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version is required/);
  });

  it("rejects duplicate ids, bad slugs, empty goal, and non-JSON", () => {
    for (const bad of [
      JSON.stringify({ version: "1", tasks: [{ id: "x", goal: "g", expect: { command: "true" } }, { id: "x", goal: "g", expect: { command: "true" } }] }),
      JSON.stringify({ version: "1", tasks: [{ id: "BAD ID", goal: "g", expect: { command: "true" } }] }),
      JSON.stringify({ version: "1", tasks: [{ id: "x", goal: "  ", expect: { command: "true" } }] }),
      "not json at all",
      JSON.stringify({ version: "1", tasks: [] }),
    ]) {
      expect(loadCorpus(bad).ok, bad.slice(0, 40)).toBe(false);
    }
  });
});

describe("#112: verified-rate report", () => {
  const obs = (o: Partial<BenchObservation>): BenchObservation => ({ taskId: "t", engine: "opencode", verified: true, ...o });

  it("computes verified rate over DECIDED runs, excluding unknown, and flags low n", () => {
    const rows = summarize([
      obs({}), obs({}), obs({}), obs({ verified: false }),
      obs({ verified: null }), // unknown: excluded from numerator AND denominator
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.runs).toBe(5);
    expect(r.unknown).toBe(1);
    expect(r.verifiedRate).toBeCloseTo(3 / 4); // 3 of 4 decided
    expect(r.lowConfidence).toBe(true); // 4 < MIN_CONFIDENT_N
  });

  it("is null (not 0) when every run is unknown — you cannot score what you did not check", () => {
    const rows = summarize([obs({ verified: null }), obs({ verified: null })]);
    expect(rows[0].verifiedRate).toBeNull();
  });

  it("splits by engine AND model, and sorts by verified rate", () => {
    const many = (engine: string, model: string, v: boolean) => Array.from({ length: MIN_CONFIDENT_N }, () => obs({ engine, model, verified: v }));
    const rows = summarize([...many("opencode", "glm", true), ...many("pi", "glm", false)]);
    expect(rows[0].engine).toBe("opencode");
    expect(rows[0].verifiedRate).toBe(1);
    expect(rows[1].engine).toBe("pi");
    expect(rows[1].verifiedRate).toBe(0);
    expect(rows[0].lowConfidence).toBe(false);
  });

  it("rolls up intervention and cost means", () => {
    const rows = summarize([
      obs({ intervened: true, costUsd: 0.02 }), obs({ intervened: false, costUsd: 0.04 }),
      obs({ intervened: false }), obs({ intervened: false }), obs({ intervened: false }),
      obs({ intervened: false }), obs({ intervened: false }), obs({ intervened: false }),
      obs({ intervened: false }), obs({ intervened: false }), obs({ intervened: false }),
    ]);
    expect(rows[0].interventionRate).toBeCloseTo(1 / 11);
    expect(rows[0].meanCostUsd).toBeCloseTo(0.03);
  });

  it("renders a deterministic report", () => {
    const rows = summarize(Array.from({ length: MIN_CONFIDENT_N }, () => obs({ engine: "opencode", model: "glm", verified: true })));
    const txt = renderReport(rows, "1");
    expect(txt).toContain("corpus 1");
    expect(txt).toContain("opencode / glm: verified 100% on n=10");
  });
});
