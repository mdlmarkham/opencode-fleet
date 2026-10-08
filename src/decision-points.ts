/**
 * Decision-point registry, first slice (issue #130). A decision point is DECLARED DATA, not code: an
 * id, a versioned question, two-sided thresholds, a safe default for when S1 cannot answer, a mode and
 * a calibration record. S1 is a router, prior and pre-screen here, never the judge of correctness and
 * never the sole basis for anything irreversible.
 *
 * What this module guarantees:
 *  - Cascade: confident-low and confident-high are handled cheaply; the uncertain band escalates.
 *  - Any failure (no answer, malformed, timeout, throw) yields the point's own safe default, logged.
 *  - Nothing is acted on unless the EFFECTIVE mode is `enforce`. A point cannot be declared `enforce`
 *    without a calibration corpus, and a wording-version or model change drops it back to shadow.
 *  - A repo layer may tighten an operator point (stricter mode, wider uncertain band), never loosen it.
 *  - Promotion shadow -> enforce needs measured agreement with outcomes that beats the deterministic
 *    baseline; rates are withheld below `minN`.
 *
 * Pure except the optional sink calls. Boolean questions only in this slice; choice/score points and
 * the labelled corpora runner (#78 harness shape) are follow-ups.
 */

export type PointMode = "off" | "shadow" | "enforce";
const MODE_RANK: Record<PointMode, number> = { off: 0, shadow: 1, enforce: 2 };

export interface DecisionPoint {
  id: string;
  question: { wording: string; version: number };
  /** probability < lowBelow is confident-low; > highAbove is confident-high; otherwise uncertain. */
  lowBelow: number;
  highAbove: number;
  /** What the uncertain band escalates to (a deterministic rule, a critic, a second reviewer, a human). */
  uncertainAction: string;
  /** Static behaviour when S1 is unavailable, malformed, late or refused. Required: there is no global default. */
  safeDefault: string;
  mode: PointMode;
  calibration?: { model: string; date?: string; corpus?: string; wordingVersion: number };
  owner?: string;
}

