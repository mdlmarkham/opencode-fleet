/**
 * Decision layer over the S1 client (issue #79, S1-1): pluggable backends, a
 * mode switch, a data-egress opt-in, fail-closed combination with the static
 * rules, and per-call audit logging.
 *
 * Principles (from #66):
 *  - S1 is EVIDENCE, never permission. The static rules (deny list, #51) stay the
 *    boundary; `combineWithStatic` can only ever ADD a block, never lift one.
 *  - Any failure (backend down, timeout, malformed answer, egress not allowed,
 *    layer off) leaves the STATIC verdict in force. Never "allow because S1 said
 *    nothing".
 *  - Nothing leaves the machine by default: the default backend is local, and a
 *    hosted (or any non-loopback) backend needs an explicit `allowEgress`, with
 *    secrets redacted from what is sent.
 *  - No new node op: this runs wherever the caller runs (gateway/manager).
 *
 * This module wires nothing into dispatch; it hands callers a `DecideFn`.
 */

import { decide, type DecideInput, type DecideOptions, type DecideResult, type FleetQuestions, type S1Fetch } from "./decision.js";
import { redactSecrets } from "./untrusted.js";

export type BackendName = "local-kev" | "zen-jev" | "typesafe-jev";
export type Mode = "off" | "shadow" | "enforce";

export const BACKEND_NAMES: readonly BackendName[] = ["local-kev", "zen-jev", "typesafe-jev"];
export const DEFAULT_BACKEND: BackendName = "local-kev";
/** Shadow by default: decisions are computed and logged, never acted on. */
export const DEFAULT_MODE: Mode = "shadow";

export interface BackendConfig {
  /** Base URL of the S1 endpoint. local-kev defaults to the loopback deployment. */
  url?: string;
  /** Model alias sent on the wire. */
  model?: string;
  /** Bearer token for hosted backends (never logged). */
  apiKey?: string;
  /** Explicit opt-in to send data to this backend when it is not loopback. */
  allowEgress?: boolean;
}

export interface Calibration {
  /** The model/version the thresholds were measured with (see #78). */
  model: string;
  /** ISO date of the calibration report. */
  date?: string;
}

export interface S1Config {
  backend: BackendName;
  mode: Mode;
  /** Per-question block thresholds, from the #78 report (block when probabilityTrue >= threshold). */
  thresholds: Record<string, number>;
  timeoutMs: number;
  calibration?: Calibration;
  backends: Partial<Record<BackendName, BackendConfig>>;
}

export type ParseResult = { ok: true; config: S1Config } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate the plugin's `s1` config; absent means the safe defaults (local-kev, shadow). */
export function parseS1Config(raw: unknown): ParseResult {
  const config: S1Config = { backend: DEFAULT_BACKEND, mode: DEFAULT_MODE, thresholds: {}, timeoutMs: 10_000, backends: {} };
  if (raw === undefined || raw === null) return { ok: true, config };
  if (!isRecord(raw)) return { ok: false, error: "s1 must be an object" };
  if (raw.backend !== undefined) {
    if (typeof raw.backend !== "string" || !(BACKEND_NAMES as readonly string[]).includes(raw.backend)) {
      return { ok: false, error: `s1.backend must be one of ${BACKEND_NAMES.join("|")}` };
    }
    config.backend = raw.backend as BackendName;
  }
  if (raw.mode !== undefined) {
    if (raw.mode !== "off" && raw.mode !== "shadow" && raw.mode !== "enforce") return { ok: false, error: "s1.mode must be off|shadow|enforce" };
    config.mode = raw.mode;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs < 100 || raw.timeoutMs > 120_000) {
      return { ok: false, error: "s1.timeoutMs must be between 100 and 120000" };
    }
    config.timeoutMs = raw.timeoutMs;
  }
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) return { ok: false, error: "s1.thresholds must be an object of question id -> number in [0,1]" };
    for (const [k, v] of Object.entries(raw.thresholds)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return { ok: false, error: `s1.thresholds.${k} must be a number in [0,1]` };
      config.thresholds[k] = v;
    }
  }
  if (raw.calibration !== undefined) {
    const c = raw.calibration;
    if (!isRecord(c) || typeof c.model !== "string" || !c.model.trim()) return { ok: false, error: "s1.calibration.model must be a non-empty string" };
    config.calibration = { model: c.model, ...(typeof c.date === "string" ? { date: c.date } : {}) };
  }
  if (raw.backends !== undefined) {
    if (!isRecord(raw.backends)) return { ok: false, error: "s1.backends must be an object" };
    for (const [name, b] of Object.entries(raw.backends)) {
      if (!(BACKEND_NAMES as readonly string[]).includes(name)) return { ok: false, error: `s1.backends.${name}: unknown backend` };
      if (!isRecord(b)) return { ok: false, error: `s1.backends.${name} must be an object` };
      const out: BackendConfig = {};
      for (const key of ["url", "model", "apiKey"] as const) {
        if (b[key] !== undefined) {
          if (typeof b[key] !== "string" || !(b[key] as string).trim()) return { ok: false, error: `s1.backends.${name}.${key} must be a non-empty string` };
          out[key] = b[key] as string;
        }
      }
      if (out.url !== undefined && !/^https?:\/\//i.test(out.url)) return { ok: false, error: `s1.backends.${name}.url must be an http(s) URL` };
      if (b.allowEgress !== undefined) {
        if (typeof b.allowEgress !== "boolean") return { ok: false, error: `s1.backends.${name}.allowEgress must be a boolean` };
        out.allowEgress = b.allowEgress;
      }
      config.backends[name as BackendName] = out;
    }
  }
  return { ok: true, config };
}

