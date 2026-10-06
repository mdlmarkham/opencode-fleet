/**
 * Deterministic core of `fleet_project_start` (issue #116): a typed intake the caller cannot skip, a
 * readiness verdict that lists exactly what is missing, a charter and first-decision writer that never
 * clobbers an existing `.fleet/`, and validation of a proposed backlog. The model roles that PRODUCE a
 * design or a backlog (#110) are not here: this module checks what the caller hands back.
 *
 * Everything produced is a PROPOSAL for the caller to confirm; nothing is dispatched.
 */

import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { parseCharter, parseDecision, PROJECT_SCHEMA_VERSION, type CharterField } from "./project.js";
import { parseTaskSpec, type TaskSpec } from "./spec.js";
import { scopeOverlap } from "./scope.js";

export interface Criterion { criterion: string; check: string }
export interface IntakeAnswers {
  name?: string;
  goal?: string;
  users?: string[];
  constraints?: string[];
  nonGoals?: string[];
  successCriteria?: Criterion[];
  riskiestAssumptions?: string[];
  /** Items the caller marked unknown/defer: recorded as risks, never silently accepted. */
  deferred?: CharterField[];
}

export type Verdict = "ready" | "needs-more" | "risky-but-proceed";
export interface Assessment { verdict: Verdict; missing: Array<{ field: string; ask: string }>; risks: string[] }

const QUESTIONS: Record<string, string> = {
  goal: "State the goal in one or two concrete sentences: what will exist that does not exist now, and for whom?",
  users: "Who are the intended users or consumers? Name at least one.",
  constraints: "What constraints apply (tech stack, time, compliance, budget)? Say 'none known' only by deferring this item.",
  nonGoals: "What is explicitly NOT in scope? A goal with no non-goals invites unbounded work.",
  successCriteria: "Success criteria must be checkable: for each, what command or observation shows it works?",
  riskiestAssumptions: "What are the riskiest assumptions, the things that, if wrong, sink the project?",
};
/** Fields whose absence may be deferred (recorded as a risk). Success criteria and goal may not. */
const DEFERRABLE: readonly CharterField[] = ["users", "constraints", "nonGoals", "riskiestAssumptions"];

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
const vague = (s: string): boolean => s.trim().split(/\s+/).length < 4 || /^(tbd|todo|n\/a|none|unknown)\b/i.test(s.trim());

/** Normalise untrusted caller input into typed answers (wrong types are dropped, then reported as missing). */
export function normalizeAnswers(raw: unknown): IntakeAnswers {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const crit = Array.isArray(r.successCriteria) ? r.successCriteria.flatMap((c) => { const o = c as Partial<Criterion>; return typeof o?.criterion === "string" && typeof o?.check === "string" ? [{ criterion: o.criterion.trim(), check: o.check.trim() }] : []; }) : [];
  const deferred = strs(r.deferred).filter((d): d is CharterField => (DEFERRABLE as readonly string[]).includes(d));
  return {
    ...(typeof r.name === "string" && r.name.trim() ? { name: r.name.trim().slice(0, 100) } : {}),
    ...(typeof r.goal === "string" && r.goal.trim() ? { goal: r.goal.trim() } : {}),
    users: strs(r.users), constraints: strs(r.constraints), nonGoals: strs(r.nonGoals), riskiestAssumptions: strs(r.riskiestAssumptions),
    successCriteria: crit, deferred,
  };
}

/** Merge a new round of answers over the saved ones (a field given again replaces the old value). */
export function mergeAnswers(prev: IntakeAnswers, next: IntakeAnswers, given: Set<string>): IntakeAnswers {
  const out = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) if (given.has(k)) out[k] = v;
  return out as IntakeAnswers;
}

export function assess(a: IntakeAnswers): Assessment {
  const missing: Assessment["missing"] = [];
  const risks: string[] = [];
  const deferred = new Set<string>(a.deferred ?? []);
  const need = (field: string, why?: string): void => { missing.push({ field, ask: why ? `${why} ${QUESTIONS[field]}` : QUESTIONS[field]! }); };
  if (!a.goal) need("goal"); else if (vague(a.goal)) need("goal", "That goal is too vague to build against.");
  if (!a.successCriteria?.length) need("successCriteria");
  else for (const c of a.successCriteria) if (vague(c.criterion) || c.check.trim().length < 3) { need("successCriteria", `"${c.criterion.slice(0, 60)}" has no checkable verification.`); break; }
  for (const f of DEFERRABLE) {
    const items = (a[f as "users"] as string[] | undefined) ?? [];
    if (items.length > 0) continue;
    if (deferred.has(f)) risks.push(`${f} deferred: recorded as a risk, not accepted`);
    else need(f);
  }
  if (missing.length) return { verdict: "needs-more", missing, risks };
  return { verdict: risks.length ? "risky-but-proceed" : "ready", missing, risks };
}

