/**
 * Delivery planning for a mission (issue #128), pure and deterministic: the order verified work is
 * integrated, the gate that decides whether a PR may be opened at all, the evidence report a human reads
 * instead of the journal, and the staging of an oversized diff into reviewable PRs. The git operations
 * (merging branches, publishing through the fleet_sync policy) are the caller's; this decides and writes.
 *
 * Rules that matter: a conflict is an escalation, never a silent resolution; a PR is opened only from a
 * clean-checkout verification that does not regress against the recorded baseline AND with the C3/C4
 * checkpoints satisfied; pre-existing failures are not blamed on the mission, regressions are; everything
 * a worker or reviewer wrote is untrusted text and is quoted and bounded in the report.
 */

export interface DeliverySpec { id: string; goal: string; deps: string[]; branch?: string; status: "verified" | "pending" | "running" | "escalated" | "superseded" | "needs-replan"; runId?: string; filesChanged?: number; linesChanged?: number; verify?: { passed: boolean | null; summary?: string } }

export type Order = { ok: true; order: string[] } | { ok: false; error: string };

/** Verified specs in dependency order (dependencies first), ties by id. Anything not verified blocks delivery. */
export function mergeOrder(specs: DeliverySpec[]): Order {
  const live = specs.filter((s) => s.status !== "superseded");
  const notDone = live.filter((s) => s.status !== "verified");
  if (notDone.length) return { ok: false, error: `not all specs are verified: ${notDone.map((s) => `${s.id} (${s.status})`).join(", ")}` };
  const noBranch = live.filter((s) => !s.branch);
  if (noBranch.length) return { ok: false, error: `no branch recorded for: ${noBranch.map((s) => s.id).join(", ")}` };
  const ids = new Set(live.map((s) => s.id));
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < live.length) {
    const ready = live.filter((s) => !placed.has(s.id) && s.deps.filter((d) => ids.has(d)).every((d) => placed.has(d))).map((s) => s.id).sort();
    if (!ready.length) return { ok: false, error: "dependency cycle among verified specs" };
    for (const id of ready) { order.push(id); placed.add(id); }
  }
  return { ok: true, order };
}

export interface Merge { specId: string; conflict: boolean; conflictFiles?: string[] }
/** The first conflict stops integration and escalates with its files: it is never resolved silently. */
export function integrationOutcome(merges: Merge[]): { ok: true } | { ok: false; escalate: { specId: string; files: string[]; reason: string } } {
  const c = merges.find((m) => m.conflict);
  return c ? { ok: false, escalate: { specId: c.specId, files: c.conflictFiles ?? [], reason: `merging ${c.specId} conflicts; integration stops here for a human or a bounded integrator run` } } : { ok: true };
}

export interface CommandRun { command: string; kind: "build" | "test" | "lint" | "acceptance"; exitCode: number | null }
export interface BaselineRun { command: string; exitCode: number | null }
export interface Comparison { regressions: string[]; fixed: string[]; preExisting: string[]; unmeasured: string[]; newPassing: string[] }

/** Final clean-checkout results against the adopt-time baseline. An unrun command is never a pass or a fail. */
export function compareToBaseline(baseline: BaselineRun[], final: CommandRun[]): Comparison {
  const base = new Map(baseline.map((b) => [b.command, b.exitCode]));
  const out: Comparison = { regressions: [], fixed: [], preExisting: [], unmeasured: [], newPassing: [] };
  for (const f of final) {
    if (f.exitCode === null) { out.unmeasured.push(f.command); continue; }
    const was = base.get(f.command);
    const failing = f.exitCode !== 0;
    if (was === undefined) { if (failing && f.kind !== "acceptance") out.regressions.push(`${f.command} (not in the baseline) fails`); else if (failing) out.regressions.push(`${f.command} (acceptance) fails`); else out.newPassing.push(f.command); continue; }
    if (was === null) { if (failing) out.regressions.push(`${f.command} fails (baseline not measured)`); continue; }
    if (was === 0 && failing) out.regressions.push(`${f.command} passed at baseline and now exits ${f.exitCode}`);
    else if (was !== 0 && failing) out.preExisting.push(f.command);
    else if (was !== 0 && !failing) out.fixed.push(f.command);
  }
  return out;
}

export interface CheckpointState { checkpoint: string; state: string }
export interface GateInput { specs: DeliverySpec[]; merges: Merge[]; comparison?: Comparison; checkpoints: CheckpointState[]; /** sync.requireVerified from the publish policy. */ requireVerified?: boolean }
export type DeliveryGate = { open: true; order: string[] } | { open: false; escalate: true; reasons: string[] };

/** May a PR be opened? Any reason to stop is an escalation with the reason; there is no partial yes. */
export function deliveryGate(i: GateInput): DeliveryGate {
  const reasons: string[] = [];
  const o = mergeOrder(i.specs);
  if (!o.ok) reasons.push(o.error);
  const m = integrationOutcome(i.merges);
  if (!m.ok) reasons.push(`${m.escalate.reason}: ${m.escalate.files.slice(0, 5).join(", ") || "files unknown"}`);
  if (!i.comparison) reasons.push("no clean-checkout verification against the baseline was recorded");
  else {
    for (const r of i.comparison.regressions) reasons.push(`regression: ${r}`);
    if (i.comparison.unmeasured.length) reasons.push(`not run in the final verification: ${i.comparison.unmeasured.join(", ")}`);
  }
  for (const need of ["C3", "C4"]) {
    const c = i.checkpoints.find((x) => x.checkpoint === need);
    if (!c) reasons.push(`checkpoint ${need} has no verdict`);
    else if (c.state !== "satisfied") reasons.push(`checkpoint ${need} is ${c.state}`);
  }
  if (i.requireVerified && i.specs.some((s) => s.status === "verified" && s.verify?.passed !== true)) reasons.push("sync.requireVerified: a spec has no passing verification result");
  return reasons.length || !o.ok ? { open: false, escalate: true, reasons } : { open: true, order: o.order };
}

