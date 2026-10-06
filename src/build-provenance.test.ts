/**
 * Build provenance: what code is each participant ACTUALLY running?
 *
 * The 2026-10-06 lesson: the fleet was "merged but not deployed" all day and
 * every parity check said otherwise, because deploy verified parity by hashing
 * `dist/index.js` — the thin ESM re-export stub that does NOT change when the
 * logic beneath it does. The check could not fail in the way that mattered.
 *
 * Contract:
 *   1. `treeDigest` is order-independent (sorts by path) and content-sensitive:
 *      the same modules in any order give the same digest; a changed module
 *      changes it; an empty build has a defined digest, never undefined.
 *   2. `digestOfDist` walks real dist dirs, hashes every `.js`, and reports a
 *      module count so "empty" is distinguishable from "clean".
 *   3. A one-line change to any module changes the digest (the proof the old
 *      entry-stub hash failed to provide).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOfDist, shortDigest, treeDigest, type ModuleHash } from "./build-provenance.js";

describe("#build-provenance: treeDigest is order-independent and content-sensitive", () => {
  const mods: ModuleHash[] = [
    { path: "b.js", sha256: "bbbb" },
    { path: "a.js", sha256: "aaaa" },
    { path: "sub/c.js", sha256: "cccc" },
  ];

  it("is independent of input order", () => {
    const d1 = treeDigest(mods);
    const d2 = treeDigest([...mods].reverse());
    const d3 = treeDigest([mods[1]!, mods[2]!, mods[0]!]);
    expect(d1).toBe(d2);
    expect(d1).toBe(d3);
  });

  it("changes when any module's content hash changes", () => {
    const changed = mods.map((m) => (m.path === "b.js" ? { ...m, sha256: "bbbb2" } : m));
    expect(treeDigest(changed)).not.toBe(treeDigest(mods));
  });

  it("changes when a module is added, but not when a path is renamed without content change", () => {
    const added = [...mods, { path: "d.js", sha256: "dddd" }];
    expect(treeDigest(added)).not.toBe(treeDigest(mods));
    // a path rename IS a change (the key is the path)
    const renamed = mods.map((m) => (m.path === "a.js" ? { ...m, path: "a2.js" } : m));
    expect(treeDigest(renamed)).not.toBe(treeDigest(mods));
  });

  it("is total: an empty build has a defined digest", () => {
    const d = treeDigest([]);
    expect(typeof d).toBe("string");
    expect(d.length).toBe(64);
    expect(shortDigest(d).length).toBe(12);
  });
});

describe("#build-provenance: digestOfDist on a real dist tree", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-bp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("hashes every .js recursively and ignores non-code files", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "node", "handler.js"), "export const b = 2;\n");
    writeFileSync(join(dir, "types.d.ts"), "export declare const a: number;\n");
    writeFileSync(join(dir, "data.json"), "{}\n");
    const r = await digestOfDist(dir);
    expect(r.modules).toBe(2); // only the two .js files
    expect(r.digest).toHaveLength(64);
  });

  it("a ONE-LINE logic change in any module changes the digest (the proof the entry-stub hash failed to give)", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "node", "handler.js"), "export const b = 2;\n");
    const before = (await digestOfDist(dir)).digest;
    // the entry stub is untouched; only a DEEP module changes
    writeFileSync(join(dir, "node", "handler.js"), "export const b = 3;\n");
    const after = (await digestOfDist(dir)).digest;
    expect(after).not.toBe(before);
  });

  it("a no-op rebuild (same content) yields the same digest", async () => {
    mkdirSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "index.js"), "export const a = 1;\n");
    const first = (await digestOfDist(dir)).digest;
    writeFileSync(join(dir, "index.js"), "export const a = 1;\n"); // rewritten, identical bytes
    const second = (await digestOfDist(dir)).digest;
    expect(second).toBe(first);
  });

  it("a missing dist directory is an empty build (digest defined, modules 0)", async () => {
    const r = await digestOfDist(join(dir, "nope"));
    expect(r.modules).toBe(0);
    expect(r.digest).toHaveLength(64);
  });
});
