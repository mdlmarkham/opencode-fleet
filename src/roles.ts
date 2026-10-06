/**
 * Roles (issue #110, slice R-0): a role pairs a prompt with a required output shape and a check on that
 * output, so a reviewer, a designer and a decomposer differ in more than wording. Pure and tested.
 *
 * Layering, per project: built-in default < operator config < repo `.fleet/roles/<name>.md`. A layer may
 * ADD context (domain notes, conventions, checklist items, skills). It may NOT widen the role's
 * permissions, drop required output fields, or relax read-only; those are fixed by the built-in and
 * operator layers, and an attempt is an error, not a silent no-op.
 *
 * Repo role text is untrusted data: delimited, size-capped, and only ever composed into the WORKER's
 * prompt for that role. A role is not a security boundary: "read-only" is a declared requirement the
 * sandbox and deny baseline enforce; the prompt only states it.
 *
 * Output is parsed, not trusted: `checkOutput` rejects what fails the schema rather than repairing it.
 */

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { quoteUntrusted } from "./untrusted.js";
import { parseTaskSpec } from "./spec.js";
import { scopeOverlap } from "./scope.js";

export const ROLE_NAMES = ["implementer", "adversarial-reviewer", "security-reviewer", "design-developer", "design-critic", "decomposer", "integrator"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type OutputKind = "diff" | "findings" | "design" | "specs" | "branches" | "critique";

export interface Permissions { readOnly: boolean; network: boolean; scripts: boolean }
export interface RoleDef {
  name: RoleName;
  version: number;
  /** The role's own instructions (trusted: built-in or operator). */
  prompt: string;
  output: { kind: OutputKind; required: string[] };
  permissions: Permissions;
  /** Skills the role relies on, by name (generic ones shipped with the plugin; repo ones are layered the same way). */
  skills: string[];
  /** Extra checklist items layers have added. */
  checklist: string[];
}

const FINDING_FIELDS = ["file", "line", "severity", "evidence"];
const RO: Permissions = { readOnly: true, network: false, scripts: false };

export const BUILTIN_ROLES: Readonly<Record<RoleName, RoleDef>> = {
  implementer: { name: "implementer", version: 1, prompt: "Implement the task in the spec. Stay inside its scope and make its verify gate pass.", output: { kind: "diff", required: [] }, permissions: { readOnly: false, network: false, scripts: false }, skills: [], checklist: [] },
  "adversarial-reviewer": { name: "adversarial-reviewer", version: 1, prompt: "Try to break this change. Re-run the build and tests yourself in your own clone. Report only findings you can show: a cited line or a failing test. Do not edit anything.", output: { kind: "findings", required: FINDING_FIELDS }, permissions: RO, skills: [], checklist: [] },
  "security-reviewer": { name: "security-reviewer", version: 1, prompt: "Review this change for security defects and write a short threat model. State what you could not check. Do not edit anything.", output: { kind: "findings", required: [...FINDING_FIELDS, "threatModel", "notChecked"] }, permissions: RO, skills: [], checklist: [] },
  "design-developer": { name: "design-developer", version: 1, prompt: "Produce a design: the options with trade-offs, a recommendation, the risks and a rollout. Do not edit code.", output: { kind: "design", required: ["options", "recommendation", "risks", "rollout"] }, permissions: RO, skills: [], checklist: [] },
  "design-critic": { name: "design-critic", version: 1, prompt: "Read the charter, the decision log and the spec. Say whether this is the right change, whether a simpler alternative exists, and whether it fits the recorded direction. Every claim needs cited evidence and a concrete alternative. Do not edit anything.", output: { kind: "critique", required: ["claim", "evidence", "alternative", "confidence", "severity"] }, permissions: RO, skills: [], checklist: [] },
  decomposer: { name: "decomposer", version: 1, prompt: "Break the goal into specs, each with a goal, acceptance criteria, a file scope and a verify gate, with non-overlapping scopes.", output: { kind: "specs", required: ["goal", "acceptance", "scope", "verify"] }, permissions: RO, skills: [], checklist: [] },
  integrator: { name: "integrator", version: 1, prompt: "Merge the verified branches in dependency order. Resolve nothing silently: report any conflict.", output: { kind: "branches", required: [] }, permissions: { readOnly: false, network: false, scripts: false }, skills: [], checklist: [] },
};

export const MAX_ROLE_TEXT = 8 * 1024;
export const MAX_CHECKLIST = 20;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RoleLayer {
  /** Layer label for error messages ("operator" or "repo"). */
  from: string;
  /** Extra prompt context appended to the role's prompt. */
  context?: string;
  checklist?: string[];
  skills?: string[];
  /** Attempts the layer must NOT be allowed (reported as errors when present). */
  permissions?: Partial<Permissions>;
  outputRequired?: string[];
  version?: number;
}

export type LayerParse = { ok: true; layer: RoleLayer } | { ok: false; error: string };
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a `.fleet/roles/<name>.md` (frontmatter + body) into a layer. Unknown keys are errors. */
export function parseRoleFile(text: string, from: string): LayerParse {
  if (text.length > MAX_ROLE_TEXT) return { ok: false, error: `${from}: role file is larger than ${MAX_ROLE_TEXT} characters` };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let front: unknown = {};
  let body = text;
  if (m) {
    try { front = YAML.parse(m[1]!); } catch (e) { return { ok: false, error: `${from}: frontmatter is not valid YAML: ${(e as Error).message.slice(0, 100)}` }; }
    body = m[2]!;
  }
  if (front === null) front = {};
  if (!isRec(front)) return { ok: false, error: `${from}: frontmatter must be a mapping` };
  for (const k of Object.keys(front)) if (!["name", "version", "checklist", "skills", "permissions", "output"].includes(k)) return { ok: false, error: `${from}: unknown key "${k}"` };
  const layer: RoleLayer = { from };
  if (front.checklist !== undefined) {
    if (!Array.isArray(front.checklist) || front.checklist.length > MAX_CHECKLIST || front.checklist.some((x) => typeof x !== "string" || !x.trim() || x.length > 300)) return { ok: false, error: `${from}: checklist must be at most ${MAX_CHECKLIST} strings of at most 300 characters` };
    layer.checklist = (front.checklist as string[]).map((x) => x.trim());
  }
  if (front.skills !== undefined) {
    if (!Array.isArray(front.skills) || front.skills.length > 10 || front.skills.some((x) => typeof x !== "string" || !SKILL_NAME.test(x))) return { ok: false, error: `${from}: skills must be at most 10 names like "write-a-spec"` };
    layer.skills = front.skills as string[];
  }
  if (front.permissions !== undefined) { if (!isRec(front.permissions)) return { ok: false, error: `${from}: permissions must be a mapping` }; layer.permissions = front.permissions as Partial<Permissions>; }
  if (isRec(front.output) && Array.isArray(front.output.required)) layer.outputRequired = front.output.required.filter((x): x is string => typeof x === "string");
  else if (front.output !== undefined) return { ok: false, error: `${from}: output must be {required: [...]}` };
  if (typeof front.version === "number") layer.version = front.version;
  const ctx = body.trim();
  if (ctx) layer.context = ctx;
  return { ok: true, layer };
}

export interface ResolvedRole extends RoleDef {
  /** The full prompt for the worker: the role's own instructions, then layered context, quoted where untrusted. */
  fullPrompt: string;
  /** `name@version#hash`: recorded in the audit manifest so a run says exactly which role text it had. */
  ref: string;
  layers: string[];
}

export type Resolved = { ok: true; role: ResolvedRole } | { ok: false; error: string };

/**
 * Apply layers in order (operator, then repo). The built-in's permissions and required output fields are
 * the floor: a layer that tries to widen a permission, relax read-only, or drop a required field is an
 * ERROR, never silently ignored.
 */
export function resolveRole(name: string, layers: RoleLayer[] = [], base: Readonly<Record<string, RoleDef>> = BUILTIN_ROLES): Resolved {
  const builtin = base[name];
  if (!builtin) return { ok: false, error: `unknown role "${name}"` };
  const role: RoleDef = { ...builtin, skills: [...builtin.skills], checklist: [...builtin.checklist], output: { ...builtin.output, required: [...builtin.output.required] }, permissions: { ...builtin.permissions } };
  const parts: string[] = [role.prompt];
  for (const l of layers) {
    for (const [k, v] of Object.entries(l.permissions ?? {}) as Array<[keyof Permissions, unknown]>) {
      if (typeof v !== "boolean") return { ok: false, error: `${l.from}: permissions.${k} must be true or false` };
      const widens = k === "readOnly" ? role.permissions.readOnly && v === false : role.permissions[k] === false && v === true;
      if (widens) return { ok: false, error: `${l.from} may not widen ${name}'s permissions (${k}); permissions are fixed by the built-in and operator layers` };
    }
    if (l.outputRequired) {
      const dropped = role.output.required.filter((f) => !l.outputRequired!.includes(f));
      if (dropped.length) return { ok: false, error: `${l.from} may not drop required output fields: ${dropped.join(", ")}` };
      for (const f of l.outputRequired) if (!role.output.required.includes(f)) role.output.required.push(f);
    }
    for (const c of l.checklist ?? []) if (role.checklist.length < MAX_CHECKLIST && !role.checklist.includes(c)) role.checklist.push(c);
    for (const s of l.skills ?? []) if (!role.skills.includes(s)) role.skills.push(s);
    if (l.context) parts.push(l.from === "repo" ? quoteUntrusted(`${l.from}-role-context`, l.context, MAX_ROLE_TEXT) : l.context);
  }
  if (role.checklist.length) parts.push(`Checklist:\n${role.checklist.map((c) => `- ${c}`).join("\n")}`);
  const fullPrompt = parts.join("\n\n");
  const hash = createHash("sha256").update(fullPrompt).update(JSON.stringify([role.permissions, role.output, role.skills])).digest("hex").slice(0, 12);
  return { ok: true, role: { ...role, fullPrompt, ref: `${role.name}@${role.version}#${hash}`, layers: layers.map((l) => l.from) } };
}

/** Read `.fleet/roles/<name>.md` from a checkout: symlinks refused, size-capped; absent = no layer. */
export async function loadRepoRole(repoDir: string, name: string): Promise<LayerParse | { ok: true; layer: undefined }> {
  if (!(ROLE_NAMES as readonly string[]).includes(name)) return { ok: false, error: `unknown role "${name}"` };
  const path = join(repoDir, ".fleet", "roles", `${name}.md`);
  for (const p of [join(repoDir, ".fleet"), join(repoDir, ".fleet", "roles"), path]) {
    try { if ((await lstat(p)).isSymbolicLink()) return { ok: false, error: `${p} is a symlink; refusing to follow it` }; } catch { return { ok: true, layer: undefined }; }
  }
  const st = await lstat(path);
  if (!st.isFile() || st.size > MAX_ROLE_TEXT) return { ok: false, error: "role file is not a regular file under the size cap" };
  return parseRoleFile(await readFile(path, "utf8"), "repo");
}

// ---- output checks: parsed, not trusted ----------------------------------------------------------------

export type OutputCheck = { ok: true } | { ok: false; error: string };

/** Check a role's output against its schema. Failing output is rejected, never repaired; "looks fine" is not a pass. */
export function checkOutput(role: Pick<RoleDef, "output" | "permissions">, output: unknown): OutputCheck {
  const kind = role.output.kind;
  if (kind === "diff" || kind === "branches") return isRec(output) || Array.isArray(output) ? { ok: true } : { ok: false, error: `${kind} output must be structured data` };
  if (kind === "findings") {
    const o = output as { findings?: unknown; threatModel?: unknown; notChecked?: unknown } | undefined;
    if (!isRec(output) || !Array.isArray(o?.findings)) return { ok: false, error: "findings output must be {findings: [...]}" };
    for (const [i, f] of (o!.findings as unknown[]).entries()) {
      if (!isRec(f)) return { ok: false, error: `findings[${i}] is not an object` };
      const need = role.output.required.filter((r) => FINDING_FIELDS.includes(r));
      const missing = need.filter((r) => f[r] === undefined || f[r] === null || f[r] === "");
      if (missing.length) return { ok: false, error: `findings[${i}] is missing ${missing.join(", ")}` };
      if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1) return { ok: false, error: `findings[${i}].line must be a positive integer` };
      if (!["blocking", "major", "minor", "nit"].includes(String(f.severity))) return { ok: false, error: `findings[${i}].severity must be blocking|major|minor|nit` };
    }
    for (const extra of role.output.required.filter((r) => !FINDING_FIELDS.includes(r))) if (!(o as Record<string, unknown>)[extra] || String((o as Record<string, unknown>)[extra]).trim() === "") return { ok: false, error: `${extra} is required for this role` };
    return { ok: true };
  }
  if (kind === "critique") {
    const items = (output as { critiques?: unknown } | undefined)?.critiques;
    if (!isRec(output) || !Array.isArray(items) || items.length > 20) return { ok: false, error: "critique output must be {critiques: [...]} with at most 20 items" };
    for (const [i, c] of items.entries()) {
      if (!isRec(c)) return { ok: false, error: `critiques[${i}] is not an object` };
      const missing = role.output.required.filter((r) => c[r] === undefined || c[r] === null || String(c[r]).trim() === "");
      if (missing.length) return { ok: false, error: `critiques[${i}] is missing ${missing.join(", ")}: a claim without evidence and an alternative is rejected` };
      if (typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1) return { ok: false, error: `critiques[${i}].confidence must be a number from 0 to 1` };
      if (!["low", "medium", "high"].includes(String(c.severity))) return { ok: false, error: `critiques[${i}].severity must be low|medium|high` };
    }
    return { ok: true };
  }
  if (kind === "design") {
    if (!isRec(output)) return { ok: false, error: "design output must be an object" };
    const missing = role.output.required.filter((r) => output[r] === undefined || output[r] === "" || (Array.isArray(output[r]) && (output[r] as unknown[]).length === 0));
    return missing.length ? { ok: false, error: `design is missing required section(s): ${missing.join(", ")}` } : { ok: true };
  }
  // specs
  if (!Array.isArray(output) || output.length === 0) return { ok: false, error: "decomposer output must be a non-empty array of specs" };
  const scopes = [];
  for (const [i, s] of output.entries()) {
    const p = parseTaskSpec(s);
    if (!p.ok || !p.spec) return { ok: false, error: `specs[${i}]: ${p.ok ? "empty spec" : p.error}` };
    if (!p.spec.acceptance?.length) return { ok: false, error: `specs[${i}] has no acceptance` };
    const v = p.spec.verify;
    if (!v || !(v.command || v.commands?.length || v.files?.length)) return { ok: false, error: `specs[${i}] has no verify gate` };
    if (!p.spec.scope?.files.length) return { ok: false, error: `specs[${i}] has no scope` };
    scopes.push(p.spec.scope);
  }
  for (let i = 0; i < scopes.length; i++) for (let j = i + 1; j < scopes.length; j++) if (scopeOverlap(scopes[i]!, scopes[j]!)) return { ok: false, error: `specs ${i} and ${j} have overlapping scope` };
  return { ok: true };
}
