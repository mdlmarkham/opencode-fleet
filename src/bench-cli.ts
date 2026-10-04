#!/usr/bin/env node
/**
 * Fleet benchmark runner (issue #112).
 *
 * Dispatches each corpus task to each (engine × model) combo, waits for the run,
 * reads its `verified` result, and appends one observation per run to a JSONL.
 * Aggregation/reporting is in `benchmark.ts` (pure); this file is the I/O shell.
 *
 * Usage (after `npm run build`):
 *   node dist/bench-cli.js --corpus benchmark/corpus.json \
 *        [--combos "opencode:aperture-anthropic/glm-5.3-flash:cloud,pi:aperture/glm-5.3-flash:cloud"] \
 *        [--node dev2] [--out benchmark/observations.jsonl] [--repeats 1]
 *
 * The dispatch/status work is delegated to the OpenClaw CLI (`openclaw fleet_*`)
 * rather than re-implemented here, so the benchmark measures the SHIPPED path.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCorpus, renderReport, summarize, type BenchObservation } from "./benchmark.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
}

/** `engine[:model]` -> { engine, model? }. */
export function parseCombo(s: string): { engine: string; model?: string } | { error: string } {
  const [engine, ...rest] = s.split(":");
  const model = rest.join(":");
  if (!engine) return { error: `bad combo ${JSON.stringify(s)}` };
  return { engine, ...(model ? { model } : {}) };
}

/** One dispatch via the CLI; returns { runId } or an error. Injected for tests. */
export type DispatchFn = (input: {
  node: string;
  prompt: string;
  expect: unknown;
  engine: string;
  model?: string;
}) => Promise<{ runId: string } | { error: string }>;

/** One status poll; returns the run's verified/failed outcome. Injected for tests. */
export type StatusFn = (input: { node: string; runId: string }) => Promise<
  { verified: boolean | null; failed: boolean; durationMs?: number; costUsd?: number; tokens?: number } | { error: string }
>;

/**
 * Live transports are intentionally NOT bundled: a plugin cannot re-enter the
 * gateway's agent/tool dispatch from inside an agent run (the CLI refuses by
 * design - "Gateway agent from agent exec would lose inter-session attribution").
 * The scheduler/automation layer injects a real DispatchFn/StatusFn (fleet_dispatch
 * / fleet_run_status). This module ships the injectable runOne + offline aggregation.
 */

/** Run one combo over one task; returns the observation (never throws). */
export async function runOne(
  node: string,
  taskId: string,
  goal: string,
  expect: unknown,
  combo: { engine: string; model?: string },
  dispatch: DispatchFn,
  status: StatusFn,
): Promise<BenchObservation> {
  const base: BenchObservation = { taskId, engine: combo.engine, ...(combo.model ? { model: combo.model } : {}), verified: null };
  const launched = await dispatch({ node, prompt: goal, expect, engine: combo.engine, ...(combo.model ? { model: combo.model } : {}) });
  if ("error" in launched) return { ...base, failed: true };
  const st = await status({ node, runId: launched.runId });
  if ("error" in st) return { ...base, failed: true };
  return { ...base, verified: st.verified, failed: st.failed, ...(st.durationMs ? { durationMs: st.durationMs } : {}), ...(st.tokens ? { tokens: st.tokens } : {}), ...(st.costUsd ? { costUsd: st.costUsd } : {}) };
}

async function main(): Promise<number> {
  // Offline mode: aggregate pre-recorded observations into a report. Live
  // dispatch is driven by the scheduler (see the module note); this CLI does not
  // re-enter the gateway, which the runtime forbids from inside an agent run.
  const corpusPath = arg("corpus", "benchmark/corpus.json")!;
  const recordsPath = arg("records");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const loaded = loadCorpus(await readFile(join(root, corpusPath), "utf8"));
  if (!loaded.ok) {
    console.error(`bad corpus: ${loaded.error}`);
    return 2;
  }
  if (!recordsPath) {
    console.error("no --records file given; live dispatch must be driven by the scheduler (see module note)");
    console.error(`corpus ${loaded.version} loaded with ${loaded.tasks.length} task(s)`);
    return 2;
  }
  const observations: BenchObservation[] = [];
  for (const line of (await readFile(join(root, recordsPath), "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try { observations.push(JSON.parse(line) as BenchObservation); }
    catch { console.error(`skipping unparsable observation line: ${line.slice(0, 80)}`); }
  }
  console.log(renderReport(summarize(observations), loaded.version));
  return 0;
}

// Only run when invoked directly (so tests can import runOne/parseCombo).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
