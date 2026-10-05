/**
 * Issue #116 (P-0): `fleet_project_start` INTAKE — a pure, stateful question/answer loop that
 * pushes back until the charter it can render is complete and checkable, then writes the
 * charter.md text that `parseCharter` (src/project.ts) round-trips. Nothing here reads the disk,
 * touches the network, or calls a model: typed answers in, questions and a verdict out.
 *
 * Push-back holds — while any of these fail (and is not explicitly deferred) there is no charter:
 * a goal, at least one user, at least one non-goal, and at least one *checkable* success
 * criterion (one that names a command or an observation). A gap the user explicitly `deferred`
 * never blocks, but it never vanishes either: it becomes a recorded risk, so the verdict is
 * `risky-but-proceed`, never a silent accept. A goal with no way to measure success is never
 * `ready`.
 */

import { MAX_LIST_ITEMS, MAX_TEXT, PROJECT_SCHEMA_VERSION } from "./project.js";

/** The typed question set, in the order questions are asked. */
export const INTAKE_FIELDS = ["goal", "users", "constraints", "nonGoals", "successCriteria", "riskiestAssumptions"] as const;
export type IntakeField = (typeof INTAKE_FIELDS)[number];

const STRING_FIELDS: ReadonlySet<IntakeField> = new Set(["goal"]);
/** The push-back holds: these must hold (or be explicitly deferred) before there is a charter. */
const MANDATORY: ReadonlySet<IntakeField> = new Set(["goal", "users", "nonGoals", "successCriteria"]);

export type IntakeAnswers = {
  goal?: string;
  users?: string[];
  constraints?: string[];
  nonGoals?: string[];
  successCriteria?: string[];
  riskiestAssumptions?: string[];
};

/** A field the user explicitly deferred, with the deferral note that becomes a risk. */
export type IntakeDeferrals = Partial<Record<IntakeField, string>>;

export interface IntakeState {
  projectId: string;
  schemaVersion: number;
  name?: string;
  answers: IntakeAnswers;
  /** Fields explicitly deferred; the note is carried verbatim into the verdict's risks. */
  deferred?: IntakeDeferrals;
}

export type IntakeVerdictKind = "ready" | "needs-more" | "risky-but-proceed";

export interface IntakeVerdict {
  verdict: IntakeVerdictKind;
  /** What is still missing or insufficient, in question order (deferred gaps stay listed). */
  missing: IntakeField[];
  /** Human-readable risks for the explicitly deferred gaps; empty for ready and needs-more. */
  risks: string[];
}

export interface IntakeStep {
  state: IntakeState;
  /** The NEXT round of questions: only still-missing or insufficient fields, not re-asking deferred ones. */
  questions: IntakeField[];
  /** Fields answered this round whose answer was still insufficient (empty or uncheckable). */
  insufficient: IntakeField[];
  verdict: IntakeVerdictKind;
}

const DEFERRED_ITEM = /^deferred:\s*(.+)$/i;
const MAX_ITEM = 500;
// Renders as bullet lines; parseCharter refuses any section over MAX_TEXT, so stay well under it.
const LIST_CHAR_BUDGET = 3200;

const FIELD_PROMPTS: Record<IntakeField, string> = {
  goal: "What is this project trying to accomplish? (one sentence)",
  users: "Who will use this? (one per answer)",
  constraints: "What constraints must the work respect? (one per answer, or `deferred: why`)",
  nonGoals: "What is explicitly out of scope? (one per answer)",
  successCriteria: "How will we know it worked? Name a command to run or an observation to make. (one per answer)",
  riskiestAssumptions: "Which assumptions, if wrong, sink the plan? (one per answer)",
};

/**
 * A criterion is checkable iff it names a concrete command to run OR an explicit,
 * observable form ("observe: <what, where>"). Issue #116 review (defect 4): the
 * old heuristic accepted any bare verb ("we will check that it is good", "users
 * will see value"), which let an unmeasurable goal reach `ready`. Now a bare verb
 * is NOT enough — there must be a command, an exit/HTTP condition, or a named
 * observation artefact (a log/file/field that shows a value).
 */
