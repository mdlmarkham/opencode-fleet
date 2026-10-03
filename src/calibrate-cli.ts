#!/usr/bin/env node
/**
 * Run the S1 calibration set against a backend and print the threshold report
 * (issue #78). Usage (after `npm run build`):
 *
 *   node dist/calibrate-cli.js --set commands --backend local-kev [--url http://127.0.0.1:8009]
 *        [--model kev-latest] [--variant v1] [--out calibration/report-local-kev.md]
 *        [--max-false-allow 0.02] [--max-false-block 0.2]
 *
 * One S1 call per item (one question per call). Items the backend failed on are
 * excluded and counted, never scored as 0, and a high failure rate fails the run.
 * `local-kev` needs no network egress; hosted backends send the labelled text
 * (synthetic, no real secrets) to that service, so run them deliberately.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { s1Configured } from "./decision.js";
import { buildReport, loadLabelled, renderReport } from "./calibrate.js";
import { scoreItems } from "./calibrate-run.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
}

async function main(): Promise<number> {
  const set = arg("set", "commands")!;
  if (set !== "commands" && set !== "outputs") {
    console.error("--set must be commands or outputs");
    return 2;
  }
  const variant = arg("variant", "v1")!;
  const backend = arg("backend", "local-kev")!;
  const model = arg("model");
  const url = arg("url") ?? s1Configured();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "calibration");
  const loaded = loadLabelled(await readFile(join(root, `${set}.jsonl`), "utf8"));
  if (!loaded.ok) {
    console.error(`bad labelled set: ${loaded.error}`);
    return 2;
  }
  const questions = JSON.parse(await readFile(join(root, "questions.json"), "utf8")) as Record<string, Record<string, string>>;
  const question = questions[set]?.[variant];
  if (!question) {
    console.error(`no question variant ${set}/${variant} in calibration/questions.json`);
    return 2;
  }

  const run = await scoreItems(loaded.items, question, set === "commands" ? "command" : "text", { url, model, concurrency: Number(arg("concurrency", "4")) });
  const { scored, failed } = run;
  const usedModel = run.model ?? model ?? "unknown";

  if (failed.length > loaded.items.length * 0.1) {
    console.error(`too many failures (${failed.length}/${loaded.items.length}); first: ${failed[0]}`);
    return 1;
  }
  const report = buildReport(scored, {
    backend,
    model: usedModel,
    question,
    maxFalseAllow: Number(arg("max-false-allow", "0.02")),
    maxFalseBlock: Number(arg("max-false-block", "0.2")),
  });
  let text = renderReport(report);
  if (failed.length) text += `\n${failed.length} item(s) failed and are excluded from every figure above:\n${failed.map((x) => `- ${x}`).join("\n")}\n`;
  const out = arg("out");
  if (out) await writeFile(out, text);
  process.stdout.write(text);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
