/**
 * The `.fleet/` project record (issue #114, P-0): schemas, parsers and layering. Pure: text in,
 * typed record plus precise errors out. Nothing here reads the disk (see project-load.ts), calls a
 * model, or throws on bad input.
 *
 * Everything in a record is UNTRUSTED repo text. It is data to show and to check specs against,
 * never instructions to the manager. Unknown keys are rejected, because an unknown key is where
 * behaviour gets smuggled in. Layering is built-in defaults < operator config < repo `.fleet/`, and
 * a repo can add rules and context but can never weaken what the operator set (see mergeRules).
 */

import YAML from "yaml";
import { parseScope } from "./scope.js";

export const PROJECT_SCHEMA_VERSION = 1;

export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
export const MAX_RULES = 200;
export const MAX_DECISIONS = 200;
export const MAX_LIST_ITEMS = 50;
export const MAX_TEXT = 4000;

export interface ProjectError {
  file: string;
  field?: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], file: string, at: string, errors: ProjectError[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push({ file, field: at ? `${at}.${k}` : k, message: `unknown key "${k}" (allowed: ${allowed.join(", ")})` });
}

/** Strict, alias-free YAML: no anchors/aliases (alias bombs), no duplicate keys, core schema only. */
export function parseYaml(text: string, file: string): { ok: true; value: unknown } | { ok: false; error: ProjectError } {
  try {
    return { ok: true, value: YAML.parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true, strict: true }) as unknown };
  } catch (e) {
    return { ok: false, error: { file, message: `invalid YAML: ${(e as Error).message.split("\n")[0]}` } };
  }
}

/** Split `---` frontmatter from a markdown body. */
export function splitFrontmatter(text: string, file: string): { ok: true; front: unknown; body: string } | { ok: false; error: ProjectError } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, error: { file, message: "missing YAML frontmatter (the file must start with a --- block)" } };
  const y = parseYaml(m[1], file);
  if (!y.ok) return y;
  return { ok: true, front: y.value, body: m[2] };
}

/** `## Heading` sections of a markdown body, by lowercase heading. Text before the first heading is ignored prose. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let buf: string[] = [];
  const flush = () => { if (name !== undefined) out.set(name, buf.join("\n").trim()); };
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); name = h[1].trim().toLowerCase(); buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

const bullets = (s: string): string[] => s.split(/\r?\n/).map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);

// ---------------------------------------------------------------------------
// charter.md
// ---------------------------------------------------------------------------

export const CHARTER_FIELDS = ["goal", "users", "constraints", "nonGoals", "successCriteria", "riskiestAssumptions"] as const;
export type CharterField = (typeof CHARTER_FIELDS)[number];
const CHARTER_HEADINGS: Record<string, CharterField> = {
  goal: "goal", users: "users", constraints: "constraints", "non-goals": "nonGoals", "success criteria": "successCriteria", "riskiest assumptions": "riskiestAssumptions",
};
const CHARTER_LIST: ReadonlySet<CharterField> = new Set(["users", "constraints", "nonGoals", "successCriteria", "riskiestAssumptions"]);

export interface Charter {
  schemaVersion: number;
  name?: string;
  goal?: string;
  users?: string[];
  constraints?: string[];
  nonGoals?: string[];
  successCriteria?: string[];
  riskiestAssumptions?: string[];
}

export function parseCharter(text: string, file = "charter.md"): { charter?: Charter; errors: ProjectError[] } {
  const errors: ProjectError[] = [];
  const fm = splitFrontmatter(text, file);
  if (!fm.ok) return { errors: [fm.error] };
  if (!isObj(fm.front)) return { errors: [{ file, message: "frontmatter must be a mapping" }] };
  unknownKeys(fm.front, ["schemaVersion", "name"], file, "", errors);
  if (fm.front.schemaVersion !== PROJECT_SCHEMA_VERSION) errors.push({ file, field: "schemaVersion", message: `must be ${PROJECT_SCHEMA_VERSION}` });
  const charter: Charter = { schemaVersion: PROJECT_SCHEMA_VERSION };
  if (fm.front.name !== undefined) {
    if (typeof fm.front.name !== "string" || fm.front.name.trim() === "" || fm.front.name.length > 100) errors.push({ file, field: "name", message: "must be a string of 1-100 characters" });
    else charter.name = fm.front.name.trim();
  }
  for (const [heading, text2] of sections(fm.body)) {
    const key = CHARTER_HEADINGS[heading];
    if (!key) { errors.push({ file, field: heading, message: `unknown section "## ${heading}" (allowed: ${Object.keys(CHARTER_HEADINGS).join(", ")})` }); continue; }
    if (text2.length > MAX_TEXT) { errors.push({ file, field: key, message: `section is longer than ${MAX_TEXT} characters` }); continue; }
    if (CHARTER_LIST.has(key)) {
      const items = bullets(text2);
      if (items.length > MAX_LIST_ITEMS) errors.push({ file, field: key, message: `more than ${MAX_LIST_ITEMS} items` });
      else if (items.length > 0) (charter as unknown as Record<string, string[]>)[key] = items;
    } else if (text2 !== "") {
      (charter as unknown as Record<string, string>)[key] = text2;
    }
  }
  return errors.length ? { errors } : { charter, errors };
}

// ---------------------------------------------------------------------------
// rules.yml
// ---------------------------------------------------------------------------

export type RuleSeverity = "advise" | "block-candidate" | "block";
const SEVERITY_ORDER: Record<RuleSeverity, number> = { advise: 0, "block-candidate": 1, block: 2 };
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface Rule {
  id: string;
  /** advise: a nudge. block-candidate: the repo asks to block (only effective if the operator allows it). block: operator-only. */
  severity: RuleSeverity;
  message: string;
  /** Why the rule exists (a decision, an incident, a PR). */
  evidence?: string;
  match: { paths?: string[]; keywords?: string[] };
  /** "If you touch this, you must also ..." obligations, as plain text. */
  requires?: string[];
}