const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const KEYS = new Set(["id", "question", "lowBelow", "highAbove", "uncertainAction", "safeDefault", "mode", "calibration", "owner"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

export type ParsePoints = { ok: true; points: DecisionPoint[] } | { ok: false; error: string };

/** Validate declared points. Unknown keys are rejected; `enforce` needs a calibration corpus. */
export function parsePoints(raw: unknown): ParsePoints {
  if (raw === undefined || raw === null) return { ok: true, points: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "decision points must be an array" };
  const seen = new Set<string>();
  const points: DecisionPoint[] = [];
  for (const [i, p] of raw.entries()) {
    const at = `point[${i}]`;
    if (!isRecord(p)) return { ok: false, error: `${at} must be an object` };
    for (const k of Object.keys(p)) if (!KEYS.has(k)) return { ok: false, error: `${at}: unknown key "${k}"` };
    if (!str(p.id, 80) || !ID.test(p.id)) return { ok: false, error: `${at}: id must look like "review.depth"` };
    if (seen.has(p.id)) return { ok: false, error: `${at}: duplicate id ${p.id}` };
    seen.add(p.id);
    const q = p.question;
    if (!isRecord(q) || !str(q.wording, 1000) || typeof q.version !== "number" || !Number.isInteger(q.version) || q.version < 1) return { ok: false, error: `${p.id}: question needs {wording, version>=1}` };
    const { lowBelow, highAbove } = p;
    if (typeof lowBelow !== "number" || typeof highAbove !== "number" || !(lowBelow >= 0 && lowBelow <= highAbove && highAbove <= 1)) return { ok: false, error: `${p.id}: need 0 <= lowBelow <= highAbove <= 1` };
    if (!str(p.uncertainAction)) return { ok: false, error: `${p.id}: uncertainAction is required` };
    if (!str(p.safeDefault)) return { ok: false, error: `${p.id}: safeDefault is required (there is no global default)` };
    const mode = (p.mode ?? "shadow") as PointMode;
    if (!(mode in MODE_RANK)) return { ok: false, error: `${p.id}: mode must be off|shadow|enforce` };
    let calibration: DecisionPoint["calibration"];
    if (p.calibration !== undefined) {
      const c = p.calibration;
      if (!isRecord(c) || !str(c.model, 100) || typeof c.wordingVersion !== "number" || !Number.isInteger(c.wordingVersion)) return { ok: false, error: `${p.id}: calibration needs {model, wordingVersion}` };
      if ((c.date !== undefined && !str(c.date, 40)) || (c.corpus !== undefined && !str(c.corpus, 200))) return { ok: false, error: `${p.id}: calibration.date/corpus must be short strings` };
      calibration = { model: c.model, wordingVersion: c.wordingVersion, ...(c.date ? { date: c.date as string } : {}), ...(c.corpus ? { corpus: c.corpus as string } : {}) };
    }
    if (mode === "enforce" && !calibration?.corpus) return { ok: false, error: `${p.id}: a point without a calibration corpus cannot leave shadow` };
    if (p.owner !== undefined && !str(p.owner, 100)) return { ok: false, error: `${p.id}: owner must be a short string` };
    points.push({ id: p.id, question: { wording: q.wording as string, version: q.version }, lowBelow, highAbove, uncertainAction: p.uncertainAction, safeDefault: p.safeDefault, mode, ...(calibration ? { calibration } : {}), ...(p.owner ? { owner: p.owner as string } : {}) });
  }
  return { ok: true, points };
}

/**
 * Layer a repo's points over the operator's: a repo may tighten (a lower-ranked mode, a wider uncertain
 * band), never loosen. A repo-only point is capped at shadow. Returns the merged set or the first violation.
 */
export function layerPoints(operator: DecisionPoint[], repo: DecisionPoint[]): ParsePoints {
  const byId = new Map(operator.map((p) => [p.id, p]));
  const out = new Map(byId);
  for (const r of repo) {
    const o = byId.get(r.id);
    if (!o) { out.set(r.id, { ...r, mode: MODE_RANK[r.mode] > MODE_RANK.shadow ? "shadow" : r.mode }); continue; }
    if (MODE_RANK[r.mode] > MODE_RANK[o.mode]) return { ok: false, error: `${r.id}: a repo may not raise the mode above the operator's (${o.mode})` };
    if (r.lowBelow > o.lowBelow || r.highAbove < o.highAbove) return { ok: false, error: `${r.id}: a repo may only widen the uncertain band, not narrow it` };
    out.set(r.id, { ...o, mode: r.mode, lowBelow: r.lowBelow, highAbove: r.highAbove });
  }
  return { ok: true, points: [...out.values()] };
}

/** `enforce` only holds while the calibration still matches the question wording and the serving model. */
export function effectiveMode(p: DecisionPoint, servingModel?: string): PointMode {
  if (p.mode !== "enforce") return p.mode;
  const c = p.calibration;
  if (!c?.corpus || c.wordingVersion !== p.question.version) return "shadow";
  if (servingModel !== undefined && servingModel !== c.model) return "shadow";
  return "enforce";
}

export type Band = "low" | "high" | "uncertain";
export interface PointDecision {
  decisionId: string;
  pointId: string;
  ts: string;
  mode: PointMode;
  probability?: number;
  band?: Band;
  /** `s1` = S1's band stands; `escalated` = uncertain band; `static` = no usable answer, the safe default applies. */
  source: "s1" | "escalated" | "static";
  /** What the caller should do: the band's cheap path, the uncertain action, or the safe default. */
  action: string;
  /** True only when the effective mode is enforce; otherwise the caller must keep its existing behaviour. */
  acted: boolean;
  fallback?: string;
  baseline?: boolean;
}

let seq = 0;
const newId = (now: number): string => `dp-${now.toString(36)}-${(seq++).toString(36)}`;

/** Resolve one answer (or its absence) against a point. Pure. */
export function resolveDecision(p: DecisionPoint, answer: number | undefined | { error: string }, opts: { now?: number; servingModel?: string; baseline?: boolean; actions?: { low: string; high: string } } = {}): PointDecision {
  const now = opts.now ?? Date.now();
  const mode = effectiveMode(p, opts.servingModel);
  const base = { decisionId: newId(now), pointId: p.id, ts: new Date(now).toISOString(), mode, ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}) };
  const acted = mode === "enforce";
  if (mode === "off") return { ...base, source: "static", action: p.safeDefault, acted: false, fallback: "point is off" };
  if (typeof answer !== "number" || !Number.isFinite(answer) || answer < 0 || answer > 1) {
    const why = typeof answer === "object" && answer !== null ? answer.error : "no usable answer";
    return { ...base, source: "static", action: p.safeDefault, acted, fallback: String(why).slice(0, 200) };
  }
  const band: Band = answer < p.lowBelow ? "low" : answer > p.highAbove ? "high" : "uncertain";
  if (band === "uncertain") return { ...base, probability: answer, band, source: "escalated", action: p.uncertainAction, acted };
  return { ...base, probability: answer, band, source: "s1", action: band === "low" ? (opts.actions?.low ?? "low") : (opts.actions?.high ?? "high"), acted };
}

