/**
 * Keeping the `.fleet/` record alive (issue #120), proposal-only and deterministic: every output is a
 * draft or a report for a human to act on, with the evidence it was drawn from. Nothing here writes to
 * a repository, and nothing decides: a drift hit is a "possible drift", a draft is `proposed`.
 *
 *  - designSignals / draftDecision: from the facts of a merged PR (files, added lines), detect a design
 *    choice (protocol bump, new dependency, rule-listed surface, changed default) and draft the decision
 *    entry citing the PR. The draft is validated with the same parser the record uses.
 *  - staleDecisions: decisions whose declared scope no longer matches any tracked file.
 *  - charterDrift: charter constraints/non-goals against what merged, by explicit signals only.
 *  - checklistGaps: unchecked items of an issue body, to compare against the default branch.
 *
 * PR text, diffs and file names are untrusted data; they are quoted into drafts as evidence, never
 * followed, and bounded.
 */

import YAML from "yaml";
import { parseDecision, PROJECT_SCHEMA_VERSION, type Charter, type Decision, type Rule } from "./project.js";
import { scopeViolations } from "./scope.js";

export interface PrFacts {
  number: number;
  title: string;
  body?: string;
  /** Changed file paths. */
  files: string[];
  /** Added diff lines (without the leading "+"), per file when known. */
  added?: Array<{ file: string; line: string }>;
  mergedAt?: string;
}

export interface DesignSignal { kind: "protocol-bump" | "new-dependency" | "rule-surface" | "changed-default"; evidence: string }

const clip = (s: string, n: number): string => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, n);

/** Design choices a PR carries, each with the file/line that shows it. */
export function designSignals(pr: PrFacts, rules: Rule[] = []): DesignSignal[] {
  const out: DesignSignal[] = [];
  const added = pr.added ?? [];
  for (const a of added) {
    if (/\bPROTOCOL_VERSION\s*=\s*\d+/.test(a.line)) out.push({ kind: "protocol-bump", evidence: `${a.file}: ${clip(a.line, 120)}` });
  }
  let inDeps = false;
  for (const a of added.filter((x) => x.file.endsWith("package.json"))) {
    if (/"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/.test(a.line)) { inDeps = true; continue; }
    if (inDeps && /^\s*"[^"]+"\s*:\s*"[^"]+"\s*,?\s*$/.test(a.line)) out.push({ kind: "new-dependency", evidence: `${a.file}: ${clip(a.line, 120)}` });
    if (/^\s*}/.test(a.line)) inDeps = false;
  }
  for (const a of added) {
    if (/\bdefault\s*[:=]|\bDEFAULT_[A-Z_]+\s*=/.test(a.line) && !a.file.endsWith(".test.ts")) out.push({ kind: "changed-default", evidence: `${a.file}: ${clip(a.line, 120)}` });
  }
  for (const r of rules) {
    const paths = r.match.paths;
    if (!paths?.length) continue;
    const hit = pr.files.filter((f) => scopeViolations([f], { files: paths }).length === 0);
    if (hit.length) out.push({ kind: "rule-surface", evidence: `rule ${r.id} lists ${hit.slice(0, 3).join(", ")}` });
  }
  return out.slice(0, 20);
}

const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "decision";

export type Draft = { ok: true; name: string; text: string; signals: DesignSignal[] } | { ok: false; reason: string };