export function parseRule(raw: unknown, file: string, at: string, allowBlock: boolean, errors: ProjectError[]): Rule | undefined {
  if (!isObj(raw)) { errors.push({ file, field: at, message: "rule must be a mapping" }); return undefined; }
  const before = errors.length;
  unknownKeys(raw, ["id", "severity", "message", "evidence", "match", "requires"], file, at, errors);
  if (typeof raw.id !== "string" || !RULE_ID.test(raw.id)) errors.push({ file, field: `${at}.id`, message: "must match [a-z0-9][a-z0-9._-]{0,63}" });
  const sevs: RuleSeverity[] = allowBlock ? ["advise", "block-candidate", "block"] : ["advise", "block-candidate"];
  if (typeof raw.severity !== "string" || !sevs.includes(raw.severity as RuleSeverity)) {
    errors.push({ file, field: `${at}.severity`, message: raw.severity === "block" && !allowBlock ? "`block` is operator-only; a repo can ask for `block-candidate`" : `must be one of ${sevs.join("|")}` });
  }
  if (typeof raw.message !== "string" || raw.message.trim() === "" || raw.message.length > 500) errors.push({ file, field: `${at}.message`, message: "must be a string of 1-500 characters" });
  if (raw.evidence !== undefined && (typeof raw.evidence !== "string" || raw.evidence.length > 500)) errors.push({ file, field: `${at}.evidence`, message: "must be a string of at most 500 characters" });
  const match: Rule["match"] = {};
  if (!isObj(raw.match)) errors.push({ file, field: `${at}.match`, message: "is required: {paths?: [...], keywords?: [...]}" });
  else {
    unknownKeys(raw.match, ["paths", "keywords"], file, `${at}.match`, errors);
    if (raw.match.paths !== undefined) {
      const sc = parseScope({ files: raw.match.paths });
      if (!sc.ok) errors.push({ file, field: `${at}.match.paths`, message: sc.error });
      else if (sc.scope) match.paths = sc.scope.files;
    }
    if (raw.match.keywords !== undefined) {
      const k = raw.match.keywords;
      if (!Array.isArray(k) || k.length === 0 || k.length > 20 || k.some((x) => typeof x !== "string" || x.trim() === "" || x.length > 80)) errors.push({ file, field: `${at}.match.keywords`, message: "must be 1-20 non-empty strings of at most 80 characters" });
      else match.keywords = k.map((x: string) => x.trim());
    }
    if (!match.paths && !match.keywords && errors.length === before) errors.push({ file, field: `${at}.match`, message: "needs paths or keywords" });
  }
  let requires: string[] | undefined;
  if (raw.requires !== undefined) {
    const r = raw.requires;
    if (!Array.isArray(r) || r.length > 10 || r.some((x) => typeof x !== "string" || x.trim() === "" || x.length > 200)) errors.push({ file, field: `${at}.requires`, message: "must be at most 10 non-empty strings of at most 200 characters" });
    else requires = r.map((x: string) => x.trim());
  }
  if (errors.length > before) return undefined;
  return {
    id: raw.id as string,
    severity: raw.severity as RuleSeverity,
    message: (raw.message as string).trim(),
    ...(typeof raw.evidence === "string" ? { evidence: raw.evidence } : {}),
    match,
    ...(requires ? { requires } : {}),
  };
}

