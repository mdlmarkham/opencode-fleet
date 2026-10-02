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
  "Launch ack timed out, but the run IS on the node (probe confirmed). Poll with fleet_run_status/fleet_watch; do NOT re-dispatch.";
export const ACK_ABSENT_NOTE =
  "Launch was NOT confirmed AND no run was found on the node. Safe to re-dispatch.";
export const ACK_INCONCLUSIVE_NOTE =
  "Launch was not confirmed: probe inconclusive — verify with fleet_run_status before re-dispatching.";

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

/**
 * Issue #30 finding I: interpret the engine-independent liveness probe output.
 * The recorded pid (when given) is confirmed by its PIDALIVE marker; otherwise
 * ANY matching opencode/pi process line means the run is alive.
 */
export function interpretLiveness(
  procPart: string,
  pid?: number,
): { alive: boolean; procs: string[] } {
  const pidAlive =
    pid !== undefined && new RegExp(`PIDALIVE\\s+${pid}\\b`).test(procPart);
  const procs = procPart
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("PIDALIVE"));
  return { alive: pidAlive || procs.length > 0, procs };
}
