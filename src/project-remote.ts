/**
 * Gateway side of the `project.read` node op (issue #158). A node returns raw `.fleet/` text; this
 * module treats that reply as hostile: it re-checks shape, names and every size cap, then hands the
 * text to the same parser/validator as a local checkout. Nothing the node says is trusted beyond
 * being text to validate (a lying node can only produce a record that fails or passes validation
 * on its own merits, and the result is labelled as read from that node).
 */

import { MAX_DECISIONS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, isDecisionFileName, type ProjectInput } from "./project.js";
import { buildFromRaw, type LoadResult, type RawProject } from "./project-load.js";

const MAX_NAMES = 400;

const isText = (v: unknown): v is string => typeof v === "string";

export function ingestRemoteProject(payload: unknown, operator?: ProjectInput["operator"], builtinRules?: ProjectInput["builtinRules"]): { ok: true; result: LoadResult } | { ok: false; error: string } {
  const p = payload as { ok?: unknown; present?: unknown; raw?: unknown; error?: unknown } | null;
  if (!p || typeof p !== "object") return { ok: false, error: "node reply was not an object" };
  if (p.ok === false) return { ok: false, error: `node refused: ${String(p.error ?? "unknown error").slice(0, 200)}` };
  if (p.present === false) return { ok: true, result: { present: false } };
  const raw = p.raw as Record<string, unknown> | undefined;
  if (p.present !== true || !raw || typeof raw !== "object") return { ok: false, error: "node reply has no recognizable project record (does the node speak protocol 6?)" };

  let total = 0;
  const capped = (text: string, label: string, errors: Array<{ file: string; message: string }>): string | undefined => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_FILE_BYTES) { errors.push({ file: label, message: `node sent ${bytes} bytes, larger than ${MAX_FILE_BYTES}; ignored` }); return undefined; }
    if (total + bytes > MAX_TOTAL_BYTES) { errors.push({ file: label, message: `node sent more than the ${MAX_TOTAL_BYTES}-byte total; ignored` }); return undefined; }
    total += bytes;
    return text;
  };

  const errors: Array<{ file: string; message: string }> = [];
  const out: RawProject = { decisionFiles: [], errors, files: [], ignored: [] };
  // Refusals the node reported are shown, but only as bounded strings.
  if (Array.isArray(raw.errors)) {
    for (const e of raw.errors.slice(0, 50)) {
      const o = e as { file?: unknown; message?: unknown };
      if (isText(o?.file) && isText(o?.message)) errors.push({ file: o.file.slice(0, 80), message: o.message.slice(0, 200) });
    }
  }
  if (isText(raw.charterText)) { const t = capped(raw.charterText, "charter.md", errors); if (t !== undefined) { out.charterText = t; out.files.push("charter.md"); } }
  if (isText(raw.rulesText)) { const t = capped(raw.rulesText, "rules.yml", errors); if (t !== undefined) { out.rulesText = t; out.files.push("rules.yml"); } }
  if (Array.isArray(raw.decisionFiles)) {
    if (raw.decisionFiles.length > MAX_DECISIONS * 2) errors.push({ file: "decisions/", message: "node sent too many decision files" });
    else {
      for (const d of raw.decisionFiles) {
        const o = d as { name?: unknown; text?: unknown };
        // Only names the local loader would read; this also keeps path separators out.
        if (!isText(o?.name) || !isText(o?.text) || !isDecisionFileName(o.name)) { errors.push({ file: "decisions/", message: "node sent an entry that is not a decision file; ignored" }); continue; }
        const t = capped(o.text, `decisions/${o.name}`, errors);
        if (t !== undefined) { out.decisionFiles.push({ name: o.name, text: t }); out.files.push(`decisions/${o.name}`); }
      }
    }
  }
  if (Array.isArray(raw.ignored)) out.ignored = raw.ignored.filter(isText).slice(0, MAX_NAMES).map((s) => s.slice(0, 120));
  return { ok: true, result: buildFromRaw(out, operator, builtinRules) };
}