/** Serialized shared lines (issue #260 item 3): the same repo-relative path/glob shapes a task scope allows. */
function parseSerialize(raw: unknown, file: string, errors: ProjectError[]): string[] | undefined {
  if (raw === undefined) return undefined;
  const sc = parseScope({ files: raw });
  if (!sc.ok) errors.push({ file, field: "serialize", message: sc.error });
  else if (sc.scope?.files.length) return sc.scope.files;
  return undefined;
}

export function parseRules(text: string, file = "rules.yml", allowBlock = false): { rules: Rule[]; serialize?: string[]; errors: ProjectError[] } {
  const errors: ProjectError[] = [];
  const y = parseYaml(text, file);
  if (!y.ok) return { rules: [], errors: [y.error] };
  if (!isObj(y.value)) return { rules: [], errors: [{ file, message: "must be a mapping with schemaVersion and rules" }] };
  unknownKeys(y.value, ["schemaVersion", "rules", "serialize"], file, "", errors);
  if (y.value.schemaVersion !== PROJECT_SCHEMA_VERSION) errors.push({ file, field: "schemaVersion", message: `must be ${PROJECT_SCHEMA_VERSION}` });
  const serialize = parseSerialize(y.value.serialize, file, errors);
  const list = y.value.rules;
  if (!Array.isArray(list)) return { rules: [], errors: [...errors, { file, field: "rules", message: "must be a list" }] };
  if (list.length > MAX_RULES) return { rules: [], errors: [...errors, { file, field: "rules", message: `more than ${MAX_RULES} rules` }] };
  const rules: Rule[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const r = parseRule(raw, file, `rules[${i}]`, allowBlock, errors);
    if (!r) return;
    if (seen.has(r.id)) errors.push({ file, field: `rules[${i}].id`, message: `duplicate rule id "${r.id}"` });
    seen.add(r.id);
    rules.push(r);
  });
  return { rules: errors.length ? [] : rules, serialize: errors.length ? undefined : serialize, errors };
}

// ---------------------------------------------------------------------------
// decisions/NNNN-slug.md
// ---------------------------------------------------------------------------

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;
export interface Decision {
  /** Four-digit number, equal to the file name's prefix. */
  id: string;
  slug: string;
  title: string;
  status: (typeof DECISION_STATUSES)[number];
  date: string;
  /** Paths the decision governs (used by the design gate to cite it). */
  scope?: string[];
  supersededBy?: string;
  context?: string;
  decision?: string;
  alternativesRejected?: string;
  consequences?: string;
}

const DECISION_FILE = /^(\d{4})-([a-z0-9][a-z0-9-]{0,62})\.md$/;
export const isDecisionFileName = (name: string): boolean => DECISION_FILE.test(name);

