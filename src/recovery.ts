/**
 * Ack-recovery probe decision (issue #30 finding E).
 *
 * When a detached launch ack times out, the manager must decide whether the
 * run IS on the node (do NOT re-dispatch) or whether it definitively never
 * started (safe to re-dispatch). The old inline logic treated ANY hint
 * (`probe.pid || probe.state || probe.alive === true || probe.status ===
 * "cleaned"`) as confirmation, so an ambiguous "cleaned"/never-started probe
 * could be reported as a live run. It also probed with the caller's signal and
 * reported "Safe to re-dispatch." even when the probe THREW — an inconclusive
 * probe read as a negative.
 *
 * This module extracts the decision into pure, unit-testable functions so the
 * allow-list and the three-outcome contract are explicit.
 */

/** Decision derived from a single `__RUN_STATUS__` probe payload. */
export type ProbeVerdict = "running" | "finished" | "aborted" | "absent" | "inconclusive";

/** What the ack-recovery step concluded. */
export interface AckRecoveryOutcome {
  /** confirmed = run exists; absent = definitively never started; inconclusive = unknown. */
  kind: "confirmed" | "absent" | "inconclusive";
  verdict: ProbeVerdict;
  /** Whether a probe invoke was actually attempted. */
  probed: boolean;
  state?: string;
  pid?: number;
  note: string;
}

/** Fresh, timeout-ONLY budget for the recovery probe (never the caller's signal). */
export const ACK_PROBE_TIMEOUT_MS = 20_000;

export const ACK_CONFIRMED_NOTE =
  "Launch ack timed out, but the run IS on the node (probe confirmed). Wait with fleet_await (not a fleet_run_status loop; if your tool list lacks it your session predates a plugin update, so start a new session) or fleet_watch; do NOT re-dispatch.";
export const ACK_ABSENT_NOTE =
  "Launch was NOT confirmed AND no run was found on the node. Safe to re-dispatch.";
export const ACK_INCONCLUSIVE_NOTE =
  "Launch was not confirmed: probe inconclusive — verify with fleet_run_status before re-dispatching.";

/**
 * Issue #256: the exact post-restart transient error, as the node/relay emits it. Narrow on
 * purpose — the retry must fire only for this specific condition, never a general error.
 */
export const PUBLICATION_TRANSIENT_PHRASE = "current worker publication";

/** Bounded pause before the single retry: long enough for the publication, short enough not to stall. */
export const PUBLICATION_RETRY_DELAY_MS = 2_000;

/**
 * Narrow match: does this error text mention the exact transient phrase (case-insensitive)?
 * Pure; the caller checks BOTH channels (a node-returned error string AND a relay-throw message).
 */
export function isWorkerPublicationTransient(errText: unknown): boolean {
  return typeof errText === "string" && errText.toLowerCase().includes(PUBLICATION_TRANSIENT_PHRASE);
}

/** Abortable bounded delay for the single retry (never leaves a pending timer on abort). */
export function publicationRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Extract the parsed payload object from a node invoke result. */
function payloadOf(inv: unknown): Record<string, unknown> {
  const payload = (inv as { payload?: unknown }).payload;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return ((payload as Record<string, unknown> | undefined) ?? {});
}

/**
 * Pure decision: map a `__RUN_STATUS__` probe payload to a verdict.
 *
 * ALLOW-LIST of positive states — ONLY `running`/`finished`/`aborted` (or a
 * truthy non-zero `pid`, or `alive === true`) count as CONFIRMED.
 * `never-started`, `unknown`, absent, or `status:"cleaned"` with no pid/state
 * MUST NOT count as confirmed.
 *
 * `probe.ok === false`: ONLY an EXPLICIT absence signal counts as `absent`.
 * The node handler emits `status:"never-started"` solely when no run state AND
 * no launcher artifacts exist — the run definitively never started. Anything
 * else negative (`status:"cleaned"`, or a missing/unknown status on a generic
 * relay/command error) is NOT proof of absence and MUST be `inconclusive`
 * (issue #30 finding E: a generic `{ok:false}` was being read as proof the run
 * never started, so an ambiguous error said "Safe to re-dispatch.").
 */
export function interpretProbe(probe: unknown): ProbeVerdict {
  if (!probe || typeof probe !== "object") return "inconclusive";
  const p = probe as Record<string, unknown>;
  const state = typeof p.state === "string" ? p.state : undefined;
  const status = typeof p.status === "string" ? p.status : undefined;
  const pid = typeof p.pid === "number" && Number.isFinite(p.pid) && p.pid > 0 ? p.pid : undefined;
  const alive = p.alive === true;

  if (p.ok === false) {
    // ONLY an explicit "never-started" is a definitive absence. The node emits
    // it when no run state and no launcher artifacts exist (truly missing run).
    if (status === "never-started") return "absent";
    // "cleaned" means launcher artifacts (script/log) exist — the run DID start,
    // so it is NOT a definitive absence. A missing/unknown status is a generic
    // relay/command error, not a never-started claim. Both are inconclusive.
    return "inconclusive";
  }

  // Positive allow-list ONLY.
  if (state === "running") return "running";
  if (state === "finished") return "finished";
  if (state === "aborted") return "aborted";
  if (pid !== undefined) return "running";
  if (alive) return "running";

  // No positive evidence — never confirm. Unknown/absent/cleaned-without-pid.
  return "inconclusive";
}

