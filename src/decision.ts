/**
 * S1 (Jev/Kev) decision client — issue #87, slice 1.
 *
 * S1 is a TYPED decision service, not a chat model. On the gateway host it
 * listens at http://127.0.0.1:8009 (override via env FLEET_S1_URL). The wire
 * contract mirrors the @openclaw/typesafe client:
 *
 *   POST /v1/systemone
 *   body:  { model: string, state: unknown, questions: { [id]: WireQuestion } }
 *   reply: { model: string, answers: { [id]: WireAnswer },
 *            usage: { input_tokens, output_tokens } }
 *
 * Our fleet-internal question/answer vocabulary differs from the wire in two
 * spots: our "boolean" maps to the wire's "noul", and score answers arrive
 * with an index-keyed probabilities object that we reorder into an array
 * following the question's criteria order.
 *
 * Everything here is pure except decide()'s transport, which is injectable so
 * tests need no server. Slice 1 deliberately does NOT wire this into any live
 * dispatch path.
 */

import { redactSecrets } from "./untrusted.js";

export const DEFAULT_S1_URL = "http://127.0.0.1:8009";
/** Wire contract requires `model: string`; this alias is used when the caller does not name one. */
export const DEFAULT_S1_MODEL = "s1";
export const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

export type BooleanQuestion = { type: "boolean"; instructions: string; criteria?: unknown };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type FleetQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
export type FleetQuestions = Record<string, FleetQuestion>;

/** Wire shape of a question (as sent to S1). Our "boolean" becomes "noul". */
export type WireQuestion =
  | { type: "noul"; instructions: string; criteria?: unknown }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type WireQuestions = Record<string, WireQuestion>;

// ---------------------------------------------------------------------------
// Answer types
// ---------------------------------------------------------------------------

export type BooleanAnswer = { type: "boolean"; probabilityTrue: number };
/** Choice answers are passed through from the wire unchanged. */
export type ChoiceAnswer = { type: "choice" } & Record<string, unknown>;
export type ScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: number[] };
export type FleetAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;
export type FleetAnswers = Record<string, FleetAnswer>;

/** Raw answer shapes S1 puts on the wire. */
export type WireAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice" } & Record<string, unknown>
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type S1Usage = { input_tokens: number; output_tokens: number };

// ---------------------------------------------------------------------------
// Transport types (structurally compatible with the global fetch)
// ---------------------------------------------------------------------------

