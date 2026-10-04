/**
 * S1 shadow dispatch evidence — issue #87, slice 4.
 *
 * A SHADOW-ONLY live call site for the S1 decision layer on `fleet_dispatch`.
 * It records what S1 WOULD have said about a dispatch and acts on NOTHING:
 *
 *   - IMPOSSIBLE to enforce: nothing here (or in the wiring) imports
 *     `combineWithStatic` or reads a decision back; the record goes to a log
 *     file and is never consulted by any dispatch decision. S1 is evidence,
 *     never permission (#66).
 *   - Fire-and-forget: the dispatch never awaits the shadow call on its
 *     critical path, and the shadow path CATCHES everything — a broken S1,
 *     a throwing decider, even a failing log sink can never break a dispatch
 *     or appear in its result.
 *   - Opt-in by config: the wiring guards on the `s1` config block itself, so
 *     with NO `s1` block the shadow module is not even imported — the default
 *     dispatch stays byte-identical to today.
 *   - No new node op, no tool-schema change: the log lives on the manager,
 *     next to the ledger, under the manager rootDir.
 *
 * Logs: `<rootDir>/.opencode-fleet/s1-shadow.jsonl` — one JSON object per
 * line, written with the same private+atomic style as the ledger and run
 * state (temp file 0600 in the same directory, renamed over the target).
 */

import { mkdir, readFile, appendFile, stat, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivate } from "./paths.js";
import { makeDecider, parseS1Config, type AuditSink } from "./decision-backends.js";
import type { DecideInput, DecideOptions, FleetQuestion, S1Fetch } from "./decision.js";

// ---------------------------------------------------------------------------
// Questions / log layout
// ---------------------------------------------------------------------------

/** The task-text directory the shadow log lives in, under the manager rootDir. */
export const SHADOW_LOG_DIRNAME = ".opencode-fleet";
export const SHADOW_LOG_FILENAME = "s1-shadow.jsonl";

/** questionId used for the one shadow decision fired per fleet_dispatch. */
export const DISPATCH_ROUTE_QUESTION_ID = "dispatch.route";
/** Candidate engines scored for DISPATCH_ROUTE_QUESTION_ID, in criteria order. */
export const DISPATCH_ROUTE_CANDIDATES: readonly string[] = ["opencode", "pi"];

/** The shadow log path for a manager rootDir. */
export function s1ShadowLogPath(rootDir: string = process.cwd()): string {
  return join(rootDir || process.cwd(), SHADOW_LOG_DIRNAME, SHADOW_LOG_FILENAME);
}

// ---------------------------------------------------------------------------
// The default sink: append one JSON line per entry, privately and atomically
// ---------------------------------------------------------------------------

/**
 * A sink for shadow entries. Accepts any record; it is serialized to one JSON
 * line. Both the audit sink shape (Decision-backends `AuditSink`) and the
 * dispatch-record shape below fit this.
 */
export type ShadowSink = (entry: object) => void | Promise<void>;

const appendChains = new Map<string, Promise<void>>();

