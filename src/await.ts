/**
 * fleet_await (issue #180): wait for a SET of detached runs in one call instead of an agent
 * polling `fleet_run_status` in a loop. The polling happens here, on a backoff, inside the plugin;
 * the status read itself (and the ledger reconcile that comes with it) is injected, so a run
 * finishing is recorded exactly as `fleet_run_status` would record it.
 *
 * Pure apart from the injected `poll`, `sleep` and `now`; no node or ledger access here.
 */

export const MAX_AWAIT_RUNS = 25;
export const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;
export const MAX_AWAIT_TIMEOUT_MS = 600_000;
export const DEFAULT_POLL_MS = 2_000;
export const MAX_POLL_MS = 15_000;
const MIN_POLL_MS = 50;

export interface AwaitRun {
  runId: string;
  node: string;
}

/** What one status read said about a run, reduced to what the waiter needs. */
export interface RunSnapshot {
  state?: string;
  status?: string;
  alive?: boolean;
  finishedAt?: unknown;
  exitCode?: number;
  verified?: boolean | null;
  scopeViolations?: unknown;
  note?: string;
  [k: string]: unknown;
}

const TERMINAL_STATUSES = new Set(["never-started", "cleaned", "missing-state"]);

/**
 * A run is terminal once it finished or aborted, or when the node can no longer show it running:
 * a dead process with no live state (the #6 silent death, which the status read has already
 * reconciled to `failed`), or a status that says it never started or its state was cleaned.
 */
export function isTerminal(s: RunSnapshot): boolean {
  if (s.finishedAt !== undefined && s.finishedAt !== null) return true;
  if (s.state === "finished" || s.state === "aborted") return true;
  if (typeof s.exitCode === "number") return true;
  if (typeof s.status === "string" && TERMINAL_STATUSES.has(s.status)) return true;
  if (s.alive === false && s.state !== "running") return true;
  return false;
}

export function clampTimeout(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_AWAIT_TIMEOUT_MS;
  return Math.min(MAX_AWAIT_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}
export function clampPoll(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(n)));
}
/** Backoff: the initial interval, growing 1.5x per round, never above MAX_POLL_MS. */
export const nextInterval = (current: number): number => Math.min(MAX_POLL_MS, Math.ceil(current * 1.5));

export interface RunOutcome {
  runId: string;
  node: string;
  terminal: boolean;
  /** Set when the read itself failed or the run id is unknown; the run counts as settled so one bad id cannot hang the set. */
  error?: string;
  snapshot?: RunSnapshot;
}

export interface AwaitResult {
  allTerminal: boolean;
  timedOut: boolean;
  aborted: boolean;
  waitedMs: number;
  outcomes: RunOutcome[];
}

export interface AwaitDeps {
  poll: (run: AwaitRun) => Promise<RunSnapshot>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  onSettled?: (o: RunOutcome, remaining: number) => void;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Poll the set until every run is terminal, the timeout passes, or the signal aborts. Runs are
 * polled one per node at a time (sequentially within a node, concurrently across nodes), so a
 * large set cannot open a burst of simultaneous ssh/node calls to one host. Partial results are
 * always returned: runs that finished are reported even if others are still going.
 */
export async function awaitRuns(runs: AwaitRun[], opts: { timeoutMs?: number; pollMs?: number; until?: "all" | "any" }, deps: AwaitDeps): Promise<AwaitResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const timeoutMs = clampTimeout(opts.timeoutMs);
  let interval = clampPoll(opts.pollMs);
  const started = now();
  const byId = new Map<string, RunOutcome>(runs.map((r) => [r.runId, { runId: r.runId, node: r.node, terminal: false }]));
  const pendingCount = (): number => [...byId.values()].filter((o) => !o.terminal).length;

  const settle = (o: RunOutcome): void => {
    o.terminal = true;
    deps.onSettled?.(o, pendingCount());
  };

  const round = async (): Promise<void> => {
    const groups = new Map<string, RunOutcome[]>();
    for (const o of byId.values()) if (!o.terminal) groups.set(o.node, [...(groups.get(o.node) ?? []), o]);
    await Promise.all(
      [...groups.values()].map(async (list) => {
        for (const o of list) {
          if (deps.signal?.aborted) return;
          try {
            const snap = await deps.poll({ runId: o.runId, node: o.node });
            o.snapshot = snap;
            if (isTerminal(snap)) settle(o);
          } catch (e) {
            // An unreadable run must not hang the whole set: report it and move on.
            o.error = String((e as Error)?.message ?? e).slice(0, 200);
            settle(o);
          }
        }
      }),
    );
  };

  for (;;) {
    await round();
    if (pendingCount() === 0) break;
    // until:"any" returns as soon as one run is terminal (the rest stay pending, not failed).
    if (opts.until === "any" && [...byId.values()].some((o) => o.terminal)) break;
    if (deps.signal?.aborted) break;
    const left = timeoutMs - (now() - started);
    if (left <= 0) break;
    await sleep(Math.min(interval, left), deps.signal);
    interval = nextInterval(interval);
    if (deps.signal?.aborted) break;
  }
  const outcomes = runs.map((r) => byId.get(r.runId)!);
  const allTerminal = outcomes.every((o) => o.terminal);
  const satisfied = allTerminal || (opts.until === "any" && outcomes.some((o) => o.terminal));
  return { allTerminal, timedOut: !satisfied && !deps.signal?.aborted, aborted: !satisfied && deps.signal?.aborted === true, waitedMs: now() - started, outcomes };
}