export type S1RequestInit = {
  method: "POST" | string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

export type S1Response = {
  /** True for HTTP 2xx. */
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type S1Fetch = (
  url: string,
  init: S1RequestInit,
) => Promise<S1Response>;

// ---------------------------------------------------------------------------
// mapQuestions: our vocabulary -> wire vocabulary (boolean -> noul)
// ---------------------------------------------------------------------------

export type MapQuestionsResult =
  | { ok: true; questions: WireQuestions }
  | { ok: false; error: string };

/**
 * Convert fleet-internal questions into the S1 wire shape. Unknown type tags,
 * missing instructions, and malformed criteria are errors — never silently
 * forwarded.
 */
export function mapQuestions(qs: unknown): MapQuestionsResult {
  if (!isRecord(qs)) return { ok: false, error: "questions must be an object" };
  const out: WireQuestions = {};
  for (const [id, q] of Object.entries(qs)) {
    if (!isRecord(q)) return { ok: false, error: `question ${id}: must be an object` };
    const { instructions } = q;
    if (typeof instructions !== "string" || instructions.trim() === "") {
      return { ok: false, error: `question ${id}: instructions must be a non-empty string` };
    }
    if (q.type === "boolean") {
      // boolean -> noul. criteria is optional on both sides; forward as-is.
      out[id] =
        q.criteria === undefined
          ? { type: "noul", instructions }
          : { type: "noul", instructions, criteria: q.criteria };
    } else if (q.type === "choice") {
      if (!isRecord(q.criteria) || Object.keys(q.criteria).length === 0) {
        return { ok: false, error: `question ${id}: choice criteria must be a non-empty object of option -> description` };
      }
      for (const [opt, desc] of Object.entries(q.criteria)) {
        if (typeof desc !== "string") {
          return { ok: false, error: `question ${id}: choice criterion ${opt} must map to a string description` };
        }
      }
      out[id] = { type: "choice", instructions, criteria: q.criteria as Record<string, string> };
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length === 0 || !q.criteria.every((c) => typeof c === "string")) {
        return { ok: false, error: `question ${id}: score criteria must be a non-empty array of strings` };
      }
      out[id] = { type: "score", instructions, criteria: q.criteria.slice() };
    } else {
      return {
        ok: false,
        error: `question ${id}: unknown type ${JSON.stringify(q.type)} (expected boolean|choice|score)`,
      };
    }
  }
  return { ok: true, questions: out };
}

// ---------------------------------------------------------------------------
// mapAnswers: wire vocabulary -> our vocabulary (noul -> boolean)
// ---------------------------------------------------------------------------

export type MapAnswersResult =
  | { ok: true; answers: FleetAnswers }
  | { ok: false; error: string };

/**
 * Convert S1 wire answers back into fleet answers:
 *  - noul   -> { type: "boolean", probabilityTrue }
 *  - choice -> passed through unchanged
 *  - score  -> probabilities array ordered by the question's criteria order
 *             (the wire carries an index-keyed object: { "0": p0, "1": p1, ... })
 *
 * Errors on unknown ids, unknown answer types, type mismatches against the
 * question, missing/malformed scores, and questions left unanswered — no
 * silent defaults anywhere.
 */
export function mapAnswers(answers: unknown, questions: FleetQuestions): MapAnswersResult {
  if (!isRecord(answers)) return { ok: false, error: "answers must be an object" };
  const out: FleetAnswers = {};
  for (const [id, a] of Object.entries(answers)) {
    const q = questions[id];
    if (!q) return { ok: false, error: `answer ${id}: no such question was asked` };
    if (!isRecord(a) || typeof a.type !== "string") {
      return { ok: false, error: `answer ${id}: must be an object with a "type" field` };
    }
    if (a.type === "noul") {
      if (q.type !== "boolean") return { ok: false, error: `answer ${id}: noul answer but question is ${JSON.stringify(q.type)}` };
      const { noul } = a;
      if (typeof noul !== "number" || !Number.isFinite(noul)) {
        return { ok: false, error: `answer ${id}: noul must be a finite number` };
      }
      out[id] = { type: "boolean", probabilityTrue: noul };
    } else if (a.type === "choice") {
      if (q.type !== "choice") return { ok: false, error: `answer ${id}: choice answer but question is ${JSON.stringify(q.type)}` };
      out[id] = a as ChoiceAnswer;
    } else if (a.type === "score") {
      if (q.type !== "score") return { ok: false, error: `answer ${id}: score answer but question is ${JSON.stringify(q.type)}` };
      const { score, confidence, probabilities } = a;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        return { ok: false, error: `answer ${id}: score.score must be a finite number` };
      }
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
        return { ok: false, error: `answer ${id}: score.confidence must be a finite number` };
      }
      if (!isRecord(probabilities)) {
        return { ok: false, error: `answer ${id}: score.probabilities must be an index-keyed object` };
      }
      const criteria = q.criteria as string[]; // q.type === "score" narrows this
      const arr: number[] = [];
      for (let i = 0; i < criteria.length; i++) {
        const p = probabilities[String(i)];
        if (typeof p !== "number" || !Number.isFinite(p)) {
          return {
            ok: false,
            error: `answer ${id}: score.probabilities is missing index ${i} (criteria order: ${JSON.stringify(criteria)})`,
          };
        }
        arr.push(p);
      }
      const extra = Object.keys(probabilities).filter((k) => !/^\d+$/.test(k) || Number(k) < 0 || Number(k) >= criteria.length);
      if (extra.length > 0) {
        return {
          ok: false,
          error: `answer ${id}: score.probabilities has indices outside criteria range: ${extra.map((k) => JSON.stringify(k)).join(", ")}`,
        };
      }
      out[id] = { type: "score", score, confidence, probabilities: arr };
    } else {
      return { ok: false, error: `answer ${id}: unknown answer type ${JSON.stringify(a.type)}` };
    }
  }
  for (const id of Object.keys(questions)) {
    if (!(id in answers)) return { ok: false, error: `answer ${id}: missing from S1 reply` };
  }
  return { ok: true, answers: out };
}

// ---------------------------------------------------------------------------
// decide: the request/response client
// ---------------------------------------------------------------------------

export interface DecideInput {
  /** Arbitrary state blob handed to S1. */
  state: unknown;
  /** Questions to decide, keyed by id. */
  questions: FleetQuestions;
  /** Model alias (e.g. jev/kev). Defaults to DEFAULT_S1_MODEL. */
  model?: string;
}