export function parseDecision(text: string, fileName: string): { decision?: Decision; errors: ProjectError[] } {
  const file = `decisions/${fileName}`;
  const errors: ProjectError[] = [];
  const nm = DECISION_FILE.exec(fileName);
  if (!nm) return { errors: [{ file, message: "file name must be NNNN-slug.md (four digits, lowercase slug)" }] };
  const fm = splitFrontmatter(text, file);
  if (!fm.ok) return { errors: [fm.error] };
  if (!isObj(fm.front)) return { errors: [{ file, message: "frontmatter must be a mapping" }] };
  const f = fm.front;
  unknownKeys(f, ["schemaVersion", "id", "title", "status", "date", "scope", "supersededBy"], file, "", errors);
  if (f.schemaVersion !== PROJECT_SCHEMA_VERSION) errors.push({ file, field: "schemaVersion", message: `must be ${PROJECT_SCHEMA_VERSION}` });
  const id = typeof f.id === "number" ? String(f.id).padStart(4, "0") : f.id;
  if (id !== nm[1]) errors.push({ file, field: "id", message: `must equal the file name's number ${nm[1]}` });
  if (typeof f.title !== "string" || f.title.trim() === "" || f.title.length > 200) errors.push({ file, field: "title", message: "must be a string of 1-200 characters" });
  if (typeof f.status !== "string" || !(DECISION_STATUSES as readonly string[]).includes(f.status)) errors.push({ file, field: "status", message: `must be one of ${DECISION_STATUSES.join("|")}` });
  // YAML's core schema keeps 2026-10-04 as a string; a quoted or unquoted ISO date are both fine.
  const date = typeof f.date === "string" ? f.date : f.date instanceof Date ? f.date.toISOString().slice(0, 10) : undefined;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push({ file, field: "date", message: "must be an ISO date YYYY-MM-DD" });
  let scope: string[] | undefined;
  if (f.scope !== undefined) {
    const sc = parseScope({ files: f.scope });
    if (!sc.ok) errors.push({ file, field: "scope", message: sc.error });
    else scope = sc.scope?.files;
  }
  if (f.supersededBy !== undefined && (typeof f.supersededBy !== "string" || !/^\d{4}$/.test(f.supersededBy))) errors.push({ file, field: "supersededBy", message: "must be a four-digit decision number (quote it in YAML)" });
  const sec = sections(fm.body);
  for (const h of sec.keys()) if (!["context", "decision", "alternatives rejected", "consequences"].includes(h)) errors.push({ file, field: h, message: `unknown section "## ${h}"` });
  for (const [h, v] of sec) if (v.length > MAX_TEXT) errors.push({ file, field: h, message: `section is longer than ${MAX_TEXT} characters` });
  if (errors.length) return { errors };
  const d: Decision = {
    id: nm[1], slug: nm[2], title: (f.title as string).trim(), status: f.status as Decision["status"], date: date as string,
    ...(scope ? { scope } : {}),
    ...(typeof f.supersededBy === "string" ? { supersededBy: f.supersededBy } : {}),
    ...(sec.get("context") ? { context: sec.get("context") } : {}),
    ...(sec.get("decision") ? { decision: sec.get("decision") } : {}),
    ...(sec.get("alternatives rejected") ? { alternativesRejected: sec.get("alternatives rejected") } : {}),
    ...(sec.get("consequences") ? { consequences: sec.get("consequences") } : {}),
  };
  return { decision: d, errors };
}

// ---------------------------------------------------------------------------
// Layering: built-in < operator < repo. A repo can add, never weaken.
// ---------------------------------------------------------------------------

export interface EffectiveRule extends Rule {
  source: "builtin" | "operator" | "repo";
  /** What actually happens: `block` only for an operator `block`, or a repo `block-candidate` when the operator allows repo blocking. */
  enforced: "advise" | "block";
}

export interface MergeInput {
  builtin?: Rule[];
  operator?: Rule[];
  repo?: Rule[];
  /** Operator switch: let a repo's `block-candidate` rules actually block (default false). */
  allowRepoBlocking?: boolean;
}

