import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseCombo, runOne, type DispatchFn, type StatusFn } from "./bench-cli.js";
import { loadCorpus } from "./benchmark.js";

describe("#112: runner helpers", () => {
  it("parses engine[:model] combos, including a provider/id model with a colon", () => {
    expect(parseCombo("opencode")).toEqual({ engine: "opencode" });
    expect(parseCombo("pi:aperture/glm-5.3-flash:cloud")).toEqual({ engine: "pi", model: "aperture/glm-5.3-flash:cloud" });
    expect(parseCombo("")).toHaveProperty("error");
  });

  it("runs one task through injected dispatch+status and records verified", async () => {
    const dispatch: DispatchFn = vi.fn(async () => ({ runId: "run-1" }));
    const status: StatusFn = vi.fn(async () => ({ verified: true, failed: false, durationMs: 1234 }));
    const o = await runOne("dev2", "t1", "do it", { command: "true" }, { engine: "pi", model: "m" }, dispatch, status);
    expect(o).toMatchObject({ taskId: "t1", engine: "pi", model: "m", verified: true, failed: false, durationMs: 1234 });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("records an UNCHECKED run as verified:null, never as success", async () => {
    const dispatch: DispatchFn = async () => ({ runId: "run-2" });
    const status: StatusFn = async () => ({ verified: null, failed: false });
    const o = await runOne("dev2", "t2", "g", { command: "true" }, { engine: "opencode" }, dispatch, status);
    expect(o.verified).toBeNull();
  });

  it("a dispatch or status error is recorded as failed, never thrown", async () => {
    const badDispatch: DispatchFn = async () => ({ error: "node down" });
    const okStatus: StatusFn = async () => ({ verified: true, failed: false });
    const o1 = await runOne("dev2", "t3", "g", { command: "true" }, { engine: "pi" }, badDispatch, okStatus);
    expect(o1.failed).toBe(true);
    expect(o1.verified).toBeNull();

    const okDispatch: DispatchFn = async () => ({ runId: "r" });
    const badStatus: StatusFn = async () => ({ error: "timeout" });
    const o2 = await runOne("dev2", "t4", "g", { command: "true" }, { engine: "pi" }, okDispatch, badStatus);
    expect(o2.failed).toBe(true);
  });
});

describe("#112: the starter corpus is valid and checkable", () => {
  it("benchmark/corpus.json loads and every task has a real expect", () => {
    const raw = readFileSync(new URL("../benchmark/corpus.json", import.meta.url), "utf8");
    const r = loadCorpus(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks.length).toBeGreaterThanOrEqual(3);
      for (const t of r.tasks) {
        const hasFiles = Array.isArray(t.expect.files) && t.expect.files.length > 0;
        const hasCmd = typeof t.expect.command === "string" && t.expect.command.length > 0;
        expect(hasFiles || hasCmd, t.id).toBe(true);
      }
    }
  });
});
