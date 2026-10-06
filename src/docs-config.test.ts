/**
 * Anti-drift guard for docs/operators.md (issue #169): every config key the
 * manifest's configSchema declares must be documented, and every key the
 * config-reference tables document must exist in the manifest — in BOTH
 * directions, so documentation cannot drift from the code.
 *
 * The `budget` block is validated by src/budget.ts (parseBudgetConfig) and
 * wired in index.ts register() rather than declared in openclaw.plugin.json's
 * configSchema (the manifest is built from the entry's schema, which omits
 * it); DOCUMENTED_EXTRA_KEYS accounts for that so the docs stay complete
 * without lying about the manifest.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(repoRoot, "openclaw.plugin.json");
const DOCS = join(repoRoot, "docs", "operators.md");

/** Keys documented whose schema lives outside the manifest's configSchema. */
const DOCUMENTED_EXTRA_KEYS = ["budget"] as const;

describe("docs/operators.md config reference matches the manifest configSchema", () => {
  it("documents exactly the manifest's config keys plus the known extras", async () => {
    const [manifestRaw, docsRaw] = await Promise.all([readFile(MANIFEST, "utf8"), readFile(DOCS, "utf8")]);
    const manifest = JSON.parse(manifestRaw) as {
      configSchema: { properties: Record<string, unknown> };
    };
    const manifestKeys = new Set(Object.keys(manifest.configSchema.properties));
    expect(manifestKeys.size).toBeGreaterThan(0);

    // The config reference is the pair of pipe tables under the
    // "## Config reference" heading; each documented key is a backticked
    // first cell. Pull keys only from that section so other tables
    // (troubleshooting etc.) cannot satisfy the check.
    const section = docsRaw.slice(docsRaw.indexOf("## Config reference"));
    expect(section.length).toBeGreaterThan(0);
    const sectionEnd = section.indexOf("## ", 3);
    const tables = sectionEnd === -1 ? section : section.slice(0, sectionEnd);

    const documented = new Set<string>();
    for (const line of tables.split("\n")) {
      if (!line.startsWith("|")) continue;
      const first = line.split("|")[1]?.trim() ?? "";
      const m = first.match(/^`([A-Za-z_][A-Za-z0-9_]*)`$/);
      if (m) documented.add(m[1]);
    }
    // Drop the literal header cells ("Key", "Type", …).
    documented.delete("Key");

    const expectDocumented = new Set<string>([...manifestKeys, ...DOCUMENTED_EXTRA_KEYS]);

    const documentedButAbsent = [...documented].filter((k) => !expectDocumented.has(k));
    const manifestButUndocumented = [...expectDocumented].filter((k) => !documented.has(k));
    expect(documentedButAbsent, "documented keys that are not in the manifest/extras").toEqual([]);
    expect(manifestButUndocumented, "manifest keys not documented in operators.md").toEqual([]);
  });

  it("documents each manifest key's meaning and default (no empty rows)", async () => {
    const docsRaw = await readFile(DOCS, "utf8");
    const section = docsRaw.slice(docsRaw.indexOf("## Config reference"));
    const sectionEnd = section.indexOf("## ", 3);
    const tables = sectionEnd === -1 ? section : section.slice(0, sectionEnd);
    for (const line of tables.split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      // Skip separator rows (|---|---|).
      if (cells.length > 1 && cells.slice(1).every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      const keyRow = /^`[A-Za-z_][A-Za-z0-9_]*`$/.test(cells[1] ?? "");
      if (!keyRow) continue;
      const key = (cells[1] ?? "").replace(/^`|`$/g, "");
      expect(key, "row key").toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      const type = cells[2] ?? "";
      const def = cells[3] ?? "";
      const meaning = (cells.slice(4).join("|") ?? "").trim();
      expect(type, `${key}: type cell`).not.toBe("");
      expect(def, `${key}: default cell`).not.toBe("");
      expect(meaning, `${key}: meaning cell`).not.toBe("");
    }
  });
});