async function appendJsonLineOnce(path: string, entry: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(path);
  // Issue #102: APPEND, do not read-modify-write. The old form read the whole
  // file and rewrote it (temp+rename) on every dispatch — O(n) per append and
  // unbounded. A single line-sized appendFile is atomic enough and O(1).
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Issue #102: default size cap before rotation (bytes) and files kept. */
export const SHADOW_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const SHADOW_LOG_KEEP = 3;

/** Overridable via ShadowLogOptions (tests, operator config). */
export interface ShadowLogOptions {
  maxBytes?: number;
  keep?: number;
}

let shadowLogOpts: ShadowLogOptions = {};
/** Set process-wide rotation bounds (from `s1` config). */
export function setShadowLogOptions(opts: ShadowLogOptions): void {
  shadowLogOpts = { ...opts };
}

/**
 * Rotate `path` -> `path.1` -> `path.2` ... when it exceeds maxBytes, keeping
 * `keep` rotated files. Best-effort: a rotation failure must not lose the append.
 */
async function rotateIfNeeded(path: string): Promise<void> {
  const cap = typeof shadowLogOpts.maxBytes === "number" && shadowLogOpts.maxBytes > 0 ? shadowLogOpts.maxBytes : SHADOW_LOG_MAX_BYTES;
  const keep = typeof shadowLogOpts.keep === "number" && shadowLogOpts.keep >= 0 ? shadowLogOpts.keep : SHADOW_LOG_KEEP;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return; // no existing file -> nothing to rotate
  }
  if (size < cap) return;
  try {
    // drop the oldest, then shift each down, then move the live file to .1
    if (keep === 0) {
      await rm(path, { force: true });
      return;
    }
    await rm(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      try {
        await rename(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        /* that generation may not exist */
      }
    }
    await rename(path, `${path}.1`);
  } catch {
    /* best-effort: if rotation fails we still append to the live file */
  }
}
/**
 * Serialize all appends to one path (in-process). Issue #102: two gateway
 * processes sharing a rootDir can still interleave, but a single line-sized
 * appendFile is far narrower than the old read-modify-write, and each writes a
 * complete line, so a shared file loses at most ordering, never content.
 */
function appendJsonLine(path: string, entry: object): Promise<void> {
  const prev = appendChains.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => appendJsonLineOnce(path, entry));
  appendChains.set(path, next);
  return next;
}

/**
 * The default sink: append each entry to `<rootDir>/.opencode-fleet/s1-shadow.jsonl`
 * as one JSON line. NEVER throws (and never rejects): a logging failure is
 * swallowed — evidence collection must never surface to a caller.
 */
export function shadowFileSink(rootDir?: string): ShadowSink {
  const path = s1ShadowLogPath(rootDir);
  return async (entry: object): Promise<void> => {
    try {
      await appendJsonLine(path, entry);
    } catch {
      /* the log is best-effort; it must never throw into a caller */
    }
  };
}

// ---------------------------------------------------------------------------
// buildShadowDecider: the opt-in gate + the (injectable) decider
// ---------------------------------------------------------------------------

/** Structural minimum shadowRecord calls: deciders built by makeDecider fit. */
export type DeciderLike = (input: DecideInput, opts?: DecideOptions) => Promise<unknown>;

export interface ShadowDeps {
  /** Injectable audit sink (tests capture; default is the shadow log file). */
  sink?: AuditSink;
  /** Injectable pre-built decider (tests bypass makeDecider entirely). */
  decider?: DeciderLike;
  /** Injectable S1 transport for the built decider (tests; no network). */
  fetch?: S1Fetch;
  now?: () => number;
  /** Manager rootDir for the default shadow log path. Default process.cwd(). */
  rootDir?: string;
}

/** Issue #102: warn ONCE per process when an `s1` config is present but invalid. */
let warnedInvalidConfig = false;

/** Test hook: reset the once-per-process warning latch. */
export function resetShadowConfigWarning(): void {
  warnedInvalidConfig = false;
}

/**
 * Build the shadow decider for the plugin's `s1` config, or `undefined` when
 * S1 is disabled for shadow purposes:
 *   - `parseS1Config(cfgS1)` fails (invalid config) => undefined (and one warning);
 *   - the parsed mode is `off`                      => undefined.
 * Otherwise returns `makeDecider(config, { sink })` where the sink defaults to
 * appending one JSON line to `<rootDir>/.opencode-fleet/s1-shadow.jsonl` and
 * is injectable for tests. NEVER throws.
 */