function checkable(criterion: string): boolean {
  const c = criterion.toLowerCase();
  // A concrete command + an objective outcome, or a status/exit condition.
  const command = /\b(npm (run|test|install)|npx\b|yarn\b|pnpm\b|make\b|cargo (build|test)|go test|pytest|vitest|tsc\b|node \S|grep\b|curl\b|git (diff|log|status|show)|ls \S|wc -l|exit code|exits? (0|nonzero|successfully)|return code|status code|http [1-5]\d\d)\b/;
  // An EXPLICIT observation form: `observe:`/`observed:` followed by a value, or a named
  // artefact that shows a value (a log line with a value, a file/field containing X).
  const explicitObservation = /\bobserv(e|ed):\s*\S|\b(log|line|output|file|field|report|comment|badge|metric)\b[^.]*\b(shows?|contains?|reads?|reports?|=|:)\s*\S/;
  // A measurable quantity with a comparison (>=10ms, count of N > 0, at most N).
  const measurable = /\b(>=|<=|>|<|=)\s*\d|\b(count of|number of|at (least|most)|fewer than|greater than)\b[^.]*\d/;
  return command.test(c) || explicitObservation.test(c) || measurable.test(c);
}

// ---------------------------------------------------------------------------
// PURE state: no module-level storage. The caller owns the state, serializes it
// if it wants durability, and hands it back to intakeStep each round. This is
// what makes the "durable caller serializes the state object and merges it back
// with intakeStep" guarantee actually true (issue #116 review).

/** Start an empty intake state for a project (pure; nothing is stored). */
export function buildIntakeState(projectId: string, answers: IntakeAnswers = {}): IntakeState {
  return intakeStep({ projectId, state: { projectId, schemaVersion: PROJECT_SCHEMA_VERSION, answers: {} } }, answers).state;
}

/** Charters are single-line texts; a multi-line answer would parse as extra bullets, so flatten it. */
const singleLine = (s: unknown): string => (typeof s === "string" ? s.replace(/\s*\r?\n\s*/g, " ").trim() : "");

const plainYamlScalar = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(s) ? s : JSON.stringify(s));

/**
 * Merge one round of typed answers into the state for `projectId` (creating it if needed) and
 * return the next round of questions: only still-missing or insufficient fields. Items marked
 * `deferred: ...` are recorded as deferrals, never as answers and never silently accepted.
 */
