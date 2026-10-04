/**
 * Wire protocol of the `opencode.run` node command (issue #43).
 *
 * Historically a control operation was encoded in the user-facing `prompt`
 * field as a `__SENTINEL__` string, so a task prompt could collide with a
 * control message and every consumer had to special-case placeholders. The
 * request now carries an explicit `op`; the sentinel remains only as a
 * compatibility encoding for nodes that predate this protocol, and the two
 * must agree when both are present.
 *
 *   protocol 0  nodes without this field (sentinel prompts only)
 *   protocol 1  `op` + `protocol` on requests; `protocol` echoed on every response
 *   protocol 2  adds the post-run verification gate (`expect`); a node below 2 would
 *               silently ignore it and report an apparently gated run as ungated
 *   protocol 3  adds the `state.prune` op; an older node would take its sentinel for
 *               an ordinary task prompt, so the gateway must not send it below 3
 *   protocol 4  adds per-run `isolation`; a node below 4 would run the task in the SHARED
 *               checkout, silently dropping the isolation the caller asked for
 */

export const PROTOCOL_VERSION = 4;

/** Ops that only a node of at least this protocol understands (absent = any node). */
export const OP_MIN_PROTOCOL: Readonly<Record<string, number>> = { "state.prune": 3 };

/** Minimum node protocol an op itself needs, with a label for refusal messages. */
export function requiredProtocolForOp(op: string): { version: number; feature?: string } {
  const version = OP_MIN_PROTOCOL[op] ?? 0;
  return version > 0 ? { version, feature: `op ${op}` } : { version: 0 };
}

/** Minimum node protocol a request feature needs; a node below it would silently ignore the field. */
export const FEATURE_MIN_PROTOCOL = { harness: 1, expect: 2, isolation: 4 } as const;

/**
 * The lowest node protocol that can honor every non-default feature on this
 * request (0 when it uses none). Only launching ops carry such features.
 */
export function requiredProtocol(task: { harness?: unknown; expect?: unknown; isolation?: unknown }): { version: number; feature?: string } {
  let version = 0;
  let feature: string | undefined;
  if (typeof task.harness === "string" && task.harness && task.harness !== "opencode") {
    version = FEATURE_MIN_PROTOCOL.harness;
    feature = `harness "${task.harness}"`;
  }
  if (task.expect !== undefined && task.expect !== null && FEATURE_MIN_PROTOCOL.expect > version) {
    version = FEATURE_MIN_PROTOCOL.expect;
    feature = "the verification gate (expect)";
  }
  if (typeof task.isolation === "string" && task.isolation !== "none" && FEATURE_MIN_PROTOCOL.isolation > version) {
    version = FEATURE_MIN_PROTOCOL.isolation;
    feature = `per-run isolation "${task.isolation}"`;
  }
  return { version, feature };
}

/** Sentinel prompt -> op. Anything else is an ordinary task prompt (op "run"). */
export const SENTINEL_OPS = {
  __ABORT__: "abort",
  __DIFF__: "diff",
  __MODELS__: "models",
  __ACTIVITY__: "activity",
  __STATUS__: "status",
  __BUNDLE__: "bundle",
  __RECEIVE__: "xfer.receive",
  __SEND_CHUNK__: "xfer.send",
  __UNPACK__: "xfer.unpack",
  __RECEIVE_CLEAN__: "xfer.clean",
  __RUN_START__: "run.start",
  __RUN_STATUS__: "run.status",
  __RUN_RESULT__: "run.result",
  __PRUNE__: "state.prune",
} as const;

export type SentinelPrompt = keyof typeof SENTINEL_OPS;
export type Op = (typeof SENTINEL_OPS)[SentinelPrompt] | "run";

const SENTINEL_BY_OP = Object.fromEntries(Object.entries(SENTINEL_OPS).map(([k, v]) => [v, k])) as Record<string, SentinelPrompt>;
const KNOWN_OPS = new Set<string>(["run", ...Object.values(SENTINEL_OPS)]);

export function isSentinelPrompt(prompt: unknown): prompt is SentinelPrompt {
  return typeof prompt === "string" && Object.prototype.hasOwnProperty.call(SENTINEL_OPS, prompt);
}

/** The op a legacy prompt encodes. */
export function opFromPrompt(prompt: string): Op {
  return isSentinelPrompt(prompt) ? SENTINEL_OPS[prompt] : "run";
}

/** The sentinel a control op travels as on a protocol-0 node. */
export function sentinelForOp(op: Op): SentinelPrompt | undefined {
  return SENTINEL_BY_OP[op];
}

export type ResolvedOp = { ok: true; op: Op } | { ok: false; error: string };

/**
 * Resolve the op of a request. With no `op` the prompt decides (legacy). With
 * an `op` it must be known AND agree with the prompt: a task prompt that merely
 * looks like a control message can never be promoted to one, and a control
 * message can never be smuggled in under op "run".
 */
export function resolveOp(task: { op?: unknown; protocol?: unknown; prompt: string }): ResolvedOp {
  // Issue #61: `protocol` on a request is the MINIMUM node protocol the request
  // needs (the gateway stamps it only for features an older node would silently
  // ignore, after discovery). A node refuses what it cannot honor, loudly. Only
  // an ABSENT value (a legacy gateway, a plain run, the discovery probe) is lenient.
  if (task.protocol !== undefined) {
    if (typeof task.protocol !== "number" || !Number.isInteger(task.protocol) || task.protocol < 0) {
      return { ok: false, error: `invalid protocol: ${JSON.stringify(String(task.protocol).slice(0, 20))}` };
    }
    if (task.protocol > PROTOCOL_VERSION) {
      return { ok: false, error: `request needs protocol ${task.protocol}, newer than this node's protocol ${PROTOCOL_VERSION}; upgrade the node plugin` };
    }
  }
  const fromPrompt = opFromPrompt(task.prompt);
  if (task.op === undefined || task.op === null) return { ok: true, op: fromPrompt };
  if (typeof task.op !== "string" || !KNOWN_OPS.has(task.op)) return { ok: false, error: `unknown op: ${JSON.stringify(String(task.op).slice(0, 40))}` };
  if (task.op !== fromPrompt) {
    return { ok: false, error: `op ${task.op} does not match the request prompt (${fromPrompt === "run" ? "an ordinary task prompt" : fromPrompt})` };
  }
  return { ok: true, op: task.op as Op };
}

/** Stamp a JSON result string with the protocol version. */
export function stampProtocol(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, protocol: PROTOCOL_VERSION });
    }
  } catch {
    /* not JSON: leave as is */
  }
  return result;
}

/** Protocol version a node reported in a result payload (0 when absent: a pre-protocol node). */
export function nodeProtocolOf(payload: unknown): number {
  const p = typeof payload === "string" ? safeParse(payload) : payload;
  const v = (p as { protocol?: unknown } | undefined)?.protocol;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