export function buildShadowDecider(cfgS1: unknown, deps: ShadowDeps = {}): DeciderLike | undefined {
  try {
    const parsed = parseS1Config(cfgS1);
    if (!parsed.ok) {
      // Issue #102: an invalid config used to disable shadow SILENTLY, so the
      // operator assumed evidence was being collected. Warn once, naming the error.
      if (cfgS1 !== undefined && cfgS1 !== null && !warnedInvalidConfig) {
        warnedInvalidConfig = true;
        console.warn(`[opencode-fleet] s1 config is present but invalid; shadow evidence is NOT being collected: ${parsed.error}`);
      }
      return undefined;
    }
    if (parsed.config.mode === "off") return undefined;
    if (deps.decider) return deps.decider;
    return makeDecider(parsed.config, {
      sink: deps.sink ?? shadowFileSink(deps.rootDir),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// shadowRecord: wrap a decider call, catch everything, return a bounded record
// ---------------------------------------------------------------------------

/** One shadow question for a decision. */
export interface ShadowDecisionRequest {
  questionId: string;
  /** State blob handed to S1 (kept out of the record; rides to S1 only). */
  state?: unknown;
  question: FleetQuestion;
}

/** The bounded record shadowRecord returns for logging — never throws. */
export interface ShadowEntry {
  kind: "s1-shadow";
  ts: string;
  questionId: string;
  ok: boolean;
  answer?: unknown;
  error?: string;
  meta?: unknown;
}

export interface ShadowRecordOpts {
  /** Optional destination for the entry; a throwing sink is swallowed. */
  sink?: ShadowSink;
  now?: () => number;
  /** Injectable transport passed through to the decider call. */
  fetch?: S1Fetch;
  /** Max serialized chars for the answer/error/meta in the record. */
  maxChars?: number;
}

/** Default bound for a record's serialized parts (bounded record, bounded log). */
export const SHADOW_RECORD_MAX_CHARS = 4000;

/**
 * Wrap ONE decider call: ask S1 the single question, catch EVERYTHING (a
 * throwing or non-function decider, a malformed result, a failing sink) and
 * return a bounded record `{ ok, answer?, error?, meta }`. The caller never
 * sees a throw and the record never carries unbounded data. Shadow-only:
 * nothing here decides anything — the record is for logging.
 */
export async function shadowRecord(
  decider: DeciderLike,
  req: ShadowDecisionRequest,
  opts: ShadowRecordOpts = {},
): Promise<ShadowEntry> {
  const maxChars = typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? opts.maxChars
    : SHADOW_RECORD_MAX_CHARS;
  const questionId = req && typeof req.questionId === "string" && req.questionId !== "" ? req.questionId : "unknown";
  const question = (req && typeof (req as ShadowDecisionRequest).question === "object" && (req as ShadowDecisionRequest).question !== null
    ? (req as ShadowDecisionRequest).question
    : { type: "boolean", instructions: "Shadow decision requested without a question body." }) as FleetQuestion;
  const input: DecideInput = {
    state: req && typeof req === "object" && "state" in req ? req.state : {},
    questions: { [questionId]: question },
  };
  const entry: ShadowEntry = {
    kind: "s1-shadow",
    ts: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    questionId,
    ok: false,
  };
  try {
    if (typeof decider !== "function") throw new Error("decider is not a function");
    const decOpts: DecideOptions = opts.fetch ? { fetch: opts.fetch } : {};
    const raw = await decider(input, decOpts);
    const r = raw as
      | { ok?: unknown; answers?: unknown; error?: unknown; meta?: unknown }
      | undefined;
    if (raw === null || raw === undefined || typeof raw !== "object") {
      entry.error = "S1 decision unavailable";
      entry.meta = { threw: false, note: "decider returned nothing usable" };
    } else if (r?.ok === true) {
      entry.ok = true;
      if (typeof r.answers === "object" && r.answers !== null && questionId in (r.answers as object)) {
        entry.answer = bounded((r.answers as Record<string, unknown>)[questionId], maxChars);
      }
      if (r.meta !== undefined) entry.meta = bounded(r.meta, maxChars);
    } else {
      entry.error = typeof r?.error === "string" ? boundedText(r.error, maxChars) : "S1 decision unavailable";
      if (r?.meta !== undefined) entry.meta = bounded(r.meta, maxChars);
    }
  } catch (e) {
    // A throwing decider is recorded as an error; it can never reach the caller.
    const msg = e instanceof Error ? e.message : String(e);
    entry.error = boundedText(`decider threw: ${msg}`, maxChars);
    entry.meta = bounded({ threw: true }, maxChars);
  }
  try {
    await opts.sink?.(entry);
  } catch {
    /* a failing log sink must never break the shadow record */
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Fire-and-forget plumbing: tracked promises so tests can drain deterministically
// ---------------------------------------------------------------------------

const trackedShadow = new Set<Promise<unknown>>();

/**
 * Track a fire-and-forget shadow promise (and defuse any rejection) so tests
 * can `drainShadowDecisions()` instead of sleeping. Never throws.
 */
export function trackShadow(p: Promise<unknown>): Promise<unknown> {
  const guarded = p.catch(() => undefined);
  trackedShadow.add(guarded);
  void guarded.then(() => {
    trackedShadow.delete(guarded);
  });
  return guarded;
}

/** Await every tracked shadow decision (for tests only). */
export async function drainShadowDecisions(turns = 4): Promise<void> {
  // Turns cover async chains that register more promises (import -> build ->
  // record); every tracked promise is guarded so these always settle.
  for (let i = 0; i < Math.max(1, turns); i++) {
    await Promise.all(Array.from(trackedShadow));
  }
}

export interface ShadowDispatchRequest {
  /** The task text (rendered spec or flat prompt). */
  task?: unknown;
  /** The dispatch cwd on the node(s). */
  cwd?: unknown;
}

export interface ShadowRecordDeps {
  /** Injectable pre-built decider (tests bypass buildShadowDecider entirely). */
  decider?: DeciderLike;
}

/**
 * The live wiring entry point (used by index.ts fleet_dispatch): fire ONE
 * shadow decision for this dispatch — questionId `dispatch.route`, a score
 * question over the fleet's harness candidates, the task text in state —
 * and append the bounded record to the shadow log. FIRE-AND-FORGET and never
 * awaited on the dispatch's critical path; catches everything; logs via the
 * decider's own audit line + the record's sink, both to the same file. When
 * the decider is undefined (s1 off/invalid) it does nothing at all.
 */
export function recordDispatchShadow(
  cfgS1: unknown,
  req: ShadowDispatchRequest,
  rootDir?: string,
  deps?: ShadowRecordDeps,
): void {
  const p = (async () => {
    try {
      // Issue #102: ONE record per dispatch. The decider's own audit sink and the
      // shadow record both used to write a line per dispatch (a `decision` entry
      // plus an `s1-shadow` entry). Give the decider a no-op audit sink here so
      // only the single bounded shadow record is written.
      const decider = buildShadowDecider(cfgS1, {
        ...(rootDir ? { rootDir } : {}),
        ...(deps?.decider ? { decider: deps.decider } : {}),
        sink: () => Promise.resolve(),
      });
      if (!decider) return; // S1 off/invalid for shadow purposes: do nothing
      const candidates = DISPATCH_ROUTE_CANDIDATES.slice();
      const task = typeof req?.task === "string" ? req.task : "";
      await shadowRecord(
        decider,
        {
          questionId: DISPATCH_ROUTE_QUESTION_ID,
          state: { spec: task, cwd: typeof req?.cwd === "string" ? req.cwd : "", candidates },
          question: {
            type: "score",
            instructions:
              "Score each candidate engine for fit against this dispatch task; the top-scored candidate is the " +
              "engine the manager would pick for routing. " +
              `Spec: ${task}. Candidates, in criteria order: ${candidates.join(", ")}.`,
            criteria: candidates,
          },
        },
        { sink: shadowFileSink(rootDir) },
      );
    } catch {
      /* the shadow path can never break dispatch */
    }
  })();
  trackShadow(p);
}

// ---------------------------------------------------------------------------
// Bounding helpers
// ---------------------------------------------------------------------------

function boundedText(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}

function bounded(v: unknown, cap: number): unknown {
  if (typeof v === "string") return boundedText(v, cap);
  let s: string;
  try {
    s = JSON.stringify(v) ?? "";
  } catch {
    return "<unserializable>";
  }
  return s.length <= cap ? v : { truncated: boundedText(s, cap) };
}