export interface RunDeps {
  /** Ask S1 the point's question; resolves to probabilityTrue. May throw or return nothing. */
  ask: (p: DecisionPoint) => Promise<number | undefined>;
  sink?: (entry: object) => void | Promise<void>;
  servingModel?: string;
  baseline?: boolean;
  actions?: { low: string; high: string };
  timeoutMs?: number;
}

/** Ask, resolve and log. Never throws; a throw, timeout or bad answer is the safe default. */
export async function runPoint(p: DecisionPoint, deps: RunDeps): Promise<PointDecision> {
  let answer: number | undefined | { error: string };
  if (effectiveMode(p, deps.servingModel) === "off") answer = undefined;
  else {
    try {
      const timeout = new Promise<{ error: string }>((r) => { const t = setTimeout(() => r({ error: "timeout" }), deps.timeoutMs ?? 10_000); (t as { unref?: () => void }).unref?.(); });
      answer = await Promise.race([deps.ask(p), timeout]);
    } catch (e) {
      answer = { error: `asker threw: ${(e as Error).message}` };
    }
  }
  const d = resolveDecision(p, answer, { ...(deps.servingModel ? { servingModel: deps.servingModel } : {}), ...(deps.baseline !== undefined ? { baseline: deps.baseline } : {}), ...(deps.actions ? { actions: deps.actions } : {}) });
  try { await deps.sink?.({ kind: "decision-point", ...d }); } catch { /* logging never breaks a decision */ }
  return d;
}

/** Link a decision to its eventual outcome (`happened`: did the thing the question asks about occur). */
export async function linkOutcome(sink: (entry: object) => void | Promise<void>, decisionId: string, happened: boolean, now: () => number = Date.now): Promise<void> {
  try { await sink({ kind: "decision-outcome", decisionId, happened, ts: new Date(now()).toISOString() }); } catch { /* best effort */ }
}

export interface PointReport {
  pointId: string;
  decisions: number;
  withOutcome: number;
  escalationRate: number | null;
  fallbackRate: number | null;
  /** Among confident, outcome-linked decisions: how often S1's band matched the outcome vs the deterministic baseline. */
  confident: number;
  s1Accuracy: number | null;
  baselineAccuracy: number | null;
  /** Eligible for shadow -> enforce: a corpus is declared, enough confident cases, and S1 beats the baseline. */
  promotable: boolean;
  why: string;
}

export const DEFAULT_MIN_N = 20;

