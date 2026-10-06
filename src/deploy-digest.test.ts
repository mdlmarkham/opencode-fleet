/**
 * Issue #281: deploy parity must hash the CODE, not the entry stub.
 *
 * The 2026-10-06 defect: `deploy.ts` verified parity by hashing `dist/index.js`,
 * a thin ESM re-export stub that does NOT change when a deeper module's logic
 * changes. A stale install reported a MATCH — the mechanical reason "merged but
 * not deployed" was undetectable.
 *
 * Contract:
 *   1. `digestOfDist` (the digest the deploy now uses) changes when a DEEP module
 *      changes while `index.js` is byte-identical — the exact proof the old
 *      single-file hash could not give.
 *   2. A no-op rewrite yields the same digest (no false mismatch).
 *   3. A missing dist is distinguishable (0 modules) from a clean one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { digestOfDist } from "./build-provenance.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet281-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ENTRY = "import './node/handler.js';\nimport './mission-store.js';\n";

describe("#281: the deploy digest is the code tree, not the entry file", () => {
  it("a deep-module change moves the digest while dist/index.js is byte-identical", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), ENTRY);
    writeFileSync(join(dir, "node", "handler.js"), "export const x = 1;\n");
    const entryBefore = createHash("sha256").update(readFileSync(join(dir, "index.js"))).digest("hex");
    const d1 = (await digestOfDist(dir)).digest;

    // change ONLY a deep module; the entry file is untouched
    writeFileSync(join(dir, "node", "handler.js"), "export const x = 2;\n");
    const entryAfter = createHash("sha256").update(readFileSync(join(dir, "index.js"))).digest("hex");
    const d2 = (await digestOfDist(dir)).digest;

    // the OLD check (entry file) would see no change; the NEW check (tree) must
    expect(entryAfter).toBe(entryBefore);
    expect(d2).not.toBe(d1);
  });

  it("a no-op rewrite of every module yields the same digest (no false mismatch)", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), ENTRY);
    writeFileSync(join(dir, "node", "handler.js"), "export const x = 1;\n");
    const first = (await digestOfDist(dir)).digest;
    // rewrite identical bytes
    writeFileSync(join(dir, "index.js"), ENTRY);
    writeFileSync(join(dir, "node", "handler.js"), "export const x = 1;\n");
    const second = (await digestOfDist(dir)).digest;
    expect(second).toBe(first);
  });

  it("a missing dist is 0 modules; a present-but-empty dist is also 0 (the caller fails closed on either)", async () => {
    expect((await digestOfDist(join(dir, "nope"))).modules).toBe(0);
    mkdirSync(join(dir, "empty"), { recursive: true });
    const empty = await digestOfDist(join(dir, "empty"));
    expect(empty.modules).toBe(0);
    expect(empty.digest).toHaveLength(64);
  });

  it("adding a module changes the digest (a new file the entry stub never imports still counts)", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), ENTRY);
    const before = (await digestOfDist(dir)).digest;
    writeFileSync(join(dir, "node", "extra.js"), "export const z = 9;\n");
    const after = (await digestOfDist(dir)).digest;
    expect(after).not.toBe(before);
  });
});
