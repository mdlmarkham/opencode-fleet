import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { auc, buildReport, chooseThreshold, distribution, loadLabelled, renderReport, splitOf, sweep, type Item } from "./calibrate.js";
import { scoreItems } from "./calibrate-run.js";
import type { S1Fetch } from "./decision.js";

const file = (n: string) => readFileSync(new URL(`../calibration/${n}`, import.meta.url), "utf8");

describe("#78: the committed labelled sets", () => {
  for (const [name, minStop, minAllow] of [["commands.jsonl", 30, 30], ["outputs.jsonl", 8, 8]] as const) {
    it(`${name} parses, has unique ids and enough items per class`, () => {
      const r = loadLabelled(file(name));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const n = (l: string) => r.items.filter((i) => i.label === l).length;
      expect(n("must-stop")).toBeGreaterThanOrEqual(minStop);
      expect(n("must-allow")).toBeGreaterThanOrEqual(minAllow);
      expect(n("ambiguous")).toBeGreaterThan(0);
    });
  }
  it("commands cover the destructive, exfiltration, remote-exec and obfuscation classes, and ordinary dev work", () => {
    const r = loadLabelled(file("commands.jsonl"));
    if (!r.ok) throw new Error(r.error);
    const cats = new Set(r.items.filter((i) => i.label === "must-stop").map((i) => i.category));
    for (const c of ["destructive", "exfiltration", "remote-exec", "obfuscated", "unrequested"]) expect(cats.has(c), c).toBe(true);
    const ok = new Set(r.items.filter((i) => i.label === "must-allow").map((i) => i.category));
    for (const c of ["test", "build", "vcs", "read", "deps", "cleanup"]) expect(ok.has(c), c).toBe(true);
  });
  it("the hold-out split is deterministic and uses both halves", () => {
    const r = loadLabelled(file("commands.jsonl"));
    if (!r.ok) throw new Error(r.error);
    const halves = r.items.map((i) => splitOf(i.id));
    expect(halves).toEqual(r.items.map((i) => splitOf(i.id)));
    expect(new Set(halves).size).toBe(2);
  });
  it("loadLabelled rejects malformed lines, duplicate ids and bad labels", () => {
    expect(loadLabelled("not json").ok).toBe(false);
    expect(loadLabelled('{"id":"a","text":"x","label":"maybe","category":"c"}').ok).toBe(false);
    expect(loadLabelled('{"id":"a","text":"x","label":"must-stop","category":"c"}\n{"id":"a","text":"y","label":"must-allow","category":"c"}').ok).toBe(false);
    expect(loadLabelled("").ok).toBe(false);
  });
});

describe("#78: credential-shaped fixtures", () => {
  it("are stored split by the join marker (so secret scanning stays quiet) and rejoined on load", () => {
    const raw = file("outputs.jsonl");
    expect(raw).toContain("\u27e6\u27e7");
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]{20}/);
    expect(raw).not.toMatch(/xoxb-\d{6}/);
    const r = loadLabelled(raw);
    if (!r.ok) throw new Error(r.error);
    expect(r.items.some((i) => /ghp_16C7e42F/.test(i.text))).toBe(true);
    expect(r.items.some((i) => /xoxb-123456789012/.test(i.text))).toBe(true);
    expect(r.items.every((i) => !i.text.includes("\u27e6\u27e7"))).toBe(true);
  });
});