export function mergeRules(input: MergeInput): { rules: EffectiveRule[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, EffectiveRule>();
  const enforcedOf = (r: Rule, source: EffectiveRule["source"]): EffectiveRule["enforced"] =>
    r.severity === "block" ? "block" : r.severity === "block-candidate" && (source !== "repo" || input.allowRepoBlocking === true) ? "block" : "advise";
  for (const r of input.builtin ?? []) byId.set(r.id, { ...r, source: "builtin", enforced: enforcedOf(r, "builtin") });
  for (const r of input.operator ?? []) {
    const prior = byId.get(r.id);
    if (prior && SEVERITY_ORDER[prior.severity] > SEVERITY_ORDER[r.severity]) warnings.push(`operator rule "${r.id}" is weaker than the built-in one; kept the built-in severity ${prior.severity}`);
    const severity = prior && SEVERITY_ORDER[prior.severity] > SEVERITY_ORDER[r.severity] ? prior.severity : r.severity;
    byId.set(r.id, { ...r, severity, source: "operator", enforced: enforcedOf({ ...r, severity }, "operator") });
  }
  for (const r of input.repo ?? []) {
    const prior = byId.get(r.id);
    if (!prior) { byId.set(r.id, { ...r, source: "repo", enforced: enforcedOf(r, "repo") }); continue; }
    // A repo cannot redefine a rule it did not author: it may only tighten severity, never past block-candidate.
    const stricter = SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[prior.severity];
    if (r.severity !== prior.severity && !stricter) warnings.push(`repo rule "${r.id}" tries to lower the ${prior.source} severity ${prior.severity} to ${r.severity}; ignored`);
    if (r.message !== prior.message || JSON.stringify(r.match) !== JSON.stringify(prior.match) || JSON.stringify(r.requires ?? null) !== JSON.stringify(prior.requires ?? null)) {
      warnings.push(`repo rule "${r.id}" redefines a ${prior.source} rule's message/match/requires; ignored (only severity can be tightened)`);
    }
    if (stricter) {
      // prior < repo <= block-candidate, so prior was advise: the tightened rule only blocks if the operator allows repo blocking.
      byId.set(r.id, { ...prior, severity: r.severity, enforced: input.allowRepoBlocking === true ? "block" : "advise" });
    }
  }
  return { rules: [...byId.values()], warnings };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface ProjectInput {
  charterText?: string;
  rulesText?: string;
  decisionFiles?: Array<{ name: string; text: string }>;
  /** Operator-side layering inputs (plugin config `project.*`). */
  operator?: { rules?: unknown; requireCharterFields?: string[]; allowRepoBlocking?: boolean };
  builtinRules?: Rule[];
}

export interface ProjectRecord {
  schemaVersion: number;
  charter?: Charter;
  rules: EffectiveRule[];
  /** Repo-registered shared lines (issue #260 item 3): paths two live runs must not edit concurrently. Absent: none registered. */
  serialize?: string[];
  decisions: Decision[];
  errors: ProjectError[];
  warnings: string[];
}

export function buildProjectRecord(input: ProjectInput): ProjectRecord {
  const errors: ProjectError[] = [];
  const warnings: string[] = [];
  let charter: Charter | undefined;
  if (input.charterText !== undefined) {
    const c = parseCharter(input.charterText);
    errors.push(...c.errors);
    charter = c.charter;
  }
  // Operator rules come from trusted config but are validated by the same parser; `block` is allowed here only.
  let operatorRules: Rule[] = [];
  if (input.operator?.rules !== undefined) {
    const opErrors: ProjectError[] = [];
    if (!Array.isArray(input.operator.rules)) opErrors.push({ file: "operator config", field: "project.rules", message: "must be a list" });
    else input.operator.rules.forEach((raw, i) => { const r = parseRule(raw, "operator config", `project.rules[${i}]`, true, opErrors); if (r) operatorRules.push(r); });
    if (opErrors.length) { errors.push(...opErrors); operatorRules = []; }
  }
  let repoRules: Rule[] = [];
  let serialize: string[] | undefined;
  if (input.rulesText !== undefined) {
    const r = parseRules(input.rulesText, "rules.yml", false);
    errors.push(...r.errors);
    repoRules = r.rules;
    serialize = r.serialize;
  }
  const merged = mergeRules({ builtin: input.builtinRules, operator: operatorRules, repo: repoRules, allowRepoBlocking: input.operator?.allowRepoBlocking === true });
  warnings.push(...merged.warnings);
  const decisions: Decision[] = [];
  const files = input.decisionFiles ?? [];
  if (files.length > MAX_DECISIONS) errors.push({ file: "decisions/", message: `more than ${MAX_DECISIONS} decisions` });
  else {
    for (const f of files) {
      const d = parseDecision(f.text, f.name);
      errors.push(...d.errors);
      if (d.decision) decisions.push(d.decision);
    }
    decisions.sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 1; i < decisions.length; i++) if (decisions[i].id === decisions[i - 1].id) errors.push({ file: `decisions/${decisions[i].id}-${decisions[i].slug}.md`, field: "id", message: `duplicate decision number ${decisions[i].id}` });
    const ids = new Set(decisions.map((d) => d.id));
    for (const d of decisions) if (d.supersededBy && !ids.has(d.supersededBy)) warnings.push(`decision ${d.id} is superseded by ${d.supersededBy}, which does not exist`);
  }
  // The operator can require charter fields; a repo cannot remove them.
  for (const req of input.operator?.requireCharterFields ?? []) {
    if (!(CHARTER_FIELDS as readonly string[]).includes(req)) { errors.push({ file: "operator config", field: "project.requireCharterFields", message: `unknown charter field "${req}"` }); continue; }
    const have = charter ? (charter as unknown as Record<string, unknown>)[req] : undefined;
    if (have === undefined) errors.push({ file: "charter.md", field: req, message: `required by the operator but missing` });
  }
  return { schemaVersion: PROJECT_SCHEMA_VERSION, ...(charter ? { charter } : {}), rules: merged.rules, decisions, errors, warnings, ...(serialize ? { serialize } : {}) };
}
