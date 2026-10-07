import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { DEFAULT_WATCH_TIMEOUT_MS } from "../opencode.js";
import { sanitizeQuestion } from "../untrusted.js";
import { checkSetup } from "../policy.js";
import { type FleetConfig, expectParam, payloadOf } from "./shared.js";

export function registerRunsTools(api: OpenClawPluginApi, cfg: FleetConfig): { runStatusExecute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown> } {
  api.registerTool({
    name: "fleet_run_report",
    label: "Fleet Run Report",
    description:
      "The audit manifest of a FINISHED fleet run: files changed against the start commit, git diff --stat, commands the engine ran (when it reports them), exit code, duration, token/cost usage, verification result, scope, and event-log size, plus the dispatch spec from the ledger. Read it to see what an unattended run actually did (e.g. exit 0 with no files changed). Secrets are redacted. Fields that could not be captured are null/commandsRecorded:false, never an implied empty list.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        runId: { type: "string", description: "The fleet run id." },
      },
      required: ["node", "runId"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { node: string; runId: string };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      const st = payloadOf(
        await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: { prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: p.runId, report: true },
          timeoutMs: 30_000,
          signal,
        }),
      );
      const { redactAudit } = await import("../audit.js");
      const { loadLedger } = await import("../ledger.js");
      const entry = (await loadLedger(api.rootDir ?? process.cwd())).find((r) => r.runId === p.runId);
      const run = entry
        ? { state: entry.state, harness: entry.harness, prompt: entry.prompt, spec: entry.spec, summary: entry.summary, verified: entry.verified ?? null }
        : undefined;
      if (!st.ok && st.error) return jsonResult(redactAudit({ ok: false, runId: p.runId, status: st.status ?? "missing-state", error: String(st.error), ...(run ? { run } : {}) }));
      if (!st.finishedAt) {
        return jsonResult(redactAudit({ ok: false, runId: p.runId, status: st.alive ? "running" : "no-completion-record", note: "the audit manifest is written once the run has finished; poll fleet_run_status", ...(run ? { run } : {}) }));
      }
      if (!st.manifest) {
        return jsonResult(redactAudit({ ok: true, runId: p.runId, manifest: null, note: "the node did not return a manifest (it predates the audit trail); upgrade opencode-fleet on the node", ...(run ? { run } : {}) }));
      }
      return jsonResult(redactAudit({ ok: true, runId: p.runId, manifest: st.manifest, ...(run ? { run } : {}) }));
    },
  });

  const runStatusExecute = async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const p = params as { node: string; runId: string; includeOutput?: boolean };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      const invoke = async (params: Record<string, unknown>, timeoutMs?: number) =>
        api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params,
          timeoutMs: timeoutMs ?? 20_000,
          signal,
        });

      const st = payloadOf(await invoke({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: p.runId }));
      if (!st.ok && st.error) {
        // Issue #6 inconsistency probe: no run state at all. Issue #21:
        // distinguish never-started from cleaned rather than one ambiguous
        // message, so an operator can tell a failed launch from a tidied run.
        const rawStatus = String(st.status ?? "missing-state");
        const status = rawStatus === "never-started" || rawStatus === "cleaned" ? rawStatus : "missing-state";
        return jsonResult({
          runId: p.runId,
          node: p.node,
          status,
          note: String(st.error),
          ...(status === "never-started"
            ? { guidance: "Launch was never acknowledged — the run did not start. Re-dispatch if work is expected." }
            : status === "cleaned"
              ? { guidance: "Run artifacts exist but state was cleaned; the run did start. See fleet_cleanup/logs." }
              : {}),
        });
      }
      const alive = st.alive === true;
      const finished = st.state === "finished" || st.state === "aborted" || typeof st.exitCode === "number";

      // Reconcile ledger when terminal.
      const { loadLedger, upsertRun } = await import("../ledger.js");
      const rootDir = api.rootDir ?? process.cwd();
      const ledger = await loadLedger(rootDir);
      const entry = ledger.find((r) => r.runId === p.runId);
      if (entry && (finished || entry.state === "running") && (st.finishedAt || !alive)) {
        // Worker process gone without a completion marker = silent death
        // (the exact issue #6 signature). Record it explicitly.
        // Issue #62 review (finding: ledger laundering): the gate outcome
        // rides with the run record — a clean exit whose gate FAILED must
        // reconcile to "failed-verification", never "completed". Process-
        // level failures keep "failed" (the gate only reclassifies the
        // would-be-completed branch); verified/verifyDetails are persisted
        // so the failure survives node state cleanup.
        const reconcileVerified = typeof st.verified === "boolean" ? st.verified : null;
        const state =
          !st.finishedAt
            ? "failed"
            : st.exitCode === 0 && reconcileVerified === false
              ? "failed-verification"
              : st.exitCode === 0
                ? "completed"
                : "failed";
        // Issue #39 (budget slice): finished runs carry their audit manifest's usage
        // (tokens, costUsd when the engine reports one) on their ledger entry, so the
        // day's budget spend can be derived from the ledger. The run is accounted to
        // the UTC day it started (startedAt rides the entry untouched). A finished run
        // whose manifest has no usable usage records nothing (no zero laundering).
        const { usageFromManifest } = await import("../budget.js");
        const usage = st.manifest !== undefined ? usageFromManifest(st.manifest) : undefined;
        const alreadyCounted = entry && entry.usage !== undefined;
        await upsertRun(rootDir, {
          ...(entry ?? { runId: p.runId, node: p.node, cwd: "", prompt: "", startedAt: new Date().toISOString() }),
          runId: p.runId,
          node: entry?.node ?? p.node,
          cwd: entry?.cwd ?? "",
          prompt: entry?.prompt ?? "",
          startedAt: entry?.startedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state,
          ...(typeof st.exitCode === "number" ? { exitCode: st.exitCode } : {}),
          ...(reconcileVerified !== null ? { verified: reconcileVerified } : {}),
          ...(st.gateTimedOut === true && reconcileVerified === null ? { gateTimedOut: true as const } : {}),
          // Issue #324b: a could-not-run gate is recorded like #309's timeout (unverified, not failed).
          ...(st.gateUnavailable === true && reconcileVerified === null ? { gateUnavailable: true as const, gateMissing: typeof st.gateMissing === "string" && st.gateMissing ? st.gateMissing : undefined } : {}),
          ...(st.verifyDetails != null ? { verifyDetails: st.verifyDetails } : {}),
          // Issue #104: persist what the node reported so fleet_sync can apply the scope policy.
          ...(entry?.spec?.scope && st.finishedAt ? { scopeViolations: Array.isArray(st.scopeViolations) ? (st.scopeViolations as string[]) : null } : {}),
          // Issue #39: usage rides the ledger once, from the manifest; the run's own
          // startedAt attributes it to its day. A recorded entry keeps its usage.
          ...(usage && !alreadyCounted ? { usage } : {}),
          // Issue #166: a captured change list (null = capture missing, never "no changes").
          ...(Array.isArray((st.manifest as { filesChanged?: unknown } | undefined)?.filesChanged) ? { filesChanged: ((st.manifest as { filesChanged: unknown[] }).filesChanged).length } : {}),
          summary:
            state === "failed" && !st.finishedAt
              ? "worker process died without completion record (silent death)"
              : state === "failed-verification"
                ? "verification gate failed (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails)"
                : undefined,
        });
      }

      let output: unknown;
      if (st.finishedAt && p.includeOutput !== false) {
        const res = payloadOf(await invoke({ prompt: "__RUN_RESULT__", cwd: "/", transport: "http", runId: p.runId }, 30_000));
        output = res.result;
        // Issue #83: instruction-pattern screen before the agent reads it. shadow only logs; fence/withhold change the text.
        if (typeof output === "string") {
          const sc = await import("../output-screen.js");
          const mode = sc.parseScreenMode((cfg.project as { screenOutput?: unknown } | undefined)?.screenOutput);
          if (mode !== "off") {
            const r = sc.applyScreen(output, mode);
            if (r.screen.flagged) {
              void sc.logScreen(api.rootDir ?? process.cwd(), p.runId, mode, r.screen);
            }
            output = r.text;
          }
        }
      }

      return jsonResult({
        runId: p.runId,
        node: p.node,
        pid: st.pid,
        alive,
        state: st.state ?? (alive ? "running" : "unknown"),
        startedAt: st.startedAt,
        finishedAt: st.finishedAt,
        exitCode: st.exitCode,
        // Issue #103: surface the engine the run used (from the ledger entry;
        // "opencode" when unknown — the historical default). Additive field only.
        harness: entry?.harness ?? "opencode",
        // Issue #62: the verification gate outcome (null = no gate was
        // configured). Do NOT fold it into ok/exitCode — it is a separate
        // signal, but a failed gate means the run must not be trusted.
        verified: typeof st.verified === "boolean" ? st.verified : null,
        verifyDetails: st.verifyDetails ?? null,
        // Issue #65 slice 2: advisory scope check. null = a scope was declared but
        // the node did not report (older node, still running, or git failed).
        ...(entry?.spec?.scope
          ? {
              scopeViolations: Array.isArray(st.scopeViolations) ? st.scopeViolations : null,
              ...(Array.isArray(st.changedFiles) ? { changedFiles: st.changedFiles } : {}),
              ...(st.scopeError ? { scopeNote: st.scopeError } : {}),
              ...(Array.isArray(st.scopeViolations) && st.scopeViolations.length
                ? { scopeWarning: `${st.scopeViolations.length} changed file(s) fall outside the declared scope (advisory; review them).` }
                : {}),
            }
          : {}),
        ...(st.gateTimedOut === true
          ? {
              gateTimedOut: true,
              verifiedNote: "VERIFICATION GATE TIMED OUT (issue #309): the gate command did not finish within its bound, so the work is UNVERIFIED, not failed. Re-run the gate by hand or on a quieter node (or raise verify.timeoutMs); do not report it as verified.",
            }
          : {}),
        ...(st.gateUnavailable === true
          ? {
              // Issue #324b: the gate never ran its toolchain — name the cause, never "failed".
              gateUnavailable: true,
              verifiedNote: `VERIFICATION GATE UNAVAILABLE (issue #324b): ${st.gateMissing ? `the gate could not run (tool missing: ${st.gateMissing})` : "the gate could not run (a tool is missing on the node)"}, so the work is UNVERIFIED, not failed. Bootstrap the checkout (see "Bootstrapping a clone" in docs/operators.md) and re-run; do not report it as verified.`,
            }
          : {}),
        ...(st.verified === false
          ? {
              verifiedNote:
                "VERIFICATION GATE FAILED (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails). Treat this run as unverified — do not report it as successful work.",
            }
          : {}),
        output,
      });
    };

  api.registerTool({
    name: "fleet_run_status",
    label: "Fleet Run Status",
    description:
      "Poll a detached run: liveness, state, exit code, final output when complete. Reconciles the ledger on terminal state and detects the inconsistent state (ledger running, no live process, no completion record).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        runId: { type: "string", description: "The fleet run id from the async dispatch result." },
        includeOutput: { type: "boolean", description: "Include the worker's final output when the run is finished (default true)." },
      },
      required: ["node", "runId"],
    },
    execute: runStatusExecute,
  });

  api.registerTool({
    name: "fleet_await",
    label: "Fleet Await",
    description:
      "Wait for a set of detached runs in ONE call instead of polling fleet_run_status. Polls inside the plugin with backoff, reconciles the ledger as each run finishes, and returns when all are terminal or timeoutMs passes (default 120s, max 600s). On timeout it returns the finished runs plus `pending`: call again, do not loop on fleet_run_status.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        runIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25, description: "Run ids from async dispatches (max 25)." },
        node: { type: "string", description: "Node for every run id. Omit to use each run's node from the ledger." },
        timeoutMs: { type: "number", description: "Max wait, ms (default 120000, max 600000)." },
        pollMs: { type: "number", description: "Initial poll interval, ms (default 2000, grows to 15000)." },
        until: { type: "string", enum: ["all", "any"], description: "all (default): wait for every run. any: return as soon as one run is terminal; the others stay in `pending`." },
      },
      required: ["runIds"],
    },
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const p = params as { runIds?: unknown; node?: string; timeoutMs?: number; pollMs?: number; until?: unknown };
      const { awaitRuns, MAX_AWAIT_RUNS } = await import("../await.js");
      const ids = Array.isArray(p.runIds) ? p.runIds.filter((x): x is string => typeof x === "string" && x !== "") : [];
      if (ids.length === 0) return jsonResult({ ok: false, error: "runIds must be a non-empty array of run ids" });
      const unique = [...new Set(ids)];
      if (unique.length > MAX_AWAIT_RUNS) return jsonResult({ ok: false, error: `at most ${MAX_AWAIT_RUNS} runs per call; got ${unique.length}` });
      const { loadLedger } = await import("../ledger.js");
      const ledger = await loadLedger(api.rootDir ?? process.cwd());
      const runs: Array<{ runId: string; node: string }> = [];
      const unknown: Array<{ runId: string; error: string }> = [];
      for (const runId of unique) {
        const node = p.node ?? ledger.find((r) => r.runId === runId)?.node;
        if (!node) unknown.push({ runId, error: "unknown run id: not in the ledger and no node given" });
        else runs.push({ runId, node });
      }
      const decodeStatus = (res: unknown): Record<string, unknown> => {
        const r = res as { details?: unknown; content?: Array<{ text?: string }> };
        if (r?.details && typeof r.details === "object") return r.details as Record<string, unknown>;
        const text = r?.content?.[0]?.text;
        if (typeof text === "string") {
          try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(text.slice(0, 200)); }
        }
        throw new Error("unreadable status");
      };
      const r = await awaitRuns(runs, { timeoutMs: p.timeoutMs, pollMs: p.pollMs, until: p.until === "any" ? "any" : "all" }, {
        signal,
        poll: async (run) => decodeStatus(await runStatusExecute("await", { node: run.node, runId: run.runId, includeOutput: false }, signal)),
        onSettled: (o, remaining) => {
          onUpdate?.({
            content: [{ type: "text", text: `run ${o.runId} ${String(o.snapshot?.state ?? o.snapshot?.status ?? o.error ?? "settled")}; ${remaining} still running` }],
            details: { progress: "run-settled" },
            progress: { text: `${o.runId} done, ${remaining} pending`, visibility: "channel", privacy: "public" },
          });
        },
      });
      const results: Record<string, unknown> = {};
      for (const u of unknown) results[u.runId] = { terminal: true, error: u.error };
      for (const o of r.outcomes) {
        const s = o.snapshot ?? {};
        results[o.runId] = {
          node: o.node,
          terminal: o.terminal,
          ...(o.error ? { error: o.error } : {}),
          state: s.state ?? s.status ?? (o.terminal ? "unknown" : "running"),
          ...(typeof s.exitCode === "number" ? { exitCode: s.exitCode } : {}),
          verified: typeof s.verified === "boolean" ? s.verified : null,
          ...(s.scopeViolations !== undefined ? { scopeViolations: s.scopeViolations } : {}),
          ...(typeof s.note === "string" ? { note: s.note } : {}),
        };
      }
      const pending = r.outcomes.filter((o) => !o.terminal).map((o) => o.runId);
      return jsonResult({
        ok: true,
        allTerminal: r.allTerminal,
        timedOut: r.timedOut,
        ...(r.aborted ? { aborted: true } : {}),
        waitedMs: r.waitedMs,
        runs: results,
        pending,
        ...(pending.length ? { hint: r.timedOut ? "Still running: call fleet_await again with the pending run ids. Do not loop on fleet_run_status." : "Some runs are still pending; call fleet_await again with them if you need them." } : {}),
      });
    },
  });

  api.registerTool({
    name: "fleet_answer",
    label: "Fleet Answer",
    description:
      "Answer a worker's hand-raised clarifying question and re-dispatch the task with the answer + prior context. Use when fleet_dispatch returns handRaised:true. The worker gets the answer and continues where it stopped.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        cwd: { type: "string", description: "Working directory on the node." },
        question: { type: "string", description: "The worker's question (from the handRaised result)." },
        answer: { type: "string", description: "Your answer / decision." },
        priorContext: { type: "string", description: "The original task prompt (so the worker keeps context)." },
        model: { type: "string", description: "Optional model override." },
        transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
        timeoutMs: { type: "number", description: "Per-node timeout, ms." },
      },
      required: ["node", "cwd", "question", "answer", "priorContext"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as {
        node: string;
        cwd: string;
        question: string;
        answer: string;
        priorContext: string;
        model?: string;
        transport?: "http" | "acp";
        timeoutMs?: number;
      };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);

      // Re-dispatch with the answer appended to the original context.
      const prompt = [
        p.priorContext,
        "",
        // Issue #35: the question came from a worker (model output), so it is
        // quoted as data and bounded; only `answer` is the caller's own voice.
        "A clarifying question was raised and answered:",
        `Q: ${sanitizeQuestion(p.question)}`,
        `A: ${p.answer}`,
        "Continue the task with this answer. Do not re-ask the same question.",
      ].join("\n");

      const inv = await api.runtime.nodes.invoke({
        nodeId: node.nodeId,
        command: "opencode.run",
        params: {
          prompt,
          cwd: p.cwd,
          transport: p.transport ?? "http",
          model: p.model,
          timeoutMs: p.timeoutMs ?? 300_000,
        },
        timeoutMs: p.timeoutMs ?? 300_000,
        signal,
      });
      return jsonResult(inv);
    },
  });

  api.registerTool({
    name: "fleet_watch",
    label: "Fleet Watch",
    description:
      "Dispatch a task and watch it live: streams progress to you via onUpdate, polls node activity, returns the final result. Use when you want to see a task in progress, not fire-and-forget.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        cwd: { type: "string", description: "Working directory on the node." },
        prompt: { type: "string", description: "The task / goal for OpenCode." },
        model: { type: "string", description: "Optional model override." },
        transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
        timeoutMs: { type: "number", description: "Wall-clock limit for this watched run, ms (default 600000 = 10 minutes). fleet_watch is a blocking call: this is the ONLY limit on the run, so pass a larger value for real tasks, or use fleet_dispatch (detached, 30-minute default) plus fleet_await for long ones. A run ended by it reports endedBy." },
        pollMs: { type: "number", description: "Activity poll interval, ms (default 15000)." },
        expect: expectParam("Post-run gate, as for fleet_dispatch. A failed gate means the watched run must not be reported as success."),
      },
      required: ["node", "cwd", "prompt"],
    },
    execute: async (toolCallId, params, signal, onUpdate) => {
      const p = params as {
        node: string;
        cwd: string;
        prompt: string;
        model?: string;
        transport?: "http" | "acp";
        timeoutMs?: number;
        pollMs?: number;
        expect?: { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number };
      };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);

      // Issue #62 review (coverage gap): fleet_watch accepts the same
      // optional verification gate as fleet_dispatch — validated up front
      // and threaded to the node on every watch.
      const { parseExpectSpec, withVerified, relayTimeoutWithGate } = await import("../verify.js");
      const expectSpec = parseExpectSpec(p.expect);
      if (!expectSpec.ok) {
        return jsonResult({ ok: false, error: `invalid expect: ${expectSpec.error}` });
      }
      // `expect.command` runs on the node OUTSIDE the engine's permission system,
      // so it gets the same rule as provision `setup`: a repo-relative script
      // path unless the operator allows arbitrary commands (issue #34).
      if (expectSpec.expect?.command) {
        const cmdCheck = checkSetup(expectSpec.expect.command, cfg.allowSetupCommands === true);
        if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.command: ${cmdCheck.error}` });
      }
      if (expectSpec.expect?.commands) {
        for (const cmd of expectSpec.expect.commands) {
          const cmdCheck = checkSetup(cmd, cfg.allowSetupCommands === true);
          if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.commands entry: ${cmdCheck.error}` });
        }
      }

      const timeoutMs = p.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
      const pollMs = p.pollMs ?? 15_000;
      const startedAt = Date.now();

      // Kick off the dispatch (fire-and-forget from the tool's perspective;
      // we monitor via activity polling).
      const dispatchPromise = api.runtime.nodes.invoke({
        nodeId: node.nodeId,
        command: "opencode.run",
        params: {
          prompt: p.prompt,
          cwd: p.cwd,
          transport: p.transport ?? "http",
          model: p.model,
          timeoutMs,
          expect: expectSpec.expect,
        },
        timeoutMs: relayTimeoutWithGate(timeoutMs, expectSpec.expect !== undefined, expectSpec.expect),
        signal,
      });

      // Poll activity and stream progress until the dispatch settles.
      let settled = false;
      let lastActivity = "";
      // The poll sleep ends the moment the run settles, so the tool does not hold its result for up
      // to a full poll interval after the worker has finished.
      let wakePoll: (() => void) | undefined;
      const settle = (): void => { settled = true; wakePoll?.(); };
      const pollLoop = (async () => {
        while (!settled && Date.now() - startedAt < timeoutMs) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, pollMs);
            wakePoll = () => { clearTimeout(t); resolve(); };
          });
          if (settled) break;
          try {
            const inv = await api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params: { prompt: "__ACTIVITY__", cwd: "/", transport: "http" },
              timeoutMs: 15000,
              signal,
            });
            const payload = (inv as { payload?: unknown }).payload;
            const parsed =
              typeof payload === "string"
                ? (JSON.parse(payload) as { activity?: Array<{ pid?: number; elapsed?: string; cpu?: string; command?: string }> })
                : ((payload as { activity?: Array<{ pid?: number; elapsed?: string; cpu?: string; command?: string }> } | undefined) ?? {});
            const procs = parsed.activity ?? [];
            const summary = procs.length
              ? `${procs.length} opencode process(es) running (${procs.map((x) => x.elapsed ?? "?").join(", ")} elapsed)`
              : "no opencode process running";
            if (summary !== lastActivity) {
              lastActivity = summary;
              onUpdate?.({
                content: [{ type: "text", text: summary }],
                details: { progress: summary },
                progress: { text: summary, visibility: "channel", privacy: "public" },
              });
            }
          } catch {
            // Activity poll is best-effort.
          }
        }
      })();

      let result: unknown;
      try {
        result = await dispatchPromise;
      } catch (err) {
        // The relay itself gave up (or the node vanished) before the node reported: say so, so it is
        // not mistaken for the run's own wall-clock limit.
        settle();
        await pollLoop;
        return jsonResult({
          done: false,
          ok: false,
          endedBy: "watch-relay",
          error: `the fleet_watch relay to the node failed before the run reported: ${(err as Error).message}`.slice(0, 400),
          mayStillBeRunning: true,
          elapsedMs: Date.now() - startedAt,
          hint: "The run may still be going on the node. Find it with fleet_resume / fleet_status; for long tasks use fleet_dispatch + fleet_await.",
        });
      }
      settle();
      await pollLoop;

      const payload = (result as { payload?: unknown }).payload;
      const parsed =
        typeof payload === "string"
          ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; endedBy?: string; verified?: boolean; verifyDetails?: unknown })
          : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; endedBy?: string; verified?: boolean; verifyDetails?: unknown } | undefined) ?? {});
      const watchedVerified = typeof parsed.verified === "boolean" ? parsed.verified : null;

      onUpdate?.({
        content: [{ type: "text", text: `Task complete: ${parsed.summary ?? "(no summary)"}${watchedVerified === false ? " — VERIFICATION GATE FAILED (issue #62)" : ""}` }],
        details: { progress: "complete" },
        progress: { text: "Task complete", visibility: "channel", privacy: "public" },
      });

      // Issue #62 review: surface the gate outcome with the SAME shape as
      // fleet_run_status / the sync dispatch path (verified always present,
      // verifyDetails alongside) so a watched run's gate failure is visible
      // and must not be reported as successful work.
      return jsonResult(
        withVerified(
          {
            done: true,
            ok: parsed.ok,
            summary: parsed.summary,
            handRaised: parsed.handRaised,
            question: parsed.question,
            // Issue #190: name the limit that fired. For a watched (blocking) run the only wall-clock
            // limit is this call's own timeoutMs, so say that instead of a bare "wall-clock limit".
            error: parsed.endedBy === "wall-clock" && parsed.error ? `${parsed.error} (fleet_watch's own timeoutMs: ${Math.round(timeoutMs / 1000)}s${p.timeoutMs === undefined ? ", the default" : ""})` : parsed.error,
            ...(parsed.endedBy ? { endedBy: parsed.endedBy } : {}),
            ...(parsed.endedBy === "wall-clock" ? { timeoutMs, hint: "Pass a larger timeoutMs to fleet_watch, or use fleet_dispatch (30-minute default, detached) + fleet_await for long tasks." } : {}),
            elapsedMs: Date.now() - startedAt,
            ...(watchedVerified === false
              ? {
                  verifiedNote:
                    "VERIFICATION GATE FAILED (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails). Treat this run as unverified — do not report it as successful work.",
                }
              : {}),
          },
          parsed,
        ),
      );
    },
  });

  api.registerTool({
    name: "fleet_abort",
    label: "Fleet Abort",
    description: "Abort a run on a fleet node. Needs the runId (from fleet_dispatch); a sessionId is accepted if the ledger knows the run it belongs to. Never kills by name pattern.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        sessionId: { type: "string", description: "Session id; resolved to its runId through the ledger when runId is omitted." },
        runId: { type: "string", description: "The runId (from fleet_dispatch). Terminates that run engine-independently (Pi and opencode) and reports confirmed termination." },
      },
      required: ["node"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { node: string; sessionId?: string; runId?: string };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      // Issue #63: abort addresses one run. Resolve a sessionId through the ledger.
      let runId = p.runId;
      if (!runId && p.sessionId) {
        const { loadLedger, resolveAbortRunId } = await import("../ledger.js");
        runId = resolveAbortRunId(
          await loadLedger(api.rootDir ?? process.cwd()),
          p.sessionId,
          [node.displayName, node.nodeId].filter((x): x is string => !!x),
        );
      }
      if (!runId) {
        return jsonResult({ ok: false, aborted: false, error: "runId required: pass the runId from fleet_dispatch, or a sessionId the ledger recorded for this node" });
      }
      const inv = await api.runtime.nodes.invoke({
        nodeId: node.nodeId,
        command: "opencode.run",
        params: { prompt: "__ABORT__", cwd: "/", transport: "http", sessionId: p.sessionId, runId },
        timeoutMs: 15000,
        signal,
      });
      return jsonResult(inv);
    },
  });

  api.registerTool({
    name: "fleet_diff",
    label: "Fleet Diff",
    description: "Pull the diff summary from a finished OpenCode session on a fleet node.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        sessionId: { type: "string", description: "Session id to pull the diff for." },
        cwd: { type: "string", description: "Absolute repo path on the node (required to run git diff; read-only)." },
      },
      required: ["node", "sessionId", "cwd"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { node: string; sessionId: string; cwd: string };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      const inv = await api.runtime.nodes.invoke({
        nodeId: node.nodeId,
        command: "opencode.run",
        params: { prompt: "__DIFF__", cwd: p.cwd, transport: "http", sessionId: p.sessionId },
        timeoutMs: 30000,
        signal,
      });
      return jsonResult(inv);
    },
  });
  return { runStatusExecute };
}