/** Whether a URL points at this machine (no data leaves it). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

/** Hosted backends always count as egress; local-kev only if pointed off-machine. */
export function needsEgress(backend: BackendName, url: string): boolean {
  return backend !== "local-kev" || !isLoopbackUrl(url);
}

const DEFAULT_URL = "http://127.0.0.1:8009";

/** Recursively redact secrets from every string in a state value before it leaves the machine. */
export function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/**
 * Issue #101: redact every string in a questions map (instructions + criteria)
 * before the payload leaves the machine. Caller-authored text lives here — in
 * the shadow path, the whole dispatch task — so it must be scrubbed exactly like
 * `state`. Shape is preserved; only the string leaves are rewritten.
 */
export function redactQuestions(qs: FleetQuestions): FleetQuestions {
  if (!qs || !isRecord(qs)) return qs;
  return Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, redactDeep(q)])) as FleetQuestions;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface CallLog {
  kind: "decision";
  ts: string;
  backend: BackendName;
  /** Model the backend reported (the calibration check compares this). */
  model?: string;
  mode: Mode;
  effectiveMode: Mode;
  ok: boolean;
  /** Why the call produced no decision (off, egress refused, timeout, malformed, ...). */
  error?: string;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
  questionIds: string[];
  warnings: string[];
}

export interface OverrideLog {
  kind: "override";
  ts: string;
  runId?: string;
  /** What was blocked (redacted by the caller). */
  subject: string;
  by: string;
  reason: string;
}

export type AuditEntry = CallLog | OverrideLog;
export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

