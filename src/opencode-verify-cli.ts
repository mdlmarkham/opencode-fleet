#!/usr/bin/env node
/** Verify an opencode capture (issues #111, #137). Usage: node dist/opencode-verify-cli.js opencode-capture.json. Exit 0 when required checks pass, 1 when one fails, 2 on bad input. */
import { readFile } from "node:fs/promises";
import { renderOpencodeReport, verifyOpencodeCapture, type OpencodeCapture } from "./opencode-verify.js";

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) { console.error("usage: opencode-verify-cli <opencode-capture.json>"); return 2; }
  let capture: OpencodeCapture;
  try {
    capture = JSON.parse(await readFile(file, "utf8")) as OpencodeCapture;
    if (typeof capture.probes !== "object" || capture.probes === null) throw new Error("not an opencode capture (needs `probes`)");
  } catch (e) { console.error(`cannot read capture: ${(e as Error).message}`); return 2; }
  const report = verifyOpencodeCapture(capture);
  console.log(renderOpencodeReport(report));
  return report.ok ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
