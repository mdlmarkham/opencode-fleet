#!/usr/bin/env node
/**
 * Score reviewer results against the calibration corpus (issue #127). Usage (after `npm run build`):
 *   node dist/reviewer-calibrate-cli.js --corpus calibration/reviewer-corpus.json --results results.json [--date 2026-10-06] [--out report.md]
 * `results.json` is CaseResult[] (what a live adapter or a manual run produced). Exit 0 when scored, 2 on bad input.
 */
import { readFile, writeFile } from "node:fs/promises";
import { buildReport, loadCorpus, type CaseResult } from "./reviewer-calibration.js";
import { renderReviewerReport } from "./reviewer-run.js";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : undefined; };

async function main(): Promise<number> {
  const corpusPath = arg("corpus"), resultsPath = arg("results");
  if (!corpusPath || !resultsPath) { console.error("usage: reviewer-calibrate-cli --corpus <corpus.json> --results <results.json> [--date YYYY-MM-DD] [--out report.md]"); return 2; }
  try {
    const corpus = loadCorpus(await readFile(corpusPath, "utf8"));
    if (!corpus.ok) throw new Error(`corpus: ${corpus.error}`);
    const results = JSON.parse(await readFile(resultsPath, "utf8")) as CaseResult[];
    if (!Array.isArray(results)) throw new Error("results must be an array of CaseResult");
    const date = arg("date") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
    const text = renderReviewerReport(buildReport(corpus.corpus, results, date));
    const out = arg("out");
    if (out) await writeFile(out, text + "\n"); else console.log(text);
    return 0;
  } catch (e) { console.error(`cannot score: ${(e as Error).message}`); return 2; }
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