export function intakeStep(input: { projectId: string; name?: string; state?: IntakeState }, answers: IntakeAnswers): IntakeStep {
  const state: IntakeState = input.state ?? { projectId: input.projectId, schemaVersion: PROJECT_SCHEMA_VERSION, answers: {} };
  const name = input.name === undefined ? undefined : singleLine(input.name);
  if (name !== undefined && name !== "" && name.length <= 100) state.name = name;
  const deferred: IntakeDeferrals = { ...(state.deferred ?? {}) };
  const note = (field: IntakeField, why: string): void => {
    deferred[field] = deferred[field] ? `${deferred[field]}; ${why}` : why;
  };
  const insufficient: IntakeField[] = [];
  const answered: IntakeField[] = [];
  for (const field of INTAKE_FIELDS) {
    const raw = (answers as Record<string, unknown>)[field];
    if (raw === undefined) continue;
    answered.push(field);
    if (STRING_FIELDS.has(field)) {
      const s = singleLine(raw);
      const d = DEFERRED_ITEM.exec(s);
      if (d) note(field, d[1]);
      else if (s === "") insufficient.push(field);
      else if (/^##/.test(s) || s.length > MAX_TEXT) note(field, "the goal must be one plain sentence under " + MAX_TEXT + " characters; restate it shorter");
      else (state.answers as Record<string, unknown>)[field] = s;
      continue;
    }
    if (!Array.isArray(raw)) { insufficient.push(field); continue; }
    const real: string[] = [];
    for (const item of raw) {
      const s = singleLine(item);
      if (s === "") continue;
      const d = DEFERRED_ITEM.exec(s);
      if (d) { note(field, d[1]); continue; }
      if (s.length > MAX_ITEM) { note(field, `answer too long for the charter (${s.length} chars, limit ${MAX_ITEM}): ${s.slice(0, 80)}`); continue; }
      real.push(s);
    }
    const existing = ((state.answers as Record<string, unknown>)[field] as string[] | undefined) ?? [];
    const bounded: string[] = [];
    let used = 0;
    let overflow = false;
    for (const item of [...existing, ...real]) {
      if (bounded.length >= MAX_LIST_ITEMS || used + item.length + 2 > LIST_CHAR_BUDGET) { overflow = true; break; }
      bounded.push(item);
      used += item.length + 2;
    }
    if (overflow) note(field, `kept out of the charter: more than ${MAX_LIST_ITEMS} items or ${LIST_CHAR_BUDGET} characters for this section`);
    (state.answers as Record<string, unknown>)[field] = bounded;
    if (bounded.length === 0) insufficient.push(field);
  }
  state.deferred = Object.keys(deferred).length > 0 ? deferred : undefined;
  const held = holds(state);
  // Issue #116 review (defect 1): a deferral is cleared the moment the field holds — an
  // answered field must not stay 'deferred'/risky.
  if (state.deferred) {
    const kept: IntakeDeferrals = {};
    for (const f of INTAKE_FIELDS) if (state.deferred[f] !== undefined && !held[f]) kept[f] = state.deferred[f];
    state.deferred = Object.keys(kept).length > 0 ? kept : undefined;
  }
  return {
    state,
    questions: INTAKE_FIELDS.filter((f) => !held[f] && state.deferred?.[f] === undefined),
    insufficient: answered.filter((f) => !held[f]),
    verdict: intakeVerdict(state).verdict,
  };
}

/** The holds: a field holds when its answer is present (and, for successCriteria, checkable). */
function holds(state: IntakeState): Record<IntakeField, boolean> {
  const a = state.answers;
  return {
    goal: (a.goal ?? "").trim() !== "",
    users: (a.users?.length ?? 0) > 0,
    constraints: (a.constraints?.length ?? 0) > 0,
    nonGoals: (a.nonGoals?.length ?? 0) > 0,
    successCriteria: (a.successCriteria?.length ?? 0) > 0 && a.successCriteria!.some(checkable),
    riskiestAssumptions: (a.riskiestAssumptions?.length ?? 0) > 0,
  };
}

/**
 * The verdict. `ready` only when nothing is missing. `needs-more` while any hold fails without an
 * explicit deferral (the missing list says exactly what is missing). `risky-but-proceed` only when
 * the remaining gaps are explicitly `deferred` — and each deferral appears as a risk, never
 * dropped. A goal with no way to measure success can be at best risky-but-proceed (via an explicit
 * deferral), never `ready`.
 */
export function intakeVerdict(state: IntakeState): IntakeVerdict {
  const held = holds(state);
  // A held field is never 'missing' even if a stale deferral lingers (defence in depth,
  // issue #116 review defect 1).
  const deferrals = Object.fromEntries(
    Object.entries(state.deferred ?? {}).filter(([f]) => !held[f as IntakeField]),
  ) as IntakeDeferrals;
  const missing = INTAKE_FIELDS.filter((f) => (MANDATORY.has(f) && !held[f]) || deferrals[f] !== undefined);
  const risks: string[] = [];
  for (const f of missing) if (deferrals[f] !== undefined) risks.push(`risk (${f}): deferred by the user — ${deferrals[f]}`);
  const unwaived = missing.filter((f) => deferrals[f] === undefined);
  if (unwaived.length > 0) return { verdict: "needs-more", missing, risks };
  if (missing.length === 0) return { verdict: "ready", missing: [], risks: [] };
  return { verdict: "risky-but-proceed", missing, risks };
}

/** The question text for a field (the typed question set's prompts). */
export function intakeQuestion(field: IntakeField): string {
  return FIELD_PROMPTS[field];
}

// ---------------------------------------------------------------------------
// Charter writer: pure text out, in the exact P-0 shape parseCharter accepts.
// ---------------------------------------------------------------------------

/**
 * Render the collected answers as a charter.md body the repo's P-0 format accepts: YAML
 * frontmatter with `schemaVersion` (and optional `name`), then `## Goal` prose and one `##`
 * section per list field. Sections are omitted when empty, so the round-trip
 * `parseCharter(renderCharter(state))` has zero errors and preserves every collected field.
 */
export function renderCharter(state: IntakeState): string {
  const a = state.answers;
  const lines: string[] = ["---", `schemaVersion: ${PROJECT_SCHEMA_VERSION}`];
  const name = (state.name ?? "").trim();
  if (name !== "") lines.push(`name: ${plainYamlScalar(name)}`);
  lines.push("---", "");
  const goal = (a.goal ?? "").trim();
  if (goal !== "") lines.push("## Goal", "", goal, "");
  const lists: Array<[string, string[] | undefined]> = [
    ["## Users", a.users],
    ["## Constraints", a.constraints],
    ["## Non-goals", a.nonGoals],
    ["## Success criteria", a.successCriteria],
    ["## Riskiest assumptions", a.riskiestAssumptions],
  ];
  for (const [heading, items] of lists) {
    if (items === undefined || items.length === 0) continue;
    lines.push(heading, "", ...items.map((item) => `- ${item}`), "");
  }
  return lines.join("\n");
}

export const INTAKE_VERSION = PROJECT_SCHEMA_VERSION;