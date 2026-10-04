/**
 * Read a `.fleet/` record from a checkout (issue #114). Strict by construction: only known file
 * names are read, every file and the total are size-capped, and any symlink under `.fleet/` (or a
 * `.fleet` that itself resolves outside the repo) is refused rather than followed. Everything read
 * is untrusted repo text; parsing and layering live in project.ts.
 */

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { MAX_DECISIONS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, buildProjectRecord, isDecisionFileName, type ProjectError, type ProjectInput, type ProjectRecord } from "./project.js";

export const FLEET_DIR = ".fleet";

export type LoadResult =
  | { present: false }
  | { present: true; record: ProjectRecord; files: string[]; ignored: string[] };

type Read = { ok: true; text: string } | { ok: false; error: ProjectError };

export async function loadProjectRecord(repoRoot: string, operator?: ProjectInput["operator"], builtinRules?: ProjectInput["builtinRules"]): Promise<LoadResult> {
  const dir = join(repoRoot, FLEET_DIR);
  let st;
  try { st = await lstat(dir); } catch { return { present: false }; }
  const fail = (message: string): LoadResult => ({ present: true, record: { schemaVersion: 1, rules: [], decisions: [], errors: [{ file: FLEET_DIR, message }], warnings: [] }, files: [], ignored: [] });
  if (st.isSymbolicLink()) return fail(".fleet is a symlink; refusing to follow it");
  if (!st.isDirectory()) return fail(".fleet is not a directory");
  let root: string;
  try {
    root = await realpath(repoRoot);
    const real = await realpath(dir);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) return fail(".fleet resolves outside the repository");
  } catch (e) {
    return fail(`cannot resolve .fleet: ${(e as Error).message}`);
  }

  let total = 0;
  const files: string[] = [];
  const readOne = async (path: string, label: string): Promise<Read | undefined> => {
    let s;
    try { s = await lstat(path); } catch { return undefined; }
    if (s.isSymbolicLink()) return { ok: false, error: { file: label, message: "is a symlink; refusing to follow it" } };
    if (!s.isFile()) return { ok: false, error: { file: label, message: "is not a regular file" } };
    if (s.size > MAX_FILE_BYTES) return { ok: false, error: { file: label, message: `is larger than ${MAX_FILE_BYTES} bytes` } };
    if (total + s.size > MAX_TOTAL_BYTES) return { ok: false, error: { file: label, message: `would exceed the ${MAX_TOTAL_BYTES}-byte total for .fleet/` } };
    total += s.size;
    files.push(label);
    return { ok: true, text: await readFile(path, "utf8") };
  };

  const errors: ProjectError[] = [];
  const input: ProjectInput = { ...(operator ? { operator } : {}), ...(builtinRules ? { builtinRules } : {}) };
  const charter = await readOne(join(dir, "charter.md"), "charter.md");
  if (charter) { if (charter.ok) input.charterText = charter.text; else errors.push(charter.error); }
  const rules = await readOne(join(dir, "rules.yml"), "rules.yml");
  if (rules) { if (rules.ok) input.rulesText = rules.text; else errors.push(rules.error); }

  const ignored: string[] = [];
  let top: string[] = [];
  try { top = await readdir(dir); } catch { /* unreadable: reported by the missing files */ }
  for (const name of top) if (!["charter.md", "rules.yml", "decisions", "roles", "skills"].includes(name)) ignored.push(name);

  const decisionFiles: Array<{ name: string; text: string }> = [];
  let ddir: string[] = [];
  try {
    const dst = await lstat(join(dir, "decisions"));
    if (dst.isSymbolicLink()) errors.push({ file: "decisions/", message: "is a symlink; refusing to follow it" });
    else if (dst.isDirectory()) ddir = (await readdir(join(dir, "decisions"))).sort();
  } catch { /* no decisions directory */ }
  if (ddir.length > MAX_DECISIONS * 2) errors.push({ file: "decisions/", message: "has too many entries" });
  else {
    for (const name of ddir) {
      if (!isDecisionFileName(name)) { ignored.push(`decisions/${name}`); continue; }
      const r = await readOne(join(dir, "decisions", name), `decisions/${name}`);
      if (!r) continue;
      if (r.ok) decisionFiles.push({ name, text: r.text }); else errors.push(r.error);
    }
  }
  input.decisionFiles = decisionFiles;
  const record = buildProjectRecord(input);
  record.errors.unshift(...errors);
  return { present: true, record, files, ignored };
}
