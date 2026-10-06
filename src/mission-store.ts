/**
 * Durable mission record and journal (issue #123). Pure data and persistence, no model calls.
 *
 *  - The record (`record.json`) is the mission as typed, versioned data: phase, plan version and diffs,
 *    assumptions, open questions, risk register, budget, autonomy contract, and the supervisor's state
 *    (mission-supervisor.ts). The journal (`journal.jsonl`) is the append-only account of what happened
 *    and why, with run ids linking to the ledger and audit manifest.
 *  - Durability: atomic write (temp + rename), single writer per mission (an exclusive lock file with a
 *    stale timeout), an optimistic `rev` so a stale writer is refused, schema validation on every read
 *    (a corrupt record is REFUSED, never guessed), a bounded journal with rotation.
 *  - Privacy: ids, decisions and evidence pointers only; every string is redacted on the way out.
 *
 * Mirroring to `.fleet/missions/<id>/` lets a mission travel with the repo and survive a manager restart.
 */

import { appendFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "./untrusted.js";
import { MAX_SPECS, SUPERVISOR_SCHEMA_VERSION, newMission, type Limits, type MissionSpec, type MissionState } from "./mission-supervisor.js";

export const MISSION_SCHEMA_VERSION = 1;
export const PHASES = ["designing", "awaiting-approval", "executing", "blocked", "delivering", "done", "aborted"] as const;
export type Phase = (typeof PHASES)[number];

/** Allowed phase moves. `done` and `aborted` are final. */
const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  designing: ["awaiting-approval", "aborted"],
  "awaiting-approval": ["designing", "executing", "aborted"],
  executing: ["blocked", "delivering", "aborted"],
  blocked: ["executing", "aborted"],
  delivering: ["executing", "done", "aborted"],
  done: [],
  aborted: [],
};

export interface Assumption { id: string; text: string; madeBy: string; at: string; status: "open" | "confirmed" | "overturned" }
export interface Risk { id: string; text: string; severity: "low" | "medium" | "high" }
export interface PlanDiff { version: number; at: string; summary: string }

export interface MissionRecord {
  schemaVersion: number;
  missionId: string;
  /** Bumped on every save; a writer holding an older rev is refused. */
  rev: number;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  planVersion: number;
  planDiffs: PlanDiff[];
  charterRef?: string;
  designRef?: string;
  assumptions: Assumption[];
  openQuestions: string[];
  risks: Risk[];
  budget?: { maxCostUsd?: number; maxTokens?: number };
  /** Where the mission's specs run: the checkout on the nodes, and which nodes may take them. */
  target?: { cwd: string; nodes?: string[] };
  autonomy?: { level: "supervised" | "gated" | "unattended"; contract?: string };
  supervisor: MissionState;
}

const MAX_TEXT = 500;
const MAX_ITEMS = 200;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const clip = (v: unknown, n = MAX_TEXT): string => redactSecrets(String(v ?? "")).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type Loaded = { ok: true; record: MissionRecord } | { ok: false; error: string };

/** Validate a record read from disk: unknown or malformed data is refused, never repaired. */
export function validateRecord(raw: unknown): Loaded {
  if (!isRec(raw)) return { ok: false, error: "record is not an object" };
  if (raw.schemaVersion !== MISSION_SCHEMA_VERSION) return { ok: false, error: `unsupported mission schemaVersion ${String(raw.schemaVersion)}` };
  if (typeof raw.missionId !== "string" || !ID.test(raw.missionId)) return { ok: false, error: "bad missionId" };
  if (!Number.isInteger(raw.rev) || (raw.rev as number) < 1) return { ok: false, error: "bad rev" };
  if (!PHASES.includes(raw.phase as Phase)) return { ok: false, error: "bad phase" };
  if (!Number.isInteger(raw.planVersion) || (raw.planVersion as number) < 1) return { ok: false, error: "bad planVersion" };
  for (const k of ["createdAt", "updatedAt"]) if (typeof raw[k] !== "string" || Number.isNaN(Date.parse(raw[k] as string))) return { ok: false, error: `bad ${k}` };
  for (const k of ["assumptions", "openQuestions", "risks", "planDiffs"]) if (!Array.isArray(raw[k]) || (raw[k] as unknown[]).length > MAX_ITEMS) return { ok: false, error: `${k} must be an array of at most ${MAX_ITEMS}` };
  for (const a of raw.assumptions as unknown[]) if (!isRec(a) || typeof a.id !== "string" || typeof a.text !== "string" || !["open", "confirmed", "overturned"].includes(String(a.status))) return { ok: false, error: "bad assumption entry" };
  for (const q of raw.openQuestions as unknown[]) if (typeof q !== "string") return { ok: false, error: "bad open question" };
  for (const r of raw.risks as unknown[]) if (!isRec(r) || typeof r.id !== "string" || typeof r.text !== "string" || !["low", "medium", "high"].includes(String(r.severity))) return { ok: false, error: "bad risk entry" };
  if (raw.target !== undefined) {
    const t = raw.target;
    if (!isRec(t) || typeof t.cwd !== "string" || !t.cwd.startsWith("/") || t.cwd.length > 300 || (t.nodes !== undefined && (!Array.isArray(t.nodes) || t.nodes.length > 50 || t.nodes.some((n) => typeof n !== "string")))) return { ok: false, error: "bad target" };
  }
  const sup = raw.supervisor;
  if (!isRec(sup) || sup.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || sup.missionId !== raw.missionId || !isRec(sup.specs) || Object.keys(sup.specs).length > MAX_SPECS || !Array.isArray(sup.journal)) return { ok: false, error: "supervisor state is missing or inconsistent with the mission" };
  return { ok: true, record: raw as unknown as MissionRecord };
}

