/**
 * Benchmark task corpus (issue #112) — the evidence layer.
 *
 * A standing, versioned set of real, CHECKABLE tasks. Each task carries a
 * deterministic success check (the #40 `expect`/`verified` gate), so the fleet's
 * "verified rate" is measured, not asserted. This is deliberately NOT a CI test
 * suite: it measures the fleet (engines/models), not the plugin.
 *
 * Pure module: corpus parsing/validation and report aggregation here; the actual
 * dispatch lives in the runner so this can be unit-tested with no node.
 */

import type { ExpectCheck } from "./verify.js";

/** One benchmark task. `expect` is mandatory: a task with no check is not a benchmark. */
export interface BenchTask {
  /** Stable id (slug). Used as the corpus key and in reports. */
  id: string;
  /** The goal handed to the worker (rendered like a #65 spec goal). */
  goal: string;
  /** Acceptance criteria (human-readable; also feeds adjudication if enabled). */
  acceptance?: string[];
  /** Deterministic success check — REQUIRED (issue #40 gate). */
  expect: ExpectCheck;
  /** Optional per-task timeout override, ms. */
  timeoutMs?: number;
  /** Free-form tags (e.g. "python", "refactor", "tests") for slicing reports. */
  tags?: string[];
}

export type CorpusResult = { ok: true; tasks: BenchTask[]; version: string } | { ok: false; error: string };

