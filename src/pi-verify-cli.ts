#!/usr/bin/env node
/**
 * Verify a Pi capture (issue #137). Usage after `npm run build`:
 *
 *   node dist/pi-verify-cli.js pi-capture.json
 *
 * Exit 0 when every required check is confirmed, 1 when one is missing, 2 on bad input.
 */
import { readFile } from "node:fs/promises";
import { renderPiReport, verifyPiCapture, type PiCapture } from "./pi-verify.js";

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: pi-verify-cli <pi-capture.json>");
    return 2;
  }
  let capture: PiCapture;
  try {
    capture = JSON.parse(await readFile(file, "utf8")) as PiCapture;
    if (typeof capture.help !== "string" || !Array.isArray(capture.runs)) throw new Error("not a pi capture (needs `help` and `runs`)");
  } catch (e) {
    console.error(`cannot read capture: ${(e as Error).message}`);
    return 2;
  }
  const report = verifyPiCapture(capture);
  console.log(renderPiReport(report));
  return report.ok ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