describe("#78: the math", () => {
  it("distribution quantiles", () => {
    expect(distribution([])).toBeUndefined();
    expect(distribution([0.4])).toEqual({ n: 1, min: 0.4, median: 0.4, p95: 0.4, max: 0.4 });
    const d = distribution([0, 0.25, 0.5, 0.75, 1])!;
    expect(d.median).toBe(0.5);
    expect(d.p95).toBeCloseTo(0.95, 5);
  });
  it("AUC: perfect, none (ties), inverted", () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.4, 0.4], [0.4, 0.4])).toBe(0.5);
    expect(auc([0.1], [0.9])).toBe(0);
    expect(auc([], [0.1])).toBeUndefined();
  });
  it("sweep counts false-allow below and false-block at/above the threshold", () => {
    const rows = sweep([0.9, 0.5, 0.1], [0.05, 0.5, 0.6, 0.2], [0.5]);
    expect(rows[0]).toEqual({ threshold: 0.5, falseAllow: 1 / 3, falseBlock: 2 / 4 });
  });
  it("chooseThreshold takes the highest threshold within the false-allow target, then checks the cost", () => {
    const stop = [0.95, 0.9, 0.85, 0.8];
    const allow = [0.05, 0.1, 0.15, 0.82];
    const rows = sweep(stop, allow, [0.1, 0.5, 0.8, 0.9]);
    const c = chooseThreshold(rows, 0, 0.5);
    expect(c.ok && c.row.threshold).toBe(0.8);
    expect(chooseThreshold(rows, 0, 0.1).ok).toBe(false); // 0.8 blocks 25% of good items
    expect(chooseThreshold(sweep([0.1], [0.9], [0.5]), 0, 1).ok).toBe(false); // nothing keeps false-allow at 0
  });
});

/** A fake S1 that scores by the command text, like an oracle or like the flat Kev we saw. */
function backend(score: (text: string) => number): S1Fetch {
  return async (_u, init) => {
    const body = JSON.parse(init.body) as { state: Record<string, string> };
    const text = Object.values(body.state)[0];
    return { ok: true, status: 200, json: async () => ({ model: "fake-1", answers: { q: { type: "noul", noul: score(text) } }, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
}

describe("#78: end to end with a fake backend", () => {
  const items = (() => {
    const r = loadLabelled(file("commands.jsonl"));
    if (!r.ok) throw new Error(r.error);
    return r.items;
  })();
  const label = new Map(items.map((i) => [i.text, i.label]));
  const opts = { backend: "fake", model: "fake-1", question: "q" };

  it("an oracle backend yields a usable threshold with no misses", async () => {
    const run = await scoreItems(items, "q", "command", { fetch: backend((t) => (label.get(t) === "must-stop" ? 0.9 : 0.05)) });
    expect(run.failed).toEqual([]);
    const rep = buildReport(run.scored, opts);
    expect(rep.auc).toBe(1);
    expect(rep.separable).toBe(true);
    expect(rep.choice.ok).toBe(true);
    expect(rep.missed).toEqual([]);
    expect(renderReport(rep)).toContain("Threshold **");
  });
  it("a flat backend (the 0.34-0.44-for-everything Kev result) is reported as unusable, not as a threshold", async () => {
    const run = await scoreItems(items, "q", "command", { fetch: backend((t) => 0.34 + (t.length % 11) / 100) });
    const rep = buildReport(run.scored, opts);
    expect(rep.separable).toBe(false);
    expect(rep.choice.ok).toBe(false);
    expect(renderReport(rep)).toMatch(/No usable threshold/);
    expect(renderReport(rep)).toMatch(/does not separate/);
  });
  it("items the backend fails on are excluded and listed, never scored as 0", async () => {
    let n = 0;
    const flaky: S1Fetch = async (u, i) => {
      if (++n % 5 === 0) return { ok: false, status: 500, json: async () => ({}) };
      return backend(() => 0.5)(u, i);
    };
    const run = await scoreItems(items, "q", "command", { fetch: flaky, concurrency: 1 });
    expect(run.failed.length).toBeGreaterThan(0);
    expect(run.scored.length + run.failed.length).toBe(items.length);
    expect(run.scored.every((s) => s.score === 0.5)).toBe(true);
    expect(run.failed[0]).toMatch(/HTTP 500/);
  });
  it("the report keeps ambiguous items out of both rates", () => {
    const only: Item[] = [{ id: "a", text: "t", label: "ambiguous", category: "x" }];
    const rep = buildReport(only.map((i) => ({ ...i, score: 0.5 })), opts);
    expect(rep.counts.ambiguous).toBe(1);
    expect(rep.auc).toBeUndefined();
    expect(rep.choice.ok).toBe(false);
  });
});
