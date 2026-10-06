import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type FleetConfig, payloadOf } from "./shared.js";

export function registerReviewTools(api: OpenClawPluginApi, cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_review",
    label: "Fleet Review",
    description:
      "Review gate. action=record stores a structured review verdict bound to one head sha; PASS needs executed-command evidence. action=check says whether a head has a PASS (what sync.requireReview enforces). Does not spawn the reviewer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["record", "check", "prepare", "collect"], description: "prepare: mint the reviewer task for a head (you then run it with fleet_dispatch on a checkout at that sha). collect: read the finished reviewer run, verify it, and record a `spawned` verdict." },
        headSha: { type: "string", description: "Full 40-hex commit sha reviewed (record, prepare) or about to be merged (check). Not needed for collect." },
        runId: { type: "string", description: "collect: the reviewer run (its prompt carries the REVIEW-TOKEN from prepare)." },
        node: { type: "string", description: "collect: the node the reviewer run ran on." },
        base: { type: "string", description: "prepare: git ref to diff against (e.g. origin/master)." },
        buildCommand: { type: "string", description: "prepare: build command the reviewer should run (default npm run build)." },
        testCommand: { type: "string", description: "prepare: test command the reviewer should run (default npm test)." },
        requireSource: { type: "string", enum: ["spawned"], description: "check: only a PASS collected from a reviewer run counts." },
        verdict: { type: "string", enum: ["PASS", "FAIL", "BLOCKED"], description: "BLOCKED = the reviewer could not run its tools. Never record PASS for that." },
        reviewer: { type: "string", description: "Who ran the review." },
        author: { type: "string", description: "Who wrote the change; must differ from reviewer." },
        pr: { type: "integer" },
        evidence: { type: "object", properties: { commands: { type: "array", items: { type: "object", properties: { command: { type: "string" }, exitCode: { type: "integer" }, outputTail: { type: "string" } }, required: ["command", "exitCode"] } } } },
        findings: { type: "array", items: { type: "object", properties: { severity: { type: "string", enum: ["blocking", "major", "minor", "nit"] }, summary: { type: "string" }, file: { type: "string" } }, required: ["severity", "summary"] } },
        contractChange: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params, signal) => {
      const p = params as Record<string, unknown>;
      const rootDir = api.rootDir ?? process.cwd();
      const { validateReview, appendReview, loadReviews, reviewGate } = await import("../review.js");
      if (p.action === "prepare") {
        const { newNonce, buildReviewerPrompt, addPending } = await import("../review-spawn.js");
        const head = String(p.headSha ?? "").toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(head)) return jsonResult({ ok: false, error: "headSha must be the full 40-hex commit sha to review" });
        if (p.pr !== undefined && (typeof p.pr !== "number" || !Number.isInteger(p.pr) || p.pr < 1)) return jsonResult({ ok: false, error: "pr must be a positive integer" });
        const refOk = (v: unknown): boolean => v === undefined || (typeof v === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(v));
        const cmdOk = (v: unknown): boolean => v === undefined || (typeof v === "string" && /^[A-Za-z0-9 ._\/:=@+-]{1,200}$/.test(v));
        if (!refOk(p.base)) return jsonResult({ ok: false, error: "base must be a plain git ref" });
        if (!cmdOk(p.buildCommand) || !cmdOk(p.testCommand)) return jsonResult({ ok: false, error: "buildCommand/testCommand must be plain commands (letters, digits, space and . _ / : = @ + -)" });
        const nonce = newNonce();
        const author = typeof p.author === "string" && p.author.trim() ? p.author.trim().slice(0, 100) : undefined;
        await addPending(rootDir, nonce, { headSha: head, ...(typeof p.pr === "number" ? { pr: p.pr } : {}), ...(author ? { author } : {}), createdAt: Date.now() });
        const prompt = buildReviewerPrompt({ headSha: head, ...(typeof p.pr === "number" ? { pr: p.pr } : {}), ...(p.base ? { base: String(p.base) } : {}), ...(p.buildCommand ? { buildCommand: String(p.buildCommand) } : {}), ...(p.testCommand ? { testCommand: String(p.testCommand) } : {}) }, nonce);
        return jsonResult({ ok: true, nonce, prompt, next: [`provision a checkout at ${head} on a node that is NOT the author's worker (fleet_provision with commit)`, "run the prompt there with fleet_dispatch (harness of your choice), then fleet_await it", `then call fleet_review {action:"collect", node, runId}`], note: "The nonce is single-use and expires in 24 hours." });
      }
      if (p.action === "collect") {
        const { peekPending, takePending, parseReviewerOutput, unexecutedClaims, contradictedClaims, headBinding } = await import("../review-spawn.js");
        const { loadLedger } = await import("../ledger.js");
        const entry = (await loadLedger(rootDir)).find((r) => r.runId === p.runId);
        if (!entry) return jsonResult({ ok: false, error: "unknown runId: not in the ledger" });
        const nonce = /REVIEW-TOKEN: (rv-[0-9a-f]{16})\b/.exec(entry.prompt ?? "")?.[1];
        if (!nonce) return jsonResult({ ok: false, error: "that run was not started from a fleet_review prepare task (its prompt has no REVIEW-TOKEN)" });
        const pending = await peekPending(rootDir, nonce);
        if (!pending) return jsonResult({ ok: false, error: "the review token is unknown, already used, or expired: run prepare again" });
        if (typeof p.node === "string" && p.node !== entry.node) return jsonResult({ ok: false, error: `the run was on ${entry.node}, not ${p.node}` });
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === entry.node || n.nodeId === entry.node);
        if (!node) return jsonResult({ ok: false, error: `node ${entry.node} not found` });
        const call = async (params: Record<string, unknown>) => payloadOf(await api.runtime.nodes.invoke({ nodeId: node.nodeId, command: "opencode.run", params, timeoutMs: 30_000, signal }));
        const st = await call({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: entry.runId, report: true });
        if (!st.finishedAt) return jsonResult({ ok: false, error: "the reviewer run has not finished", status: st.alive ? "running" : "no-completion-record" });
        const manifest = (st.manifest as { commands?: Array<{ tool?: string; input?: string }> } | undefined)?.commands ?? [];
        const res = await call({ prompt: "__RUN_RESULT__", cwd: "/", transport: "http", runId: entry.runId });
        // Issue #270: `res.result` is the engine's PARSED result object
        // ({ ok, summary, ... }) — the reviewer's fenced verdict lives in the
        // `summary` field. String(res.result) yielded "[object Object]" and
        // never found the block. Prefer the summary text; fall back to a raw
        // string for older nodes that returned one directly.
        const resultText = (res.result && typeof res.result === "object" && typeof (res.result as { summary?: unknown }).summary === "string")
          ? String((res.result as { summary: string }).summary)
          : String(res.result ?? "");
        const parsed = parseReviewerOutput(resultText);
        if (!parsed.ok) return jsonResult({ ok: false, error: parsed.error });
        const report = parsed.report;
        const claimed = (report.commands ?? []).map((c) => String(c.command ?? ""));
        if (String(report.verdict).toUpperCase() === "PASS") {
          const bind = headBinding(report, pending.headSha, manifest);
          if (!bind.ok) return jsonResult({ ok: false, error: bind.error });
          const contradicted = contradictedClaims(report.commands ?? [], manifest as Array<{ input?: string; exitCode?: number }>);
          if (contradicted.length) return jsonResult({ ok: false, error: `the reviewer reports exit 0 for commands the run's own manifest recorded as failing: ${contradicted.join("; ")}` });
          const missing = unexecutedClaims(claimed, manifest);
          if (missing.length) return jsonResult({ ok: false, error: `the reviewer claims commands that are not in the run's executed-command manifest: ${missing.map((m) => m.slice(0, 80)).join(" | ")}` });
        }
        const v = validateReview(
          { verdict: report.verdict, headSha: pending.headSha, reviewer: `worker:${entry.node}/${entry.runId}`, ...(pending.author ? { author: pending.author } : {}), ...(pending.pr ? { pr: pending.pr } : {}), evidence: { commands: report.commands ?? [] }, findings: report.findings, ...(typeof report.contractChange === "boolean" ? { contractChange: report.contractChange } : {}) },
          new Date(), `rv-${randomUUID().slice(0, 8)}`, { source: "spawned", runId: entry.runId, node: entry.node },
        );
        if (!v.ok) return jsonResult({ ok: false, error: v.error });
        if (!(await takePending(rootDir, nonce))) return jsonResult({ ok: false, error: "the review token was already used" });
        await appendReview(rootDir, v.record);
        return jsonResult({ ok: true, reviewId: v.record.id, verdict: v.record.verdict, headSha: v.record.headSha, source: "spawned", runId: entry.runId });
      }
      if (p.action === "check") {
        const g = reviewGate(await loadReviews(rootDir), String(p.headSha ?? ""), typeof p.pr === "number" ? p.pr : undefined, p.requireSource === "spawned" ? { requireSource: "spawned" } : {});
        return jsonResult({ ok: true, allow: g.allow, status: g.status, ...(g.reason ? { reason: g.reason } : {}), ...(g.record ? { reviewId: g.record.id, reviewedAt: g.record.recordedAt } : {}) });
      }
      if (p.action !== "record") return jsonResult({ ok: false, error: "action must be record, check, prepare or collect" });
      const v = validateReview(p, new Date(), `rv-${randomUUID().slice(0, 8)}`);
      if (!v.ok) return jsonResult({ ok: false, error: v.error });
      await appendReview(rootDir, v.record);
      return jsonResult({ ok: true, reviewId: v.record.id, verdict: v.record.verdict, headSha: v.record.headSha });
    },
  });
}