/**
 * Run the ack-recovery probe with a FRESH timeout-only AbortSignal and decide.
 * `invokeProbe` is the node invoke (injectable for tests) and receives the
 * fresh signal — the caller's (possibly already-aborted) signal is never used.
 */
export async function probeAckRecovery(
  invokeProbe: (signal: AbortSignal) => Promise<unknown>,
): Promise<AckRecoveryOutcome> {
  const signal = AbortSignal.timeout(ACK_PROBE_TIMEOUT_MS);
  let inv: unknown;
  try {
    inv = await invokeProbe(signal);
  } catch {
    // Probe threw (relay error, node down): INCONCLUSIVE, never "safe".
    return { kind: "inconclusive", verdict: "inconclusive", probed: true, note: ACK_INCONCLUSIVE_NOTE };
  }
  if (inv && typeof inv === "object" && (inv as { invokeTimedOut?: boolean }).invokeTimedOut === true) {
    // Probe itself timed out: INCONCLUSIVE.
    return { kind: "inconclusive", verdict: "inconclusive", probed: true, note: ACK_INCONCLUSIVE_NOTE };
  }

  const probe = payloadOf(inv);
  const verdict = interpretProbe(probe);

  if (verdict === "running" || verdict === "finished" || verdict === "aborted") {
    return {
      kind: "confirmed",
      verdict,
      probed: true,
      state: typeof probe.state === "string" ? probe.state : typeof probe.status === "string" ? probe.status : undefined,
      pid: typeof probe.pid === "number" ? probe.pid : undefined,
      note: ACK_CONFIRMED_NOTE,
    };
  }
  if (verdict === "absent") {
    return { kind: "absent", verdict, probed: true, note: ACK_ABSENT_NOTE };
  }
  return { kind: "inconclusive", verdict, probed: true, note: ACK_INCONCLUSIVE_NOTE };
}

/**
 * Issue #30 finding H: a run may only be recorded `aborted` when its
 * termination is CONFIRMED. Returns the state object to write, or null to
 * leave the existing file untouched (never claim aborted for a possibly-live
 * run). Existing fields (harness/piModel/pid/startedAt) are PRESERVED so later
 * __RUN_STATUS__/__RUN_RESULT__ reads still parse correctly.
 */
export function abortStateWrite(
  existing: Record<string, unknown>,
  confirmed: boolean,
  finishedAt: string,
): Record<string, unknown> | null {
  if (!confirmed) return null;
  return { ...existing, state: "aborted", finishedAt };
}

/** Marker emitted by the probe when the recorded pid answers `kill -0`. */
const PID_ALIVE = "PIDALIVE";
/** Marker emitted by the probe for `/proc/<pid>/cmdline`; empty when the pid has vanished or is unreadable. */
export const CMDLINE = "CMDLINE";

/**
 * The probe transcript emits `CMDLINE <sanitized cmdline>` (one line, the
 * cmdline's NUL separators flattened to spaces) for the recorded pid. Extract
 * it; a missing or EMPTY marker (vanished pid, unreadable /proc) yields
 * undefined — no identity evidence either way, never a false match.
 */
export function cmdlineOf(procPart: string): string | undefined {
  for (const line of procPart.split("\n")) {
    const l = line.trim();
    if (l.startsWith(`${CMDLINE} `)) {
      const cmdline = l.slice(CMDLINE.length).trim();
      return cmdline.length ? cmdline : undefined;
    }
  }
  return undefined;
}

/**
 * TASK #103d (issue #103): the pid+identity test. A RECORDED pid counts as the
 * run's process only if the identity hint (its runId) appears in the cmdline.
 * pid reuse — the old run dead, the pid recycled by an unrelated process —
 * leaves the hint absent, so the recycled process never counts. The hint is
 * the launch script path's embedded `runId` (`runScriptPath(runId)`), which is
 * unguessable (issue #32), and the cmdline is sanitized before it is carried
 * back over ssh (NULs → spaces), so a plain substring test is the right,
 * injection-free comparison.
 */
export function pidMatchesHint(cmdline: string | undefined, hint: string | undefined): boolean {
  if (cmdline === undefined) return false;
  if (hint === undefined) return false;
  return cmdline.includes(hint);
}

/**
 * Issue #30 finding I + TASK #103d: interpret the engine-independent liveness
 * probe output. Decision rule:
 *  - recorded pid + NO hint: exactly today's (issue #30) behavior — the
 *    PIDALIVE marker or ANY opencode/pi name line means alive (regression
 *    guard for hint-less callers),
 *  - recorded pid + hint (the run's runId): pid+identity ONLY — the pid must
 *    answer `kill -0` AND its /proc cmdline must carry the hint; name-grep
 *    lines are ignored (a reused pid or a dead run cannot borrow an unrelated
 *    opencode/pi process to fake liveness),
 *  - no recorded pid: name matching only (issue #30, preserved exactly).
 */
export function interpretLiveness(
  procPart: string,
  pid?: number,
  hint?: string,
): { alive: boolean; procs: string[] } {
  const pidAlive =
    pid !== undefined && new RegExp(`${PID_ALIVE}\\s+${pid}\\b`).test(procPart);
  const procs = procPart
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(PID_ALIVE) && !l.startsWith(CMDLINE));
  if (pid !== undefined) {
    if (hint === undefined) return { alive: pidAlive || procs.length > 0, procs };
    if (!pidAlive) return { alive: false, procs };
    return { alive: pidMatchesHint(cmdlineOf(procPart), hint), procs };
  }
  return { alive: procs.length > 0, procs };
}
