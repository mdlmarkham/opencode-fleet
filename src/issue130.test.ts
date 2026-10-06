import { describe, expect, it } from "vitest";
import { effectiveMode, layerPoints, linkOutcome, parsePoints, pointReport, resolveDecision, runPoint, type DecisionPoint } from "./decision-points.js";

const raw = (o: Record<string, unknown> = {}) => ({ id: "review.depth", question: { wording: "Does this diff need a deep review?", version: 1 }, lowBelow: 0.2, highAbove: 0.8, uncertainAction: "second-reviewer", safeDefault: "full-review", ...o });
const pt = (o: Record<string, unknown> = {}): DecisionPoint => { const r = parsePoints([raw(o)]); if (!r.ok) throw new Error(r.error); return r.points[0]!; };
const CAL = { model: "kev-1", corpus: "corpora/review-depth.json", wordingVersion: 1 };

describe("#130: parsePoints", () => {
  it("accepts a declared point with shadow as the default mode", () => {
    expect(pt().mode).toBe("shadow");
    expect(parsePoints(undefined)).toEqual({ ok: true, points: [] });
  });
  it("rejects unknown keys, bad ids, bad thresholds and missing safe defaults", () => {
    for (const bad of [{ surprise: 1 }, { id: "Nope" }, { lowBelow: 0.9, highAbove: 0.1 }, { highAbove: 1.5 }, { safeDefault: "" }, { uncertainAction: undefined }, { mode: "yolo" }]) {
      expect(parsePoints([raw(bad)]).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parsePoints([raw(), raw()]).ok).toBe(false);
    expect(parsePoints("x").ok).toBe(false);
  });
  it("a point without a corpus cannot be enforce", () => {
    expect(parsePoints([raw({ mode: "enforce" })])).toMatchObject({ ok: false, error: expect.stringContaining("corpus") });
    expect(parsePoints([raw({ mode: "enforce", calibration: CAL })]).ok).toBe(true);
  });
});

describe("#130: layering and effective mode", () => {
  const op = pt({ mode: "enforce", calibration: CAL });
  it("a repo may tighten but not loosen", () => {
    expect(layerPoints([op], [pt({ mode: "shadow", lowBelow: 0.1, highAbove: 0.9 })])).toMatchObject({ ok: true });
    expect(layerPoints([op], [pt({ lowBelow: 0.3 })]).ok).toBe(false);
    expect(layerPoints([op], [pt({ highAbove: 0.7 })]).ok).toBe(false);
    const shadowOp = pt();
    expect(layerPoints([shadowOp], [pt({ mode: "enforce", calibration: CAL })]).ok).toBe(false);
  });
  it("a repo-only point is capped at shadow", () => {
    const r = layerPoints([], [pt({ mode: "enforce", calibration: CAL })]);
    expect(r.ok && r.points[0]!.mode).toBe("shadow");
  });
  it("a wording-version or model change drops enforce back to shadow", () => {
    expect(effectiveMode(op, "kev-1")).toBe("enforce");
    expect(effectiveMode(op, "kev-2")).toBe("shadow");
    expect(effectiveMode({ ...op, question: { ...op.question, version: 2 } })).toBe("shadow");
  });
});

describe("#130: cascade", () => {
  const p = pt({ mode: "enforce", calibration: CAL });
  it("confident bands take the cheap path; the uncertain band escalates", () => {
    expect(resolveDecision(p, 0.05)).toMatchObject({ band: "low", source: "s1", acted: true });
    expect(resolveDecision(p, 0.95)).toMatchObject({ band: "high", source: "s1" });
    expect(resolveDecision(p, 0.5)).toMatchObject({ band: "uncertain", source: "escalated", action: "second-reviewer" });
  });
  it("no answer, garbage or an error is the point's safe default, with the reason", () => {
    for (const a of [undefined, NaN, 2, -1, { error: "timeout" }]) {
      expect(resolveDecision(p, a as never)).toMatchObject({ source: "static", action: "full-review" });
    }
    expect(resolveDecision(p, { error: "timeout" }).fallback).toBe("timeout");
  });
  it("in shadow nothing is acted on; when off the safe default stands", () => {
    expect(resolveDecision(pt(), 0.95).acted).toBe(false);
    expect(resolveDecision(pt({ mode: "off" }), 0.95)).toMatchObject({ acted: false, source: "static", action: "full-review" });
  });
  it("runPoint never throws, times out to the safe default and logs", async () => {
    const log: object[] = [];
    const d1 = await runPoint(pt(), { ask: async () => { throw new Error("boom"); }, sink: (e) => void log.push(e) });
    expect(d1).toMatchObject({ source: "static", fallback: expect.stringContaining("boom") });
    const d2 = await runPoint(pt(), { ask: () => new Promise(() => {}), timeoutMs: 20, sink: (e) => void log.push(e) });
    expect(d2.fallback).toBe("timeout");
    const d3 = await runPoint(pt(), { ask: async () => 0.9, sink: () => { throw new Error("sink"); } });
    expect(d3.band).toBe("high");
    expect(log).toHaveLength(2);
  });
});

describe("#130: outcome-linked report and promotion", () => {
  const p = pt({ calibration: CAL });
  const run = async (n: number, s1Right: boolean, baselineRight: boolean, log: object[]) => {
    for (let i = 0; i < n; i++) {
      const happened = i % 2 === 0;
      const d = await runPoint(p, { ask: async () => (s1Right ? (happened ? 0.95 : 0.05) : (happened ? 0.05 : 0.95)), baseline: baselineRight ? happened : !happened, sink: (e) => void log.push(e) });
      await linkOutcome((e) => void log.push(e), d.decisionId, happened);
    }
  };
  it("is promotable only when S1 beats the baseline on enough confident outcome-linked cases", async () => {
    const log: object[] = [];
    await run(30, true, false, log);
    expect(pointReport(p, log)).toMatchObject({ confident: 30, s1Accuracy: 1, baselineAccuracy: 0, promotable: true });
  });
  it("is not promotable when S1 only ties the baseline, or n is small, or there is no corpus", async () => {
    const tie: object[] = []; await run(30, true, true, tie);
    expect(pointReport(p, tie)).toMatchObject({ promotable: false, why: expect.stringContaining("does not beat") });
    const few: object[] = []; await run(5, true, false, few);
    expect(pointReport(p, few)).toMatchObject({ s1Accuracy: null, promotable: false });
    const noCorpus = pt();
    const log: object[] = []; await run(30, true, false, log);
    expect(pointReport(noCorpus, log)).toMatchObject({ promotable: false, why: expect.stringContaining("corpus") });
  });
});
