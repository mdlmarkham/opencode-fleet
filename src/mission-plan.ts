/**
 * Plan readiness, time-box, walking skeleton and staleness (issue #129): front-loading the design must
 * not become analysis paralysis, and the plan must not rot. Deterministic checks over the mission
 * record; the outcomes are `ready | needs-more`, `within | exceeded`, and `continue | replan | escalate`,
 * each with exactly what is missing and the evidence.
 */

import { appendJournal, updateMission, type Assumption, type MissionRecord, type Saved } from "./mission-store.js";
import { scopeOverlap, scopeViolations, type TaskScope } from "./scope.js";

export interface PlanSpec {
  id: string;
  goal: string;
  acceptance?: string[];
  verify?: { command?: string; commands?: string[]; files?: string[] };
  scope?: TaskScope;
  deps?: string[];
  /** Marks the thin end-to-end slice to dispatch first. */
  skeleton?: boolean;
}
export interface PlanRisk { id: string; text: string; severity: "low" | "medium" | "high"; owner?: string; mitigation?: string }
export interface PlanQuestion { text: string; answer?: string; deferredAsRisk?: string }
export interface Plan {
  specs: PlanSpec[];
  /** A test plan written BEFORE any code. */
  testPlan?: { writtenBeforeCode: boolean; items: string[] };
  risks: PlanRisk[];
  assumptions: Array<{ text: string; check?: string }>;
  questions: PlanQuestion[];
  budget?: { maxCostUsd?: number; maxTokens?: number };
}

export interface Missing { area: string; what: string }
export interface Readiness { verdict: "ready" | "needs-more"; missing: Missing[] }

const VAGUE = /\b(works?|good|properly|correctly|nicely|well|as expected|better|fast|robust|clean|easy|intuitive)\b/i;
const hasGate = (v?: PlanSpec["verify"]): boolean => !!v && !!(v.command || v.commands?.length || v.files?.length);

