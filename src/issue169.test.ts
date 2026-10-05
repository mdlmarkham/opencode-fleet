import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8")) as { configSchema: { properties: Record<string, { default?: unknown }> } };
const ops = readFileSync(join(root, "docs", "operators.md"), "utf8");
const configSection = ops.slice(ops.indexOf("## Config reference"), ops.indexOf("## What is on by default"));

/** First-column keys of the config table in docs/operators.md. */
const documented = [...configSection.matchAll(/^\| `([A-Za-z0-9_.]+)` \|/gm)].map((m) => m[1]!);
const schemaKeys = Object.keys(manifest.configSchema.properties);

describe("#169: docs/operators.md config reference matches the manifest", () => {
  it("documents every top-level config key, and only keys that exist", () => {
    expect([...documented].sort()).toEqual([...schemaKeys].sort());
  });

  it("states the manifest default for the keys whose default is a plain value", () => {
    for (const [k, v] of Object.entries(manifest.configSchema.properties)) {
      if (v.default === undefined || typeof v.default === "object") continue;
      const row = configSection.split("\n").find((l) => l.startsWith(`| \`${k}\` |`))!;
      expect(row, `${k} row`).toContain(String(v.default));
    }
  });

  it("the nested keys named for the object-valued settings exist in the manifest", () => {
    const props = manifest.configSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
    const named: Record<string, string[]> = {
      dispatch: ["defaultTarget"],
      capacity: ["maxConcurrentPerNode", "staleAfterMs"],
      project: ["gate", "maxScopePatterns", "maxAcceptanceItems", "roots", "rules", "requireCharterFields", "allowRepoBlocking"],
      s1: ["backend", "mode", "timeoutMs", "thresholds", "calibration", "backends"],
      sync: ["protectedBranches", "allowDirectPush", "blockOnScopeViolation", "requireReview", "requireReviewSource", "requireVerified", "allowSensitivePaths", "sensitivePaths"],
      workerGitIdentity: ["name", "email"],
      env: ["allowOnly", "extraDeny"],
      ssh: ["strictHostKeyChecking"],
    };
    for (const [k, nested] of Object.entries(named)) {
      for (const n of nested) expect(Object.keys(props[k]!.properties ?? {}), `${k}.${n}`).toContain(n);
    }
  });
});

describe("#169: the docs name the error strings the code emits", () => {
  const src = (f: string) => readFileSync(join(root, "src", f), "utf8");
  it("every troubleshooting message fragment appears in the source", () => {
    const frags: Array<[string, string]> = [
      ["no target node given", "targeting.ts"],
      ["no-capacity", "capacity.ts"],
      ["policy-refused", "provision.ts"],
      ["head-mismatch", "provision.ts"],
      ["detection-failed", "provision.ts"],
      ["cannot honor", "gateway-policy.ts"],
      ["cannot enter cwd", "opencode.ts"],
      ["does not support", "opencode.ts"],
      ["timed out at the wall-clock limit", "opencode.ts"],
    ];
    for (const [frag, file] of frags) {
      expect(ops, `docs mention ${frag}`).toContain(frag);
      expect(src(file), `${file} emits ${frag}`).toContain(frag);
    }
  });
});
