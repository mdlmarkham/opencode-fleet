import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * This plugin registers its tools programmatically via `api.registerTool`
 * inside `definePluginEntry` — NOT via `defineToolPlugin`. That means
 * `getToolPluginMetadata(entry)` (which only reads tool-plugin entries) returns
 * undefined here, so asserting on it was always vacuously wrong.
 *
 * The durable source of truth for the tool surface is the manifest contract
 * (openclaw.plugin.json -> contracts.tools), which the loader validates against
 * the registered tools. Assert that instead.
 */
describe("opencode-fleet", () => {
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8"),
  ) as { contracts?: { tools?: string[] } };

  it("declares the full fleet tool surface in the manifest contract", () => {
    const tools = manifest.contracts?.tools ?? [];
    for (const required of [
      "fleet_dispatch",
      "fleet_sync",
      "fleet_provision",
      "fleet_capabilities",
      "fleet_provision_config",
      "fleet_resume",
      "fleet_run_status",
      "fleet_cleanup",
    ]) {
      expect(tools).toContain(required);
    }
  });
});
