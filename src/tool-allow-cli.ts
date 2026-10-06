#!/usr/bin/env node
/** Check agent tool allow arrays against the registered fleet tools (issue #261). Usage: node dist/tool-allow-cli.js <openclaw.json> [openclaw.plugin.json]. Exit 0 in parity, 1 on drift, 2 on bad input. */
import { readFile } from "node:fs/promises";
import { checkToolAllow, parseHostConfig, renderAllowReport } from "./tool-allow.js";

async function main(): Promise<number> {
  const [cfgPath, manifestPath = new URL("../openclaw.plugin.json", import.meta.url).pathname] = process.argv.slice(2);
  if (!cfgPath) { console.error("usage: tool-allow-cli <openclaw.json> [openclaw.plugin.json]"); return 2; }
  try {
    const config = await parseHostConfig(await readFile(cfgPath, "utf8"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contracts?: { tools?: string[] } };
    const tools = manifest.contracts?.tools;
    if (!Array.isArray(tools) || tools.length === 0) throw new Error("the manifest has no contracts.tools");
    const report = checkToolAllow(config, tools);
    console.log(renderAllowReport(report));
    return report.ok ? 0 : 1;
  } catch (e) { console.error(`cannot check: ${(e as Error).message}`); return 2; }
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
