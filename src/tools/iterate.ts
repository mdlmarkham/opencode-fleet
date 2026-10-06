import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { quoteUntrusted } from "../untrusted.js";
import { checkSetup } from "../policy.js";
import { parseBudgetConfig } from "../budget.js";
import { type FleetConfig, expectParam } from "./shared.js";

export function registerIterateTools(api: OpenClawPluginApi, cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_iterate",
    label: "Fleet Iterate",
    description:
      "Dispatch a task and auto-iterate: on failure (build errors, test failures, hand-raise) re-dispatch with the errors appended until success, maxIterations, or NO-PROGRESS escalation (identical output twice in a row stops instead of burning tokens).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        cwd: { type: "string", description: "Working directory on the node." },
        prompt: { type: "string", description: "The task / goal for OpenCode." },
        maxIterations: { type: "number", description: "Max iterations before giving up (default 5)." },
        model: { type: "string", description: "Optional model override." },
        transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
        timeoutMs: { type: "number", description: "Per-iteration timeout, ms." },
        successMarker: {
          type: "string",
          description: "Optional string that indicates success (e.g. 'build succeeded'). If absent, treats any non-error result as success.",
        },
        noProgressEscalate: {
          type: "boolean",
          description: "Escalate (stop + report) when consecutive iterations produce identical output (no progress). Default true.",
        },
        judgeProgress: { type: "boolean", description: "Shadow only: log S1's closer-to-done estimate per round beside the string-diff baseline. Changes nothing. Needs `expect` and `s1`." },
        expect: expectParam("Post-run gate after each iteration, as for fleet_dispatch. An iteration with verified:false is not success: the loop keeps iterating or escalates."),
      },
      required: ["node", "cwd", "prompt"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as {
        node: string;
        cwd: string;
        prompt: string;
        maxIterations?: number;
        model?: string;
        transport?: "http" | "acp";
        timeoutMs?: number;
        successMarker?: string;
        noProgressEscalate?: boolean;
        judgeProgress?: boolean;
        expect?: { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number };
      };
      const list = await api.runtime.nodes.list();
      const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      // Issue #165: with no gate there is nothing objective to compare rounds on.
      if (p.judgeProgress === true && p.expect === undefined) {
        return jsonResult({ ok: false, error: "judgeProgress needs an `expect` verification gate: without one there is nothing objective to judge progress against" });
      }

      // Issue #62 review (coverage gap): fleet_iterate accepts the same
      // optional verification gate as fleet_dispatch, validated up front and
      // threaded to the node on EVERY iteration.
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

      const maxIter = p.maxIterations ?? 5;
      const escalateOnNoProgress = p.noProgressEscalate ?? true;
      const iterations: Array<{ iter: number; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean | null; progress?: boolean }> = [];
      let currentPrompt = p.prompt;
      let prevFingerprint = "";
      // Issue #131: the failure.real-bug decision made after the previous round; this round's result is its outcome.
      let pendingFailure: Promise<string | undefined> | undefined;
      const labelRun = (success: boolean, verified: boolean | null, iterations: number): void => {
        if (p.judgeProgress !== true || cfg.s1 == null) return;
        void import("../progress-judge.js").then((m) => m.recordProgressLabel(judgeKey, { verified, success, iterations }, api.rootDir ?? process.cwd())).catch(() => { /* best effort */ });
      };
      let prevRound: { summary?: string; error?: string; verified: boolean | null } | undefined;
      const judgeKey = `iter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Last iteration's parsed outcome, in scope after the loop exits.
      let lastOutcome: { verified?: boolean; verifyDetails?: unknown } | null = null;
      // Issue #39 (budget slice): each iteration is a run seed counted against the same
      // day budget. A refused iteration (day spent) sets a "budget" reason the loop's
      // stop path annotates, so an unattended caller escalates instead of re-launching.
      const { parseBudgetConfig, budgetCheck: checkBudget, budgetExhausted } = await import("../budget.js");
      const { loadLedger: loadLedgerForBudget } = await import("../ledger.js");
      const budgetParsed = parseBudgetConfig(cfg.budget);
      const budgetLimits = budgetParsed.ok ? budgetParsed.config : undefined;
      const budgetRoot = api.rootDir ?? process.cwd();
      let budgetRefusal: ReturnType<typeof budgetExhausted> | undefined;

      for (let i = 1; i <= maxIter; i++) {
        if (budgetLimits) {
          const budgetVerdict = checkBudget(await loadLedgerForBudget(budgetRoot), budgetLimits, new Date().toISOString());
          if (!budgetVerdict.allowed) {
            budgetRefusal = budgetExhausted(budgetVerdict.spent ?? { costUsd: 0, tokens: 0 }, budgetVerdict.reason ?? "budget exhausted");
            if (i === 1 || escalateOnNoProgress) {
              return jsonResult(
                withVerified(
                  {
                    iterations,
                    done: false,
                    success: false,
                    escalated: true,
                    stoppedBy: "budget" as const,
                    ...budgetRefusal,
                    reason: `budget exhausted before iteration ${i}: ${budgetVerdict.reason}`,
                    recommendation:
                      "Budget stop: the day's budget is spent (resets 00:00 UTC). Escalate to the operator to raise budget.* in the plugin config, or resume tomorrow — do not keep iterating.",
                  },
                  lastOutcome,
                ),
              );
            }
            break;
          }
        }
        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: {
            prompt: currentPrompt,
            cwd: p.cwd,
            transport: p.transport ?? "http",
            model: p.model,
            timeoutMs: p.timeoutMs ?? 300_000,
            expect: expectSpec.expect,
          },
          timeoutMs: relayTimeoutWithGate(p.timeoutMs ?? 300_000, expectSpec.expect !== undefined, expectSpec.expect),
          signal,
        });
        const payload = (inv as { payload?: unknown }).payload;
        const parsed =
          typeof payload === "string"
            ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown })
            : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown } | undefined) ?? {});
        const verified = typeof parsed.verified === "boolean" ? parsed.verified : null;
        lastOutcome = parsed;

        // Fingerprint the output to detect progress (or lack thereof).
        const fingerprint = (parsed.summary ?? "").slice(0, 500) + "|" + (parsed.error ?? "").slice(0, 500);
        const progress = i === 1 ? true : fingerprint !== prevFingerprint;
        prevFingerprint = fingerprint;

        // Issue #165 (shadow): record S1's view of this round next to the baseline's. Fire-and-forget;
        // nothing below reads it.
        if (p.judgeProgress === true && cfg.s1 != null && i > 1 && prevRound) {
          const previous = prevRound;
          void import("../progress-judge.js")
            .then((m) => m.recordProgressShadow(cfg.s1, { goal: p.prompt, previous, current: { summary: parsed.summary, error: parsed.error, verified } }, { runKey: judgeKey, iter: i, baselineProgress: progress }, api.rootDir ?? process.cwd()))
            .catch(() => { /* never breaks the loop */ });
        }
        prevRound = { summary: parsed.summary, error: parsed.error, verified };

        iterations.push({
          iter: i,
          summary: parsed.summary,
          handRaised: parsed.handRaised,
          question: parsed.question,
          error: parsed.error,
          verified,
          progress,
        });

        // Hand-raise: stop and let the caller answer.
        if (parsed.handRaised) {
          // Issue #131 (shadow): would S1 have answered this from the record? Logged, never acted on.
          if (cfg.s1 != null && parsed.question) {
            const q = parsed.question;
            void import("../builtin-points.js").then((m) => m.shadowPoint(cfg.s1, "handraise.triage", m.handraiseState(q, p.prompt), m.handraiseBaseline(q, p.prompt), api.rootDir ?? process.cwd())).catch(() => { /* never breaks the loop */ });
          }
          return jsonResult(withVerified({ iterations, handRaised: true, question: parsed.question, done: false }, parsed));
        }

        // Success check.
        // Issue #35: trust the exit-status-derived `ok`; only fall back to the
        // output regex for a node that predates it (ok undefined).
        // Issue #62 review (coverage gap): a FAILED verification gate is NOT
        // success even when ok is true — verified === false must never be
        // reported as done/success.
        const looksFailed = parsed.ok === undefined
          ? /error|failed|timed out|stuck/i.test(parsed.summary ?? "")
          : parsed.ok === false;
        // Issue #103: `successMarker` is a SUBSTRING match on worker-controlled
        // text, so a worker can fake success just by printing the marker. The
        // marker is an ADDITIONAL required condition, NEVER the sole one: it
        // counts only when ANDed with a real pass signal (`ok !== false`, i.e.
        // not looksFailed) AND the verification gate did not fail
        // (`verified !== false`). A worker printing the marker over a failing
        // run must not be able to fake success.
        const markerSeen = p.successMarker ? (parsed.summary ?? "").includes(p.successMarker) : false;
        const success = (p.successMarker ? markerSeen && !looksFailed : !looksFailed) && verified !== false;
        if (pendingFailure) {
          const pf = pendingFailure;
          pendingFailure = undefined;
          void Promise.all([pf, import("../builtin-points.js")]).then(([id, m]) => { if (id) return m.linkOutcome(m.shadowSinkFor(api.rootDir ?? process.cwd()), id, !success); }).catch(() => { /* best effort */ });
        }
        if (success) {
          labelRun(true, verified, i);
          return jsonResult(withVerified({ iterations, done: true, success: true, finalSummary: parsed.summary }, parsed));
        }

        // NO-PROGRESS escalation: same output as last iteration → stop, don't burn tokens.
        if (escalateOnNoProgress && i > 1 && !progress) {
          labelRun(false, verified, i);
          // Issue #103: every return shape goes through withVerified —
          // `verified`/`verifyDetails` are ALWAYS present here too (null when
          // no gate ran), matching the helper's contract.
          return jsonResult(
            withVerified(
              {
                iterations,
                done: false,
                success: false,
                escalated: true,
                // Issue #39 (budget slice): a stop caused by an exhausted day budget
                // is a "budget"-annotated escalation, not a no-progress one.
                ...(budgetRefusal ? { stoppedBy: "budget" as const } : {}),
                reason: budgetRefusal ? `budget exhausted: ${budgetRefusal.error}` : "no progress across iterations (identical output)",
                ...(budgetRefusal ? { spent: budgetRefusal.spent } : {}),
                recommendation: budgetRefusal
                  ? "Budget stop: the day's budget is spent (resets 00:00 UTC). Escalate to the operator to raise budget.* in the plugin config, or resume tomorrow."
                  : "Escalate: switch to a heavier model, change the approach, or hand off to a human. Do not keep retrying the same prompt.",
              },
              lastOutcome,
            ),
          );
        }

        // Issue #131 (shadow): classify the failing round; the NEXT round's result is its outcome.
        if (cfg.s1 != null) {
          const fail = { error: parsed.error, summary: parsed.summary, verified, ...(typeof (parsed as { exitCode?: unknown }).exitCode === "number" ? { exitCode: (parsed as { exitCode: number }).exitCode } : {}) };
          pendingFailure = import("../builtin-points.js")
            .then(async (m) => (await m.shadowPoint(cfg.s1, "failure.real-bug", m.failureState(fail), m.failureBaseline(fail), api.rootDir ?? process.cwd()))?.decisionId)
            .catch(() => undefined);
        }

        // Re-dispatch with the failure context appended.
        currentPrompt = [
          p.prompt,
          "",
          `Iteration ${i} did not succeed. The worker reported:`,
          parsed.summary ? quoteUntrusted("output", parsed.summary) : "",
          parsed.error ? quoteUntrusted("error", parsed.error) : "",
          ...(verified === false
            ? ["The post-run verification gate FAILED: the run must actually produce the artifacts/commands in `expect` — do not claim completion without them."]
            : []),
          "",
          "Fix the issues above and try again. Do not repeat the same approach.",
        ].join("\n");
      }

      labelRun(false, prevRound?.verified ?? null, iterations.length);
      return jsonResult(
        withVerified({ iterations, done: true, success: false, note: `exceeded ${maxIter} iterations` }, lastOutcome),
      );
    },
  });
}
