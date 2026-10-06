/**
 * Source reader for the pin tests that assert on the gateway wiring. The
 * gateway registers its tools from `src/index.ts` plus the per-group modules
 * under `src/tools/` (issue #43), so a pin on "the gateway source" reads them all.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

export function gatewaySrc(): string {
  const tools = readdirSync(join(SRC, "tools")).filter((f) => f.endsWith(".ts")).sort();
  // Tool modules import siblings as "../x.js"; normalize to "./x.js" so import-path pins read as they did in the single file.
  const fromTools = tools.map((f) => readFileSync(join(SRC, "tools", f), "utf8").replace(/(from |import\()"\.\.\//g, '$1"./'));
  return [readFileSync(join(SRC, "index.ts"), "utf8"), ...fromTools].join("\n");
}