/** Everything the plan must have before approval, and exactly what is missing. */
export function planReadiness(plan: Plan): Readiness {
  const missing: Missing[] = [];
  const add = (area: string, what: string): void => void missing.push({ area, what });
  if (plan.specs.length === 0) add("specs", "the plan has no specs");
  for (const s of plan.specs) {
    if (!s.acceptance?.length) add(`spec ${s.id}`, "no acceptance criteria");
    else for (const a of s.acceptance) if (VAGUE.test(a) && !/[`'"/.:=<>0-9]/.test(a) && !hasGate(s.verify)) { add(`spec ${s.id}`, `acceptance "${a.slice(0, 60)}" is untestable as written and no verify gate backs it`); break; }
    if (!hasGate(s.verify)) add(`spec ${s.id}`, "no verify gate");
    if (!s.scope?.files.length) add(`spec ${s.id}`, "no scope");
  }
  const withScope = plan.specs.filter((s) => s.scope?.files.length);
  for (let i = 0; i < withScope.length; i++) for (let j = i + 1; j < withScope.length; j++) {
    const a = withScope[i]!, b = withScope[j]!;
    const dep = (a.deps ?? []).includes(b.id) || (b.deps ?? []).includes(a.id);
    if (!dep && scopeOverlap(a.scope!, b.scope!)) add("scopes", `specs ${a.id} and ${b.id} overlap and neither depends on the other`);
  }
  if (!plan.testPlan || plan.testPlan.items.length === 0) add("test plan", "no test plan");
  else if (!plan.testPlan.writtenBeforeCode) add("test plan", "the test plan was not written before the code");
  for (const r of plan.risks) {
    if (r.severity !== "low" && (!r.owner || !r.mitigation)) add(`risk ${r.id}`, "a medium/high risk needs an owner and a mitigation");
  }
  if (plan.assumptions.length === 0) add("assumptions", "no assumptions are listed (a plan always has some)");
  for (const a of plan.assumptions) if (!a.check) { add("assumptions", `"${a.text.slice(0, 60)}" has no way to be confirmed or overturned`); break; }
  for (const q of plan.questions) if (!q.answer && !q.deferredAsRisk) add("questions", `"${q.text.slice(0, 60)}" is neither answered nor deferred as a risk`);
  if (!plan.budget || (plan.budget.maxCostUsd === undefined && plan.budget.maxTokens === undefined)) add("budget", "no budget is set");
  return { verdict: missing.length ? "needs-more" : "ready", missing };
}

// ---- time-box ---------------------------------------------------------------------------------------------

export interface DesignBox { maxMs: number; maxUsd: number }
export type TimeBox = { state: "within"; remainingMs: number } | { state: "exceeded"; why: string; options: Array<"proceed-with-recorded-risk" | "narrow-scope"> };

/** Past the box the design phase may not simply continue: it must decide. */
export function checkTimeBox(a: { startedAtMs: number; spentUsd: number; nowMs: number }, box: DesignBox): TimeBox {
  const used = a.nowMs - a.startedAtMs;
  if (used > box.maxMs) return { state: "exceeded", why: `design has run ${Math.round(used / 60_000)} min, over the ${Math.round(box.maxMs / 60_000)} min box`, options: ["proceed-with-recorded-risk", "narrow-scope"] };
  if (a.spentUsd > box.maxUsd) return { state: "exceeded", why: `design has spent $${a.spentUsd.toFixed(2)}, over the $${box.maxUsd} box`, options: ["proceed-with-recorded-risk", "narrow-scope"] };
  return { state: "within", remainingMs: box.maxMs - used };
}

// ---- walking skeleton ------------------------------------------------------------------------------------

/** The spec to dispatch first: the one marked `skeleton`, else the dependency-free spec most others hang off. */
export function pickSkeleton(specs: PlanSpec[]): string | undefined {
  const marked = specs.find((s) => s.skeleton);
  if (marked) return marked.id;
  const roots = specs.filter((s) => !(s.deps ?? []).length);
  const fanout = (id: string): number => specs.filter((s) => (s.deps ?? []).includes(id)).length;
  return [...roots].sort((a, b) => fanout(b.id) - fanout(a.id) || a.id.localeCompare(b.id))[0]?.id;
}

export interface SkeletonResult { assumptionId: string; status: "confirmed" | "overturned"; evidence: string }

/**
 * Apply a skeleton run's findings to the mission: set each assumption's status, journal it, and when any
 * is overturned record a replan (plan version bump with a diff) BEFORE the bulk of the work starts.
 */
export async function applySkeleton(root: string, id: string, results: SkeletonResult[]): Promise<Saved & { replan?: boolean }> {
  const s = await updateMission(root, id, (r) => {
    const known = new Set(r.assumptions.map((a) => a.id));
    const unknown = results.find((x) => !known.has(x.assumptionId));
    if (unknown) return { error: `no assumption ${unknown.assumptionId}` };
    const overturned = results.filter((x) => x.status === "overturned");
    const assumptions: Assumption[] = r.assumptions.map((a) => { const x = results.find((y) => y.assumptionId === a.id); return x ? { ...a, status: x.status } : a; });
    return {
      ...r, assumptions,
      ...(overturned.length ? { planVersion: r.planVersion + 1, planDiffs: [...r.planDiffs, { version: r.planVersion + 1, at: new Date().toISOString(), summary: `replan: skeleton overturned ${overturned.map((o) => o.assumptionId).join(", ")}` }] } : {}),
    };
  });
  if (!s.ok) return s;
  for (const x of results) await appendJournal(root, id, { type: `assumption-${x.status}`, why: "walking skeleton result", evidence: `${x.assumptionId}: ${x.evidence}`.slice(0, 300) });
  const replan = results.some((x) => x.status === "overturned");
  if (replan) await appendJournal(root, id, { type: "replan-triggered", why: "an assumption was overturned before the bulk of the work", evidence: `plan v${s.record.planVersion}` });
  return { ...s, replan };
}

/** Overturned assumptions per mission: a plan-quality metric (#112). */
export const overturnedCount = (r: Pick<MissionRecord, "assumptions">): { overturned: number; total: number } => ({ overturned: r.assumptions.filter((a) => a.status === "overturned").length, total: r.assumptions.length });

// ---- staleness --------------------------------------------------------------------------------------------

export interface StalenessFacts {
  /** Files changed on the default branch since the plan's base commit. */
  changedOnDefault: string[];
  /** Specs by status, to know what a change would invalidate. */
  specs: Array<{ id: string; scope?: TaskScope; status: "pending" | "running" | "verified" | "other" }>;
  baselineWasPassing: boolean | null;
  baselineNowPassing: boolean | null;
  dependencyFilesChanged: boolean;
}
export interface Staleness { outcome: "continue" | "replan" | "escalate"; evidence: string[] }

const DEP_FILES = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements.*\.txt)$/;

/** Before each stage: did the repo move under the plan? `escalate` beats `replan` beats `continue`. */
export function planStaleness(f: StalenessFacts): Staleness {
  const evidence: string[] = [];
  let out: Staleness["outcome"] = "continue";
  const raise = (to: Staleness["outcome"]): void => { if (to === "escalate" || (to === "replan" && out === "continue")) out = to; };
  if (f.baselineWasPassing === true && f.baselineNowPassing === false) { evidence.push("the default branch's baseline was passing and now fails"); raise("escalate"); }
  for (const s of f.specs) {
    if (!s.scope?.files.length) continue;
    const hit = f.changedOnDefault.filter((p) => scopeViolations([p], s.scope!).length === 0);
    if (!hit.length) continue;
    evidence.push(`${hit.slice(0, 3).join(", ")} changed on the default branch inside spec ${s.id}'s scope (${s.status})`);
    raise(s.status === "pending" ? "replan" : "escalate");
  }
  if (f.dependencyFilesChanged || f.changedOnDefault.some((p) => DEP_FILES.test(p))) { evidence.push("dependency manifests changed on the default branch"); raise("replan"); }
  return { outcome: out, evidence };
}