const dirOf = (root: string, id: string): string => join(root, ".opencode-fleet", "missions", id);
const now = (): string => new Date().toISOString();

// ---- single writer: an exclusive lock file ---------------------------------------------------------

const LOCK_STALE_MS = 60_000;
async function withLock<T>(dir: string, fn: () => Promise<T>, name = "record.lock"): Promise<T> {
  const lock = join(dir, name);
  for (let i = 0; i < 50; i++) {
    try {
      const h = await open(lock, "wx", 0o600);
      await h.close();
      try { return await fn(); } finally { await rm(lock, { force: true }); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true }); } catch { /* raced */ }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error("mission is locked by another writer");
}

export async function loadMission(root: string, id: string): Promise<Loaded> {
  if (!ID.test(id)) return { ok: false, error: "bad missionId" };
  let text: string;
  try { text = await readFile(join(dirOf(root, id), "record.json"), "utf8"); } catch { return { ok: false, error: `no mission ${id}` }; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: `mission ${id} is corrupt (not JSON): refusing to continue` }; }
  const v = validateRecord(raw);
  return v.ok ? v : { ok: false, error: `mission ${id} is corrupt (${v.error}): refusing to continue` };
}

async function writeAtomic(dir: string, rec: MissionRecord): Promise<void> {
  const tmp = join(dir, `record.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
  await rename(tmp, join(dir, "record.json"));
}

export type Saved = { ok: true; record: MissionRecord } | { ok: false; error: string };

/** Create a mission from specs; refuses to overwrite an existing one. */
export async function createMission(root: string, missionId: string, specs: MissionSpec[], opts: { limits?: Partial<Limits>; charterRef?: string; designRef?: string; budget?: MissionRecord["budget"]; target?: MissionRecord["target"]; autonomy?: MissionRecord["autonomy"] } = {}): Promise<Saved> {
  const m = newMission(missionId, specs, opts.limits);
  if (!m.ok) return { ok: false, error: m.errors.join("; ") };
  const dir = dirOf(root, missionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withLock(dir, async () => {
    try { await lstat(join(dir, "record.json")); return { ok: false as const, error: `mission ${missionId} already exists` }; } catch { /* free */ }
    const t = now();
    const rec: MissionRecord = { schemaVersion: MISSION_SCHEMA_VERSION, missionId, rev: 1, createdAt: t, updatedAt: t, phase: "designing", planVersion: 1, planDiffs: [], assumptions: [], openQuestions: [], risks: [], ...(opts.charterRef ? { charterRef: clip(opts.charterRef, 200) } : {}), ...(opts.designRef ? { designRef: clip(opts.designRef, 200) } : {}), ...(opts.budget ? { budget: opts.budget } : {}), ...(opts.autonomy ? { autonomy: opts.autonomy } : {}), ...(opts.target ? { target: opts.target } : {}), supervisor: m.state };
    await writeAtomic(dir, rec);
    await appendJournal(root, missionId, { type: "mission-created", why: `${specs.length} spec(s)`, evidence: specs.map((s) => s.id).join(",") });
    return { ok: true as const, record: rec };
  });
}

/** Read-modify-write under the lock; `expectedRev` (when given) refuses a stale writer. */
export async function updateMission(root: string, id: string, fn: (r: MissionRecord) => MissionRecord | { error: string }, expectedRev?: number): Promise<Saved> {
  const dir = dirOf(root, id);
  const cur0 = await loadMission(root, id);
  if (!cur0.ok) return cur0;
  return withLock(dir, async () => {
    const cur = await loadMission(root, id);
    if (!cur.ok) return cur;
    if (expectedRev !== undefined && cur.record.rev !== expectedRev) return { ok: false as const, error: `stale write: the mission is at rev ${cur.record.rev}, you held ${expectedRev}` };
    const next = fn(cur.record);
    if ("error" in next) return { ok: false as const, error: next.error };
    const out: MissionRecord = { ...next, missionId: id, rev: cur.record.rev + 1, updatedAt: now() };
    const v = validateRecord(out);
    if (!v.ok) return { ok: false as const, error: `refusing to write an invalid record: ${v.error}` };
    await writeAtomic(dir, out);
    return { ok: true as const, record: out };
  });
}

export const canTransition = (from: Phase, to: Phase): boolean => TRANSITIONS[from].includes(to);

export function setPhase(root: string, id: string, to: Phase, why: string, expectedRev?: number): Promise<Saved> {
  return updateMission(root, id, (r) => (canTransition(r.phase, to) ? { ...r, phase: to } : { error: `cannot move ${r.phase} -> ${to}` }), expectedRev).then(async (s) => {
    if (s.ok) await appendJournal(root, id, { type: "phase", why: clip(why), evidence: `${to}` });
    return s;
  });
}

export function addAssumption(root: string, id: string, text: string, madeBy: string): Promise<Saved> {
  return updateMission(root, id, (r) => (r.assumptions.length >= MAX_ITEMS ? { error: "too many assumptions" } : { ...r, assumptions: [...r.assumptions, { id: `a${r.assumptions.length + 1}`, text: clip(text), madeBy: clip(madeBy, 100), at: now(), status: "open" }] })).then(async (s) => {
    if (s.ok) await appendJournal(root, id, { type: "assumption-made", why: clip(text), evidence: `a${s.record.assumptions.length}` });
    return s;
  });
}

export function resolveAssumption(root: string, id: string, assumptionId: string, status: "confirmed" | "overturned", why: string): Promise<Saved> {
  return updateMission(root, id, (r) => (r.assumptions.some((a) => a.id === assumptionId) ? { ...r, assumptions: r.assumptions.map((a) => (a.id === assumptionId ? { ...a, status } : a)) } : { error: `no assumption ${assumptionId}` })).then(async (s) => {
    if (s.ok) await appendJournal(root, id, { type: `assumption-${status}`, why: clip(why), evidence: assumptionId });
    return s;
  });
}

// ---- journal ---------------------------------------------------------------------------------------

export interface MissionJournalEntry { seq: number; ts: string; type: string; why: string; evidence?: string; runId?: string   /** Issue #244 review fix: machine-readable launch discrimination. */
  specId?: string;
  key?: string;
}
const JOURNAL_MAX_BYTES = 1024 * 1024;

/** Append one entry; rotates to journal.1.jsonl past 1 MB so the log stays bounded. */
export async function appendJournal(
  root: string,
  id: string,
  e: { type: string; why: string; evidence?: string; runId?: string; /** Issue #244 review fix: machine-readable launch discrimination (specId/key) so a reconcile can tell an ambiguous launch from a crash before launch. */
  specId?: string; key?: string },
): Promise<MissionJournalEntry | undefined> {
  const dir = dirOf(root, id);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return await withLock(dir, async () => {
    const file = join(dir, "journal.jsonl");
    try { if ((await stat(file)).size > JOURNAL_MAX_BYTES) await rename(file, join(dir, "journal.1.jsonl")); } catch { /* none yet */ }
    const entries = await readJournal(root, id);
    const entry: MissionJournalEntry = { seq: (entries[entries.length - 1]?.seq ?? 0) + 1, ts: now(), type: clip(e.type, 60), why: clip(e.why), ...(e.evidence ? { evidence: clip(e.evidence, 300) } : {}), ...(e.runId ? { runId: clip(e.runId, 80) } : {}), ...(e.specId ? { specId: clip(e.specId, 40) } : {}), ...(e.key ? { key: clip(e.key, 80) } : {}) };
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
    }, "journal.lock");
  } catch { return undefined; }
}

/** Entries with `seq > since`, oldest first; torn or foreign lines are skipped, never trusted. */
export async function readJournal(root: string, id: string, since = 0): Promise<MissionJournalEntry[]> {
  const out: MissionJournalEntry[] = [];
  for (const f of ["journal.1.jsonl", "journal.jsonl"]) {
    let text = "";
    try { text = await readFile(join(dirOf(root, id), f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MissionJournalEntry;
        if (Number.isInteger(e.seq) && typeof e.type === "string" && typeof e.why === "string" && e.seq > since) out.push(e);
      } catch { /* torn line */ }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Mirror the record and journal under `<repo>/.fleet/missions/<id>/` so the mission travels with the repo. Refuses symlinks. */
export async function mirrorToRepo(root: string, id: string, repoDir: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const m = await loadMission(root, id);
  if (!m.ok) return m;
  const dest = join(repoDir, ".fleet", "missions", id);
  for (const p of [join(repoDir, ".fleet"), join(repoDir, ".fleet", "missions"), dest]) {
    try { if ((await lstat(p)).isSymbolicLink()) return { ok: false, error: `${p} is a symlink; refusing` }; } catch { /* absent */ }
  }
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "record.json"), JSON.stringify(m.record, null, 2));
  await writeFile(join(dest, "journal.jsonl"), (await readJournal(root, id)).map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { ok: true, path: dest };
}

/**
 * Issue #249: materialize a mission's design as reviewable artifact FILES in the
 * project checkout — `.fleet/missions/<id>/plan.md` and `tasks.md` — so an
 * operator can approve a design from the files alone, not from a chat summary or
 * the record.json. Returns the sha256 of each file so the approval can pin which
 * revision was approved.
 *
 * Pure formatting from the record (no model calls); the files are derived data,
 * regenerated from the record. Never overwrites an existing `.fleet/missions/<id>`
 * that is a symlink (the mirror path's guard).
 */
export async function materializeDesign(repoDir: string, id: string): Promise<{ ok: true; written: string[]; planSha: string; tasksSha: string } | { ok: false; error: string }> {
  const m = await loadMission(repoDir, id);
  if (!m.ok) return m;
  const rec = m.record;
  const dest = join(repoDir, ".fleet", "missions", id);
  for (const p of [join(repoDir, ".fleet"), join(repoDir, ".fleet", "missions"), dest]) {
    try { if ((await lstat(p)).isSymbolicLink()) return { ok: false, error: `${p} is a symlink; refusing` }; } catch { /* absent */ }
  }
  const specs = Object.values(rec.supervisor?.specs ?? {}) as Array<{ spec: { id: string; goal: string; deps?: string[]; task?: { acceptance?: string[]; verify?: { command?: string; commands?: string[]; files?: string[] }; scope?: { files?: string[] } } } }>;
  const plan = [
    `# Mission plan — ${rec.missionId}`,
    "",
    `Phase: ${rec.phase}  ·  plan version: ${rec.planVersion}`,
    rec.charterRef ? `Charter: ${rec.charterRef}` : "Charter: (none recorded)",
    "",
    "## Goal",
    ...(rec.designRef ? [rec.designRef] : ["(no design note recorded; see the mission journal for the plan's reasoning)"]),
    "",
    "## Specs",
    ...specs.map((st) => `- **${st.spec.id}** — ${st.spec.goal}${st.spec.deps && st.spec.deps.length ? ` (depends on: ${st.spec.deps.join(", ")})` : ""}`),
    "",
    "## Risks",
    ...(rec.risks.length ? rec.risks.map((r: { text: string; severity: string }) => `- [${r.severity}] ${r.text}`) : ["(none recorded)"]),
    "",
    "## Riskiest assumptions",
    ...(rec.assumptions.length ? rec.assumptions.map((a: { text: string; status: string }) => `- (${a.status}) ${a.text}`) : ["(none recorded)"]),
    "",
    "## Open questions",
    ...(rec.openQuestions.length ? rec.openQuestions.map((q: string) => `- ${q}`) : ["(none)"]),
    "",
  ].join("\n");
  const tasks = [
    `# Mission tasks — ${rec.missionId}`,
    "",
    `${specs.length} spec(s). Each is dispatched in its own clone and must pass its verify gate.`,
    "",
    "| id | goal | deps | scope | acceptance | verify |",
    "| --- | --- | --- | --- | --- | --- |",
    ...specs.map((st) => {
      const s = st.spec;
      const t = s.task ?? {};
      const scope = t.scope?.files?.join(" ") ?? "—";
      const accept = t.acceptance?.join("; ") ?? "—";
      const verify = t.verify?.command ?? t.verify?.commands?.join(" && ") ?? (t.verify?.files?.length ? `files: ${t.verify.files.join(" ")}` : "—");
      return `| ${s.id} | ${s.goal} | ${(s.deps ?? []).join(", ") || "—"} | ${scope} | ${accept} | ${verify} |`;
    }),
    "",
  ].join("\n");
  const { createHash } = await import("node:crypto");
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "plan.md"), plan);
  await writeFile(join(dest, "tasks.md"), tasks);
  return { ok: true, written: [`.fleet/missions/${id}/plan.md`, `.fleet/missions/${id}/tasks.md`], planSha: sha(plan), tasksSha: sha(tasks) };
}

export async function listMissions(root: string): Promise<Array<{ missionId: string; phase?: Phase; rev?: number; error?: string }>> {
  const { readdir } = await import("node:fs/promises");
  let names: string[] = [];
  try { names = await readdir(join(root, ".opencode-fleet", "missions")); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => ID.test(x)).sort()) {
    const m = await loadMission(root, n);
    out.push(m.ok ? { missionId: n, phase: m.record.phase, rev: m.record.rev } : { missionId: n, error: m.error });
  }
  return out;
}