/** A `proposed` decision draft citing the PR, or `ok:false` when the PR carries no design choice. For human review only. */
export function draftDecision(pr: PrFacts, nextNumber: number, rules: Rule[] = [], date = new Date().toISOString().slice(0, 10)): Draft {
  const signals = designSignals(pr, rules);
  if (signals.length === 0) return { ok: false, reason: "no design choice detected (no protocol bump, new dependency, changed default or rule-listed surface)" };
  const id = String(nextNumber).padStart(4, "0");
  const title = clip(pr.title, 150) || `PR ${pr.number}`;
  const name = `${id}-${slug(title)}.md`;
  const front = YAML.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, id, title, status: "proposed", date }).trim();
  const evidence = signals.map((s) => `- ${s.kind}: ${s.evidence}`).join("\n");
  const text = [
    `---\n${front}\n---`,
    "",
    "## Context",
    "",
    `Drafted from PR #${pr.number}${pr.mergedAt ? ` (merged ${clip(pr.mergedAt, 25)})` : ""}. This is a DRAFT for human review: the signals below were detected mechanically, and the reasoning is still to be written.`,
    "",
    "Evidence (untrusted repo text, quoted):",
    evidence,
    pr.body ? `\nPR description, first lines: ${clip(pr.body, 400)}` : "",
    "",
    "## Decision",
    "",
    "TODO: state what was decided and why, citing the PR discussion.",
    "",
    "## Alternatives rejected",
    "",
    "TODO: what else was considered.",
    "",
    "## Consequences",
    "",
    "TODO: what this commits the project to.",
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  const parsed = parseDecision(text, name);
  if (parsed.errors.length) return { ok: false, reason: `draft did not validate: ${parsed.errors.map((e) => e.message).join("; ")}` };
  return { ok: true, name, text, signals };
}

/** Decisions that declare a scope none of the tracked files match any more: candidates to supersede or retire. */
export function staleDecisions(decisions: Decision[], trackedFiles: string[]): Array<{ id: string; title: string; why: string }> {
  const out: Array<{ id: string; title: string; why: string }> = [];
  for (const d of decisions) {
    if (!d.scope?.length || d.status === "superseded" || d.status === "rejected") continue;
    const live = trackedFiles.some((f) => scopeViolations([f], { files: d.scope! }).length === 0);
    if (!live) out.push({ id: d.id, title: d.title, why: `none of its scope paths (${d.scope.slice(0, 3).join(", ")}) match a tracked file` });
  }
  return out;
}

export interface Drift { field: "constraints" | "nonGoals"; statement: string; evidence: string; note: string }

const NO_NETWORK = /\b(no network|offline|air-?gapped|no external (calls|requests)|no outbound)\b/i;
const EGRESS = /\b(fetch\(|axios|http\.request|https\.request|XMLHttpRequest|node-fetch|curl\s|wget\s)|https?:\/\/(?!localhost|127\.0\.0\.1)/;

/** Possible drift between the charter and what merged, from explicit signals only. A report, never an edit. */
export function charterDrift(charter: Charter, prs: PrFacts[]): Drift[] {
  const out: Drift[] = [];
  for (const c of charter.constraints ?? []) {
    if (!NO_NETWORK.test(c)) continue;
    for (const pr of prs) {
      const hit = (pr.added ?? []).find((a) => !a.file.endsWith(".test.ts") && !/\.md$/.test(a.file) && EGRESS.test(a.line));
      if (hit) out.push({ field: "constraints", statement: clip(c, 120), evidence: `PR #${pr.number} adds network access: ${hit.file}: ${clip(hit.line, 100)}`, note: "possible drift: confirm whether the constraint still holds or should change" });
    }
  }
  for (const ng of charter.nonGoals ?? []) {
    const words = (ng.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !["without", "never", "should", "support", "build", "that", "this", "with", "from", "will", "does", "have"].includes(w));
    for (const pr of prs) {
      const t = pr.title.toLowerCase();
      const hit = words.filter((w) => t.includes(w));
      if (hit.length >= 2) out.push({ field: "nonGoals", statement: clip(ng, 120), evidence: `PR #${pr.number} "${clip(pr.title, 80)}" mentions ${hit.slice(0, 3).join(", ")}`, note: "possible drift: a stated non-goal appears in merged work" });
    }
  }
  return out;
}

/** Unchecked checklist items in an issue body, to be compared with the default branch ("closed with remaining work"). */
export function checklistGaps(body: string): string[] {
  return (body.match(/^\s*[-*]\s+\[ \]\s+.+$/gm) ?? []).map((l) => clip(l.replace(/^\s*[-*]\s+\[ \]\s+/, ""), 160));
}
