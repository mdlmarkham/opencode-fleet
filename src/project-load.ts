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

/** Raw, size-capped, symlink-checked text of the `.fleet/` files, before any parsing. */
export interface RawProject {
  charterText?: string;
  rulesText?: string;
  decisionFiles: Array<{ name: string; text: string }>;
  /** Refusals found while reading (symlink, oversize, ...). */
  errors: ProjectError[];
  files: string[];
  ignored: string[];
}
export type RawResult = { present: false } | { present: true; raw: RawProject };

/**
 * Read exactly the known `.fleet/` files with the caps and symlink refusal above. This is the part a
 * node runs for `project.read` (issue #158); parsing stays on the gateway, which never trusts a node.
 */
export async function readProjectFiles(repoRoot: string): Promise<RawResult> {
  const dir = join(repoRoot, FLEET_DIR);
  let st;
  try { st = await lstat(dir); } catch { return { present: false }; }
  const fail = (message: string): RawResult => ({ present: true, raw: { decisionFiles: [], errors: [{ file: FLEET_DIR, message }], files: [], ignored: [] } });
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
  const raw: RawProject = { decisionFiles: [], errors, files, ignored: [] };
  const charter = await readOne(join(dir, "charter.md"), "charter.md");
  if (charter) { if (charter.ok) raw.charterText = charter.text; else errors.push(charter.error); }
  const rules = await readOne(join(dir, "rules.yml"), "rules.yml");
  if (rules) { if (rules.ok) raw.rulesText = rules.text; else errors.push(rules.error); }

  const ignored = raw.ignored;
  let top: string[] = [];
  try { top = await readdir(dir); } catch { /* unreadable: reported by the missing files */ }
  for (const name of top) if (!["charter.md", "rules.yml", "decisions", "roles", "skills"].includes(name)) ignored.push(name);

  const decisionFiles = raw.decisionFiles;
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
  return { present: true, raw };
}

/** Build the validated record from raw file text (gateway side; the text is untrusted wherever it came from). */
export function buildFromRaw(raw: RawProject, operator?: ProjectInput["operator"], builtinRules?: ProjectInput["builtinRules"]): Extract<LoadResult, { present: true }> {
  const input: ProjectInput = { ...(operator ? { operator } : {}), ...(builtinRules ? { builtinRules } : {}), decisionFiles: raw.decisionFiles };
  if (raw.charterText !== undefined) input.charterText = raw.charterText;
  if (raw.rulesText !== undefined) input.rulesText = raw.rulesText;
  const record = buildProjectRecord(input);
  record.errors.unshift(...raw.errors);
  return { present: true, record, files: raw.files, ignored: raw.ignored };
}

export async function loadProjectRecord(repoRoot: string, operator?: ProjectInput["operator"], builtinRules?: ProjectInput["builtinRules"]): Promise<LoadResult> {
  const r = await readProjectFiles(repoRoot);
  return r.present ? buildFromRaw(r.raw, operator, builtinRules) : { present: false };
}