export interface DecideOptions {
  /** S1 base URL. Defaults to s1Configured() (FLEET_S1_URL / default port 8009). */
  url?: string;
  /** Injectable transport; tests should pass a fake. Defaults to global fetch. */
  fetch?: S1Fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export type DecideResult =
  | { ok: true; model: string; answers: FleetAnswers; usage: S1Usage }
  | { ok: false; error: string };

/**
 * Ask S1 to answer the given questions about `state`. Pure orchestration:
 * maps questions to the wire shape, POSTs, maps answers back, and surfaces
 * transport/HTTP/mapping failures as { ok: false, error } — never throws.
 */
export async function decide(input: DecideInput, opts: DecideOptions = {}): Promise<DecideResult> {
  const mappedQuestions = mapQuestions(input.questions);
  if (!mappedQuestions.ok) return { ok: false, error: mappedQuestions.error };

  const base = stripTrailingSlash(opts.url ?? s1Configured());
  const url = `${base}/v1/systemone`;
  const doFetch: S1Fetch | undefined = opts.fetch ?? (globalThis as { fetch?: S1Fetch }).fetch;
  if (!doFetch) return { ok: false, error: "S1: no fetch transport available (pass opts.fetch)" };

  const body = JSON.stringify({
    model: input.model ?? DEFAULT_S1_MODEL,
    state: input.state,
    questions: mappedQuestions.questions,
  });

  const ctrl = new AbortController();
  const bound = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, bound);
  let res: S1Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: describeTransportFailure(e, { timedOut, boundMs: bound, elapsedMs: Date.now() - t0, origin: originOf(base) }) };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { ok: false, error: await describeHttpFailure(res, Date.now() - t0) };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (e) {
    return { ok: false, error: `S1 reply is not valid JSON: ${errorMessage(e)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: "S1 reply must be a JSON object" };

  const { model, answers, usage } = parsed;
  if (typeof model !== "string" || model.trim() === "") {
    return { ok: false, error: "S1 reply: model must be a non-empty string" };
  }
  if (!isRecord(usage)) {
    return { ok: false, error: "S1 reply: usage must be an object" };
  }
  const { input_tokens, output_tokens } = usage;
  if (!isFiniteNumber(input_tokens) || !isFiniteNumber(output_tokens)) {
    return { ok: false, error: "S1 reply: usage.input_tokens and usage.output_tokens must be finite numbers" };
  }
  const mappedAnswers = mapAnswers(answers, input.questions);
  if (!mappedAnswers.ok) return { ok: false, error: mappedAnswers.error };

  return {
    ok: true,
    model,
    answers: mappedAnswers.answers,
    usage: { input_tokens, output_tokens },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Base URL for the S1 service. Override with FLEET_S1_URL on the gateway
 * host; the default is the loopback deployment (gateway-only service).
 */
export function s1Configured(env: Record<string, string | undefined> = process.env): string {
  const raw = env.FLEET_S1_URL?.trim();
  return raw ? stripTrailingSlash(raw) : DEFAULT_S1_URL;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** scheme://host[:port] only: never the path or query, which may carry tokens (issue #311). */
export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return "the configured S1 endpoint"; }
}

/**
 * Name the CONDITION, not the transport (issue #311): "This operation was aborted" describes an AbortController, and
 * a timeout, a refused connection and a DNS failure all used to surface as one "S1 request failed" string that sent
 * the operator after the wrong cause. The stable prefixes (`S1 timed out`, `S1 unreachable`, `S1 request failed`)
 * are what fallbackReason consumers and tests match on.
 */
export function describeTransportFailure(e: unknown, ctx: { timedOut: boolean; boundMs: number; elapsedMs: number; origin: string }): string {
  if (ctx.timedOut) return `S1 timed out after ${ctx.boundMs}ms (elapsed ${ctx.elapsedMs}ms) at ${ctx.origin}`;
  const code = String((e as { cause?: { code?: unknown }; code?: unknown } | undefined)?.cause?.code ?? (e as { code?: unknown } | undefined)?.code ?? "");
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) {
    return `S1 unreachable at ${ctx.origin} (${code})`;
  }
  return `S1 request failed: ${errorMessage(e)}`;
}

/** HTTP failure: 4xx names the status AND the endpoint's own validation text (redacted, bounded); 5xx says the server failed. */
export async function describeHttpFailure(res: S1Response, elapsedMs: number): Promise<string> {
  let detail = "";
  try {
    const body = await res.json();
    const pick = isRecord(body) ? (body.detail ?? body.error ?? body.message ?? body) : body;
    detail = typeof pick === "string" ? pick : JSON.stringify(pick);
  } catch { /* no/invalid body: the status alone */ }
  const clip = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 300);
  if (res.status >= 500) return `S1 server error: HTTP ${res.status}${clip ? ` ${clip}` : ""} (elapsed ${elapsedMs}ms)`;
  return `S1 rejected the request: HTTP ${res.status}${clip ? ` ${clip}` : ""}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}