/** A corpus file is JSON: `{ version, tasks: BenchTask[] }`. */
export function loadCorpus(raw: string): CorpusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `corpus is not valid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "corpus must be an object" };
  const c = parsed as { version?: unknown; tasks?: unknown };
  if (typeof c.version !== "string" || c.version.trim() === "") {
    return { ok: false, error: "corpus.version is required (a non-empty string; bump it when tasks change)" };
  }
  if (!Array.isArray(c.tasks) || c.tasks.length === 0) {
    return { ok: false, error: "corpus.tasks must be a non-empty array" };
  }
  const tasks: BenchTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < c.tasks.length; i++) {
    const t = c.tasks[i] as Partial<BenchTask> | undefined;
    const where = `tasks[${i}]`;
    if (!t || typeof t !== "object") return { ok: false, error: `${where} must be an object` };
    if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) {
      return { ok: false, error: `${where}.id must be a slug (a-z0-9-_ , <=64)` };
    }
    if (seen.has(t.id)) return { ok: false, error: `duplicate task id "${t.id}"` };
    seen.add(t.id);
    if (typeof t.goal !== "string" || t.goal.trim() === "") {
      return { ok: false, error: `${where}.goal is required` };
    }
    if (!t.expect || typeof t.expect !== "object") {
      return { ok: false, error: `${where}.expect is required — a task with no check is not a benchmark` };
    }
    const expect = t.expect as ExpectCheck;
    const files = Array.isArray(expect.files) ? expect.files : [];
    const hasFiles = files.length > 0;
    const hasCmd = typeof expect.command === "string" && expect.command.trim() !== "";
    if (!hasFiles && !hasCmd) {
      return { ok: false, error: `${where}.expect must name at least one file or a command` };
    }
    if (t.acceptance !== undefined && (!Array.isArray(t.acceptance) || t.acceptance.some((a) => typeof a !== "string"))) {
      return { ok: false, error: `${where}.acceptance must be an array of strings` };
    }
    if (t.tags !== undefined && (!Array.isArray(t.tags) || t.tags.some((a) => typeof a !== "string"))) {
      return { ok: false, error: `${where}.tags must be an array of strings` };
    }
    tasks.push({
      id: t.id,
      goal: t.goal,
      ...(t.acceptance ? { acceptance: t.acceptance } : {}),
      expect: t.expect as ExpectCheck,
      ...(typeof t.timeoutMs === "number" ? { timeoutMs: t.timeoutMs } : {}),
      ...(t.tags ? { tags: t.tags } : {}),
    });
  }
  return { ok: true, tasks, version: c.version };
}

// ---------------------------------------------------------------------------
// Report aggregation — the numbers that make the fleet provable.
// ---------------------------------------------------------------------------

/** One observed run of one task on one engine/model. */
export interface BenchObservation {
  taskId: string;
  engine: string;
  model?: string;
  /** Did the run satisfy its gate? (`verified` from #40; null = ungated/failed to check.) */
  verified: boolean | null;
  /** Did a human/manager have to intervene to finish or rescue it? */
  intervened?: boolean;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  /** True when the run exited non-zero or reported an error. */
  failed?: boolean;
}

export interface ComboReport {
  engine: string;
  model?: string;
  runs: number;
  /** verified / runs (verified===true only; null excluded from the numerator AND noted). */
  verifiedRate: number | null;
  unknown: number;
  interventionRate: number | null;
  failRate: number | null;
  meanDurationMs: number | null;
  meanCostUsd: number | null;
  /** Smallest n that supports a headline number; below it the rate is reported but flagged. */
  lowConfidence: boolean;
}

export const MIN_CONFIDENT_N = 10;

const comboKey = (o: BenchObservation): string => `${o.engine}\u0000${o.model ?? ""}`;

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Aggregate observations into a per-combo report. Pure. */
export function summarize(observations: BenchObservation[], minN = MIN_CONFIDENT_N): ComboReport[] {
  const byCombo = new Map<string, BenchObservation[]>();
  for (const o of observations) {
    const k = comboKey(o);
    (byCombo.get(k) ?? byCombo.set(k, []).get(k)!).push(o);
  }
  const out: ComboReport[] = [];
  for (const [k, runs] of byCombo) {
    const [engine, model] = k.split("\u0000");
    const n = runs.length;
    const verifiedTrue = runs.filter((r) => r.verified === true).length;
    const unknown = runs.filter((r) => r.verified === null || r.verified === undefined).length;
    const decided = n - unknown;
    const intervened = runs.filter((r) => r.intervened === true).length;
    const failed = runs.filter((r) => r.failed === true).length;
    out.push({
      engine,
      ...(model ? { model } : {}),
      runs: n,
      verifiedRate: decided > 0 ? verifiedTrue / decided : null,
      unknown,
      interventionRate: n > 0 ? intervened / n : null,
      failRate: n > 0 ? failed / n : null,
      meanDurationMs: mean(runs.map((r) => r.durationMs).filter((x): x is number => typeof x === "number")),
      meanCostUsd: mean(runs.map((r) => r.costUsd).filter((x): x is number => typeof x === "number")),
      lowConfidence: decided < minN,
    });
  }
  return out.sort((a, b) => (b.verifiedRate ?? -1) - (a.verifiedRate ?? -1) || a.engine.localeCompare(b.engine));
}

/** Human-readable report (used by the runner's summary; deterministic for tests). */
export function renderReport(reports: ComboReport[], corpusVersion: string): string {
  const lines: string[] = [`# Fleet benchmark report (corpus ${corpusVersion})`, ""];
  if (reports.length === 0) lines.push("(no observations)");
  for (const r of reports) {
    const vr = r.verifiedRate === null ? "n/a" : `${(r.verifiedRate * 100).toFixed(0)}%`;
    const ir = r.interventionRate === null ? "n/a" : `${(r.interventionRate * 100).toFixed(0)}%`;
    const cost = r.meanCostUsd === null ? "n/a" : `$${r.meanCostUsd.toFixed(4)}`;
    lines.push(
      `- ${r.engine}${r.model ? ` / ${r.model}` : ""}: verified ${vr} on n=${r.runs}` +
        `${r.unknown ? ` (${r.unknown} unknown)` : ""}, intervene ${ir}, cost ${cost}` +
        `${r.lowConfidence ? " [low confidence: n<" + MIN_CONFIDENT_N + "]" : ""}`,
    );
  }
  return lines.join("\n");
}
