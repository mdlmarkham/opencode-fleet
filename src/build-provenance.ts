/**
 * Build provenance: what code is each participant ACTUALLY running?
 *
 * The lesson from 2026-10-06: the fleet was "merged but not deployed" all day,
 * and every parity check said otherwise. The reason was mechanical —
 * `deploy.ts` verified parity by hashing `dist/index.js`, the thin ESM
 * re-export stub (280 lines of `import ... from "./x.js"`). That file does NOT
 * change when the logic beneath it changes, so the hash was constant while the
 * running code was stale. The check could not fail in the way that mattered.
 *
 * A build's identity is the CONTENT OF ITS CODE MODULES, not its entry point.
 * `treeDigest` hashes every built `.js` under dist (sorted, path + content), so a
 * one-line change in any module changes the digest and a no-op rebuild does not.
 *
 * Pure: the digest is a function of a list of {path, sha256} pairs, so it is
 * testable without a filesystem and identical on any host.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** One built module: its dist-relative path and its sha256. */
export interface ModuleHash {
  path: string;
  sha256: string;
}

/**
 * A stable digest of a build's code. Sort by path first, so filesystem
 * enumeration order never matters; then hash `path\0sha\0path\0sha...`. An empty
 * list yields a defined digest (of the empty string), never undefined.
 */
export function treeDigest(modules: readonly ModuleHash[]): string {
  const sorted = [...modules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = sorted.map((m) => `${m.path}\u0000${m.sha256}`).join("\u0000");
  return createHash("sha256").update(payload).digest("hex");
}

/** Short form for display and comparison in reports. */
export const shortDigest = (d: string): string => d.slice(0, 12);

/**
 * Compute the tree digest of a built dist directory on disk: every `.js`
 * (and `.d.ts`/`.json` are excluded — only executed code counts) under `distDir`,
 * recursively, as {dist-relative path, sha256}. Returns the digest and the module
 * count so a caller can tell "empty" from "clean".
 */
export async function digestOfDist(distDir: string): Promise<{ digest: string; modules: number }> {
  const { readFile } = await import("node:fs/promises");
  const out: ModuleHash[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith(".js")) continue;
      const rel = relative(distDir, full).split(sep).join("/");
      const buf = await readFile(full);
      out.push({ path: rel, sha256: createHash("sha256").update(buf).digest("hex") });
    }
  }
  await walk(distDir);
  return { digest: treeDigest(out), modules: out.length };
}