/** Per-point shadow report from the decision and outcome log lines. Rates are withheld below `minN`. */
export function pointReport(p: DecisionPoint, log: object[], minN = DEFAULT_MIN_N): PointReport {
  const outcomes = new Map<string, boolean>();
  for (const e of log as Array<{ kind?: string; decisionId?: string; happened?: boolean }>) if (e.kind === "decision-outcome" && typeof e.decisionId === "string" && typeof e.happened === "boolean") outcomes.set(e.decisionId, e.happened);
  const ds = (log as Array<Partial<PointDecision> & { kind?: string }>).filter((e) => e.kind === "decision-point" && e.pointId === p.id) as PointDecision[];
  const linked = ds.filter((d) => outcomes.has(d.decisionId));
  const conf = linked.filter((d) => d.source === "s1" && d.baseline !== undefined);
  const rate = (k: number, n: number): number | null => (n >= minN ? Math.round((k / n) * 1000) / 1000 : null);
  const s1Ok = conf.filter((d) => (d.band === "high") === outcomes.get(d.decisionId)).length;
  const baseOk = conf.filter((d) => d.baseline === outcomes.get(d.decisionId)).length;
  const s1Acc = rate(s1Ok, conf.length);
  const baseAcc = rate(baseOk, conf.length);
  let why = "ok";
  if (!p.calibration?.corpus) why = "no calibration corpus declared";
  else if (s1Acc === null || baseAcc === null) why = `fewer than ${minN} confident outcome-linked decisions`;
  else if (s1Acc <= baseAcc) why = "S1 does not beat the deterministic baseline";
  return {
    pointId: p.id,
    decisions: ds.length,
    withOutcome: linked.length,
    escalationRate: rate(ds.filter((d) => d.source === "escalated").length, ds.length),
    fallbackRate: rate(ds.filter((d) => d.source === "static").length, ds.length),
    confident: conf.length,
    s1Accuracy: s1Acc,
    baselineAccuracy: baseAcc,
    promotable: why === "ok",
    why,
  };
}

export interface ReadinessCoverage {
  /** Rows of kind `readiness.dispatch` in the log. */
  judged: number;
  /** Rows where S1 itself answered (`source: "s1"`). */
  answeredByS1: number;
  /** Rows where the deterministic baseline answered because S1 could not. */
  fellBack: number;
  /** Fallbacks bucketed by the #311 stable prefixes (longest first); unknown reasons keep their raw string. */
  byReason: Record<string, number>;
}

/** #311's stable fallbackReason prefixes, longest first so "S1 rejected the request" wins over a hypothetical shorter one. */
const FALLBACK_PREFIXES: readonly string[] = ["S1 rejected the request", "S1 request failed", "S1 unreachable", "S1 timed out"];

/** The `"S1 error: "` wrapper readiness-judge's fallback puts on the decider's own error (#311): stripped before prefix matching, or every real row buckets under its unique raw string. */
const FALLBACK_WRAPPER = "S1 error: ";

/** Summarize the readiness rows of a shadow log (issue #322): how often S1 actually answered vs fell back, and why. Pure. */
export function readinessCoverage(log: object[]): ReadinessCoverage {
  const rows = (log as Array<{ kind?: string; source?: string; fallbackReason?: string }>).filter((e) => e.kind === "readiness.dispatch");
  const byReason: Record<string, number> = {};
  for (const e of rows) {
    if (e.source !== "baseline" || e.fallbackReason === undefined) continue;
    const raw = e.fallbackReason.startsWith(FALLBACK_WRAPPER) ? e.fallbackReason.slice(FALLBACK_WRAPPER.length) : e.fallbackReason;
    const prefix = FALLBACK_PREFIXES.find((p) => raw.startsWith(p)) ?? raw;
    byReason[prefix] = (byReason[prefix] ?? 0) + 1;
  }
  return {
    judged: rows.length,
    answeredByS1: rows.filter((e) => e.source === "s1").length,
    fellBack: rows.filter((e) => e.source === "baseline").length,
    byReason,
  };
}