/** Split specs (already in merge order) into PR groups no bigger than `maxLines`, never separating a spec from its dependencies. */
export function stagedGroups(specs: DeliverySpec[], order: string[], maxLines: number): string[][] {
  const by = new Map(specs.map((s) => [s.id, s]));
  const groups: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const id of order) {
    const lines = by.get(id)?.linesChanged ?? 0;
    if (cur.length && size + lines > maxLines) { groups.push(cur); cur = []; size = 0; }
    cur.push(id);
    size += lines;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---- evidence report ------------------------------------------------------------------------------------------

export interface ReportInput {
  missionId: string;
  goal: string;
  charterRef?: string;
  commit: string;
  baseBranch: string;
  specs: DeliverySpec[];
  filesChanged: number;
  diffStat?: string;
  reviews: Array<{ checkpoint: string; reviewer: string; engine?: string; model?: string; verdict: string; findings: string[]; resolution?: string }>;
  comparison: Comparison;
  assumptions: Array<{ text: string; status: string }>;
  risks: Array<{ text: string; severity: string }>;
  notVerified: string[];
  costUsd?: number;
  elapsedMs?: number;
  howToVerify: string[];
}

const clip = (s: string, n: number): string => s.replace(/[\r\n\t`|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_REPORT = 60_000;

/** The PR description: enough for a human to verify the work without reading the journal. All text is quoted and bounded. */
export function evidenceReport(r: ReportInput): string {
  const L: string[] = [];
  L.push(`# Mission ${clip(r.missionId, 64)}`, "", `**Goal:** ${clip(r.goal, 400)}${r.charterRef ? ` (charter: ${clip(r.charterRef, 100)})` : ""}`, `**Commit:** \`${clip(r.commit, 40)}\` onto \`${clip(r.baseBranch, 80)}\`; ${r.filesChanged} file(s) changed.`, "");
  if (r.diffStat) L.push("```", r.diffStat.slice(0, 1500).replace(/```/g, "'''"), "```", "");
  L.push("## Specs", "", "| spec | goal | verify | run |", "|---|---|---|---|");
  for (const s of r.specs.filter((x) => x.status !== "superseded")) L.push(`| ${clip(s.id, 40)} | ${clip(s.goal, 80)} | ${s.verify?.passed === true ? "passed" : s.verify?.passed === false ? "FAILED" : "not recorded"} | ${clip(s.runId ?? "", 40)} |`);
  L.push("", "## Independent review", "");
  if (!r.reviews.length) L.push("_No review verdicts were recorded._");
  for (const v of r.reviews) L.push(`- **${clip(v.checkpoint, 10)}** by ${clip(v.reviewer, 60)}${v.engine || v.model ? ` (${clip(`${v.engine ?? ""} ${v.model ?? ""}`, 60)})` : ""}: ${clip(v.verdict, 30)}${v.findings.length ? `; findings: ${v.findings.slice(0, 5).map((f) => clip(f, 120)).join("; ")}` : "; no findings"}${v.resolution ? `; resolved: ${clip(v.resolution, 120)}` : ""}`);
  const c = r.comparison;
  L.push("", "## Verification against baseline", "", `- Regressions: ${c.regressions.length ? c.regressions.map((x) => clip(x, 120)).join("; ") : "none"}`, `- Fixed since baseline: ${c.fixed.length ? c.fixed.map((x) => clip(x, 80)).join(", ") : "none"}`, `- Already failing at baseline (not this mission): ${c.preExisting.length ? c.preExisting.map((x) => clip(x, 80)).join(", ") : "none"}`, `- New passing checks: ${c.newPassing.length ? c.newPassing.map((x) => clip(x, 80)).join(", ") : "none"}`);
  L.push("", "## Assumptions made unattended", "");
  if (!r.assumptions.length) L.push("_None recorded._");
  for (const a of r.assumptions) L.push(`- [${clip(a.status, 12)}] ${clip(a.text, 200)}`);
  L.push("", "## Risks", "");
  if (!r.risks.length) L.push("_None recorded._");
  for (const k of r.risks) L.push(`- ${clip(k.severity, 8)}: ${clip(k.text, 200)}`);
  L.push("", "## Not verified", "");
  if (!r.notVerified.length) L.push("_Nothing was left unverified that the mission knows of._");
  for (const n of r.notVerified) L.push(`- ${clip(n, 200)}`);
  L.push("", "## Cost and time", "", `${r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : "cost not recorded"}; ${r.elapsedMs !== undefined ? `${Math.round(r.elapsedMs / 60_000)} min` : "time not recorded"}.`);
  L.push("", "## How to verify yourself", "");
  for (const h of r.howToVerify) L.push(`- \`${clip(h, 160)}\``);
  const text = L.join("\n");
  return text.length > MAX_REPORT ? `${text.slice(0, MAX_REPORT)}\n\n_(report truncated)_` : text;
}