/** The charter text, parseable by the P-0 parser. Deferred items become explicit risks. */
export function renderCharter(a: IntakeAnswers): string {
  const front = YAML.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, ...(a.name ? { name: a.name } : {}) }).trim();
  const list = (xs: string[] | undefined): string => (xs ?? []).map((x) => `- ${x.replace(/\r?\n/g, " ")}`).join("\n");
  const risks = [...(a.riskiestAssumptions ?? []), ...(a.deferred ?? []).filter((f) => !((a[f as "users"] as string[] | undefined)?.length)).map((f) => `UNKNOWN (deferred at intake): ${f}`)];
  const crit = (a.successCriteria ?? []).map((c) => `${c.criterion.replace(/\r?\n/g, " ")} (check: ${c.check.replace(/\r?\n/g, " ")})`);
  return [`---\n${front}\n---`, "", "## Goal", "", a.goal ?? "", "", "## Users", "", list(a.users), "", "## Constraints", "", list(a.constraints), "", "## Non-goals", "", list(a.nonGoals), "", "## Success criteria", "", list(crit), "", "## Riskiest assumptions", "", list(risks), ""].join("\n");
}

export interface DecisionInput { title: string; context?: string; decision: string; alternativesRejected?: string; consequences?: string; scope?: string[]; status?: "proposed" | "accepted" }

const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "decision";

/** A decision file name and text, validated by the P-0 parser before it is returned. */
export function renderDecision(n: number, d: DecisionInput, date: string): { name: string; text: string } | { error: string } {
  const id = String(n).padStart(4, "0");
  const name = `${id}-${slug(d.title)}.md`;
  const front = YAML.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, id, title: d.title, status: d.status ?? "proposed", date, ...(d.scope?.length ? { scope: d.scope } : {}) }).trim();
  const sec = (h: string, v?: string): string => (v?.trim() ? `\n## ${h}\n\n${v.trim()}\n` : "");
  const text = `---\n${front}\n---\n${sec("Context", d.context)}${sec("Decision", d.decision)}${sec("Alternatives rejected", d.alternativesRejected)}${sec("Consequences", d.consequences)}`;
  const parsed = parseDecision(text, name);
  return parsed.errors.length ? { error: parsed.errors.map((e) => `${e.field ?? ""} ${e.message}`.trim()).join("; ") } : { name, text };
}

export type WriteResult = { ok: true; written: string[] } | { ok: false; error: string };

/**
 * Write `.fleet/charter.md` and decision files into `repoDir`. Refuses when a `.fleet/charter.md`,
 * `.fleet` symlink, or any of the target decision numbers already exists: it never overwrites.
 */
export async function writeProject(repoDir: string, charterText: string, decisions: Array<{ name: string; text: string }>): Promise<WriteResult> {
  const c = parseCharter(charterText);
  if (c.errors.length) return { ok: false, error: `charter does not validate: ${c.errors.map((e) => e.message).join("; ")}` };
  const fleet = join(repoDir, ".fleet");
  let exists = false;
  try { const st = await lstat(fleet); if (st.isSymbolicLink()) return { ok: false, error: ".fleet is a symlink; refusing" }; exists = true; } catch { /* not there */ }
  if (exists) {
    try { await lstat(join(fleet, "charter.md")); return { ok: false, error: ".fleet/charter.md already exists; refusing to overwrite (edit it directly)" }; } catch { /* absent: fine */ }
    const have = new Set((await readdir(join(fleet, "decisions")).catch(() => [])).map((n) => n.slice(0, 4)));
    for (const d of decisions) if (have.has(d.name.slice(0, 4))) return { ok: false, error: `decision number ${d.name.slice(0, 4)} already exists; refusing to overwrite` };
  }
  await mkdir(join(fleet, "decisions"), { recursive: true });
  await writeFile(join(fleet, "charter.md"), charterText, { flag: "wx" });
  const written = [".fleet/charter.md"];
  for (const d of decisions) { await writeFile(join(fleet, "decisions", d.name), d.text, { flag: "wx" }); written.push(`.fleet/decisions/${d.name}`); }
  return { ok: true, written };
}

export interface BacklogCheck { ok: boolean; specs: Array<{ index: number; ok: boolean; errors: string[] }>; overlaps: Array<[number, number]>; errors: string[] }

/** A proposed backlog is offered only if every spec parses, has acceptance, verify and scope, and scopes are pairwise disjoint. */
export function validateBacklog(raw: unknown): BacklogCheck {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return { ok: false, specs: [], overlaps: [], errors: ["backlog must be an array of 1-50 specs"] };
  const parsed: Array<TaskSpec | undefined> = [];
  const specs = raw.map((s, index) => {
    const errors: string[] = [];
    const p = parseTaskSpec(s);
    if (!p.ok) errors.push(p.error);
    else if (!p.spec) errors.push("empty spec");
    else {
      if (!p.spec.acceptance?.length) errors.push("no acceptance criteria");
      const v = p.spec.verify;
      if (!v || !(v.command || v.commands?.length || v.files?.length)) errors.push("no verify gate");
      if (!p.spec.scope?.files.length) errors.push("no scope (needed to prove specs do not overlap)");
    }
    parsed[index] = p.ok ? p.spec : undefined;
    return { index, ok: errors.length === 0, errors };
  });
  const overlaps: Array<[number, number]> = [];
  for (let i = 0; i < parsed.length; i++) for (let j = i + 1; j < parsed.length; j++) {
    const a = parsed[i]?.scope, b = parsed[j]?.scope;
    if (a && b && scopeOverlap(a, b)) overlaps.push([i, j]);
  }
  const errors = overlaps.map(([i, j]) => `specs ${i} and ${j} have overlapping scope: run them serially or split the scope`);
  return { ok: specs.every((s) => s.ok) && overlaps.length === 0, specs, overlaps, errors };
}