/** A blocked-but-legitimate action may be overridden, but never silently: it is recorded. */
export async function recordOverride(sink: AuditSink, o: Omit<OverrideLog, "kind" | "ts">, now: () => Date = () => new Date()): Promise<OverrideLog> {
  const entry: OverrideLog = { kind: "override", ts: now().toISOString(), ...o };
  await sink(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

export interface DecisionMeta {
  backend: BackendName;
  mode: Mode;
  /** `enforce` is downgraded to `shadow` when the model changed since calibration. */
  effectiveMode: Mode;
  latencyMs: number;
  warnings: string[];
}

export type GuardedResult = DecideResult & { meta: DecisionMeta };

export interface DeciderDeps {
  fetch?: S1Fetch;
  sink?: AuditSink;
  now?: () => number;
}

export interface Decider {
  (input: DecideInput, opts?: DecideOptions): Promise<GuardedResult>;
  config: S1Config;
}

/**
 * Build the decider for a config. The returned function has `decide`'s shape (so
 * it drops into the hooks' `DecideFn`), and never throws.
 */
export function makeDecider(config: S1Config, deps: DeciderDeps = {}): Decider {
  const now = deps.now ?? Date.now;
  const b = config.backends[config.backend] ?? {};
  const url = b.url ?? DEFAULT_URL;
  const fn = async (input: DecideInput, opts: DecideOptions = {}): Promise<GuardedResult> => {
    const start = now();
    const warnings: string[] = [];
    let effectiveMode = config.mode;
    const finish = async (r: DecideResult): Promise<GuardedResult> => {
      const latencyMs = Math.max(0, now() - start);
      if (r.ok && config.calibration && r.model !== config.calibration.model) {
        warnings.push(`model ${JSON.stringify(r.model)} differs from the calibrated model ${JSON.stringify(config.calibration.model)}; re-run the #78 calibration before enforcing`);
        if (effectiveMode === "enforce") effectiveMode = "shadow";
      }
      const meta: DecisionMeta = { backend: config.backend, mode: config.mode, effectiveMode, latencyMs, warnings };
      try {
        await deps.sink?.({
          kind: "decision", ts: new Date(now()).toISOString(), backend: config.backend, model: r.ok ? r.model : undefined, mode: config.mode, effectiveMode,
          ok: r.ok, ...(r.ok ? { usage: r.usage } : { error: r.error }), latencyMs, questionIds: Object.keys(input.questions ?? {}), warnings,
        });
      } catch { /* an audit-sink failure must not change the decision */ }
      return { ...r, meta };
    };

    if (config.mode === "off") return finish({ ok: false, error: "decision layer is off (s1.mode)" });
    const egress = needsEgress(config.backend, url);
    if (egress && b.allowEgress !== true) {
      return finish({ ok: false, error: `backend ${config.backend} at ${new URL(url).origin} would send data off this machine; set s1.backends.${config.backend}.allowEgress to opt in` });
    }
    const wrapped: S1Fetch | undefined = deps.fetch ?? opts.fetch ?? (globalThis as { fetch?: S1Fetch }).fetch;
    const withAuth: S1Fetch | undefined = wrapped && b.apiKey
      ? (u, init) => wrapped(u, { ...init, headers: { ...init.headers, authorization: `Bearer ${b.apiKey}` } })
      : wrapped;
    try {
      // Issue #101: when the decision leaves this machine, redact secrets from the
      // WHOLE payload, not just `state`. The question's `instructions`/`criteria`
      // carry caller-authored text (in the shadow path, the full dispatch task),
      // so a secret there would otherwise reach a hosted backend unredacted.
      const safeInput = egress
        ? { ...input, state: redactDeep(input.state), questions: redactQuestions(input.questions) }
        : input;
      const r = await decide(
        { ...safeInput, model: input.model ?? b.model },
        { ...opts, url, fetch: withAuth, timeoutMs: opts.timeoutMs ?? config.timeoutMs },
      );
      return finish(r);
    } catch (e) {
      return finish({ ok: false, error: `decision backend failed: ${(e as Error).message}` });
    }
  };
  return Object.assign(fn, { config });
}

// ---------------------------------------------------------------------------
// Fail-closed combination with the static rules
// ---------------------------------------------------------------------------

export interface StaticVerdict {
  /** The static rules' own verdict (the #51 deny list). */
  action: "allow" | "block";
  reason?: string;
}

export interface GateOutcome {
  action: "allow" | "block";
  reason: string;
  /** Which layer decided. */
  source: "static" | "s1" | "none";
  /** In shadow (or downgraded) mode: what S1 WOULD have done, recorded but not acted on. */
  shadow?: { wouldBlock: boolean; probability: number; threshold: number };
}

/**
 * Combine the static verdict with an S1 decision for one boolean question
 * ("should this be blocked?"). Rules, in order:
 *  1. A static BLOCK always stands; S1 can never lift it.
 *  2. No usable decision (off, egress refused, error, missing/non-boolean answer,
 *     no threshold configured for the question) -> the static verdict stands.
 *  3. effective mode `shadow`: the static verdict stands; what S1 would have done
 *     is attached under `shadow`.
 *  4. `enforce`: S1 at/above the threshold adds a block.
 */
export function combineWithStatic(staticVerdict: StaticVerdict, decision: GuardedResult | undefined, questionId: string, config: S1Config): GateOutcome {
  if (staticVerdict.action === "block") return { action: "block", source: "static", reason: staticVerdict.reason ?? "blocked by the static rules" };
  const stay = (why: string): GateOutcome => ({ action: "allow", source: "static", reason: staticVerdict.reason ?? why });
  if (!decision || !decision.ok) return stay("no S1 decision; the static rules apply");
  const threshold = config.thresholds[questionId];
  if (threshold === undefined) return stay(`no calibrated threshold for ${questionId}; the static rules apply`);
  const a = decision.answers[questionId];
  if (!a || a.type !== "boolean") return stay("S1 gave no boolean answer; the static rules apply");
  const wouldBlock = a.probabilityTrue >= threshold;
  const shadow = { wouldBlock, probability: a.probabilityTrue, threshold };
  if (decision.meta.effectiveMode !== "enforce") return { ...stay("shadow mode: S1 recorded, not acted on"), shadow };
  return wouldBlock
    ? { action: "block", source: "s1", reason: `S1 scored ${a.probabilityTrue.toFixed(3)} >= threshold ${threshold} for ${questionId}`, shadow }
    : { ...stay("S1 below threshold"), source: "s1", shadow };
}
