import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildJsonPluginConfigSchema, jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shq } from "./shell.js";
import { buildOpenCodeCommand, parseOpenCodeOutput, type OpenCodeTask } from "./opencode.js";
import { SSH_ARGS } from "./ssh.js";

/** OpenCode task plus the dispatch watchdog knobs (idle/duration guards). */
type FleetOpenCodeTask = OpenCodeTask & {
  /** Kill the run if no output chunk arrives for this long, ms. */
  maxIdleMs?: number;
  /** Kill the run if total runtime exceeds this, ms. */
  maxDurationMs?: number;
};

/** One running OpenCode process on a node (from `ps`). */
interface NodeActivityEntry {
  pid?: number;
  elapsed?: string;
  cpu?: string;
  command?: string;
  error?: string;
}

/**
 * opencode-fleet — orchestrate OpenCode across multiple remote OpenClaw nodes.
 *
 * Two-sided plugin:
 *  - Gateway side: registers the `opencode.run` node invoke policy (permission
 *    boundary) + the fleet tools (fleet_dispatch/status/abort/diff).
 *  - Node side:   declares `opencode.run` as a node host command that executes
 *    OpenCode on the node's shell.
 *
 * Credentials stay on the node — the Gateway relays only the task prompt and
 * workspace path.
 */

interface FleetConfig {
  defaultTransport?: "http" | "acp";
  nodePrefixes?: string[];
  defaultTimeoutMs?: number;
  apertureUrl?: string;
}

export default definePluginEntry({
  id: "opencode-fleet",
  name: "OpenCode Fleet",
  description:
    "Orchestrate OpenCode across multiple remote OpenClaw nodes (dev2, dev3, ...). Dispatch coding tasks, check fleet status, abort runaway sessions, and pull diffs — over the authenticated node channel.",
  configSchema: buildJsonPluginConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      defaultTransport: {
        type: "string",
        enum: ["http", "acp"],
        default: "http",
        description: "Default OpenCode transport (http or acp).",
      },
      nodePrefixes: {
        type: "array",
        items: { type: "string" },
        default: ["dev"],
        description: "Node display-name prefixes considered fleet members.",
      },
      defaultTimeoutMs: {
        type: "number",
        default: 300000,
        description: "Default timeout for OpenCode runs, ms.",
      },
      apertureUrl: {
        type: "string",
        default: "https://ai.tailf9480.ts.net/v1/models",
        description: "Aperture gateway model catalog URL.",
      },
    },
  }),

  // ------------------------------------------------------------------
  // Node host command: `opencode.run`
  // Runs OpenCode on the node's shell. Installed on each fleet node.
  // ------------------------------------------------------------------
  nodeHostCommands: [
    {
      command: "opencode.run",
      cap: "opencode",
      dangerous: true,
      handle: async (paramsJSON, io, context) => {
        const task = paramsJSON ? (JSON.parse(paramsJSON) as OpenCodeTask) : null;
        if (!task || !task.prompt || !task.cwd) {
          return JSON.stringify({ ok: false, error: "opencode.run requires prompt and cwd." });
        }

        // Special control messages (abort / diff / models) handled by the gateway tool.
        if (task.prompt === "__ABORT__") {
          // Kill running OpenCode processes on the node (real abort).
          const killed = await runShell(
            `pkill -f "opencode (run|acp|serve)" 2>/dev/null; echo "aborted"`,
            15_000,
            context?.signal,
          );
          return JSON.stringify({ ok: true, aborted: true, sessionId: task.sessionId, detail: killed.trim() });
        }
        if (task.prompt === "__DIFF__") {
          // Show the working-tree diff in the checkout (real diff).
          const diff = await runShell(
            `cd ${shq(task.cwd)} && git diff --stat 2>/dev/null; echo "---"; git diff 2>/dev/null | head -200`,
            30_000,
            context?.signal,
          );
          return JSON.stringify({ ok: true, diff: diff.trim(), sessionId: task.sessionId });
        }
        if (task.prompt === "__MODELS__") {
          const models = await readNodeModels();
          return JSON.stringify({ ok: true, models });
        }
        if (task.prompt === "__ACTIVITY__") {
          // List running OpenCode processes on this node (local ps, no SSH needed here).
          const activity = await runShell(OPCODE_PS_COMMAND, 15_000, context?.signal);
          return JSON.stringify({ ok: true, activity: parseActivity(activity) });
        }
        if (task.prompt === "__STATUS__") {
          // Working-tree state of the checkout (issue #4: manager visibility).
          const st = await runShell(
            `cd ${shq(task.cwd)} && git status --porcelain 2>/dev/null | head -50; echo "---COUNT---"; git status --porcelain 2>/dev/null | wc -l`,
            20_000,
            context?.signal,
          );
          const [files, count] = st.split("---COUNT\\n");
          return JSON.stringify({ ok: true, cwd: task.cwd, uncommittedCount: parseInt((count ?? "0").trim(), 10) || 0, files: files.trim() });
        }
        if (task.prompt === "__RECEIVE__") {
          // Node-channel bundle transfer: accumulate base64 chunks into a
          // temp file across multiple invokes. Used when SSH is unavailable
          // (e.g. Windows nodes). task.chunks: { index, data }[]
          const transferId = String(task.transferId ?? "t");
          const accDir = join(tmpdir(), `fleet-xfer-${transferId}`);
          await (await import("node:fs/promises")).mkdir(accDir, { recursive: true });
          const target = join(accDir, "bundle.b64");
          const expected = parseInt(String(task.chunkIndex ?? ""), 10);
          const chunks = (task.chunks ?? []).slice();
          for (const c of chunks) {
            if (Number.isFinite(expected) && c.index !== expected) {
              return JSON.stringify({ ok: false, error: `chunk out of order: expected ${expected}, got ${c.index}` });
            }
            await (await import("node:fs/promises")).appendFile(target, c.data);
          }
          return JSON.stringify({ ok: true, transferId, appended: chunks.length });
        }
        if (task.prompt === "__UNPACK__") {
          // Decode accumulated base64 and clone into cwd (SSH-free path).
          const transferId = String(task.transferId ?? "t");
          const accDir = join(tmpdir(), `fleet-xfer-${transferId}`);
          const accFile = join(accDir, "bundle.b64");
          try {
            const b64 = await (await import("node:fs/promises")).readFile(accFile, "utf8");
            const bundlePath = remoteBundlePath(transferId);
            await (await import("node:fs/promises")).writeFile(bundlePath, Buffer.from(b64, "base64"));
            const unpackCmd = [
              `rm -rf ${shq(task.cwd)}`,
              `mkdir -p ${shq(task.cwd)}`,
              `git clone -q ${shq(bundlePath)} ${shq(task.cwd)}`,
              task.commit ? `cd ${shq(task.cwd)} && git checkout -q ${shq(task.commit)}` : "",
              `cd ${shq(task.cwd)} && git rev-parse HEAD`,
            ].filter(Boolean).join(" && ");
            const out = await runShell(unpackCmd, 180_000, context?.signal);
            if (!/^[0-9a-f]{7,40}/m.test(out.trim())) {
              return JSON.stringify({ ok: false, error: `unpack failed: ${out.trim().slice(0, 300)}` });
            }
            return JSON.stringify({ ok: true, commit: out.trim().split("\n").pop(), bytes: b64.length });
          } finally {
            await (await import("node:fs/promises")).rm(accDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        if (task.prompt === "__RECEIVE_CLEAN__") {
          const transferId = String(task.transferId ?? "t");
          await (await import("node:fs/promises")).rm(remoteBundlePath(transferId), { force: true }).catch(() => {});
          await (await import("node:fs/promises")).rm(join(tmpdir(), `fleet-xfer-${transferId}`), { recursive: true, force: true }).catch(() => {});
          return JSON.stringify({ ok: true });
        }

        // Per-dispatch environment (issue: agent-specified environment).
        // 1. Git ref selection: refuse when the checkout is dirty, to avoid
        //    clobbering another run's uncommitted work on a shared cwd.
        if (task.ref && (task.ref.branch || task.ref.commit)) {
          const refCheck = await runShell(
            `cd ${shq(task.cwd)} && test -z "$(git status --porcelain 2>/dev/null)" || echo DIRTY`,
            15_000,
            context?.signal,
          );
          if (refCheck.trim().includes("DIRTY")) {
            return JSON.stringify({
              ok: false,
              error: `refused: ${task.cwd} has uncommitted changes; commit or sync them before dispatching with a ref`,
            });
          }
          const refSpec = task.ref.commit ?? task.ref.branch;
          await runShell(
            `cd ${shq(task.cwd)} && git fetch --all --prune 2>/dev/null; git checkout -q ${shq(refSpec ?? "")} && git rev-parse HEAD`,
            60_000,
            context?.signal,
          );
        }

        const command = buildOpenCodeCommand(task);
        // Emit progress chunks to keep the node invoke alive during long runs.
        const onChunk = async (chunk: string) => {
          if (io?.emitChunk) {
            try {
              await io.emitChunk(chunk);
            } catch {
              // Progress emission is best-effort; ignore failures.
            }
          }
        };

        if (task.transport === "acp") {
          const { runAcpPrompt } = await import("./acp-client.js");
          const acpResult = await runAcpPrompt({
            prompt: task.prompt,
            cwd: task.cwd,
            model: task.model,
            agent: task.agent,
            timeoutMs: task.timeoutMs ?? 300_000,
            onChunk,
          });
          return JSON.stringify(acpResult);
        }

        const result = await runShell(
          command,
          task.timeoutMs ?? 300_000,
          context?.signal,
          onChunk,
          task.maxIdleMs,
          task.maxDurationMs,
        );
        return JSON.stringify(parseOpenCodeOutput(result));
      },
    },
  ],

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as FleetConfig;

    // ------------------------------------------------------------------
    // Node invoke policy: `opencode.run` (gateway-side permission boundary)
    // ------------------------------------------------------------------
    api.registerNodeInvokePolicy({
      commands: ["opencode.run"],
      dangerous: true,
      classifyRisk: () => ({ level: "high", family: "opencode-run" }),
      handle: async (ctx) => {
        const task = ctx.params as OpenCodeTask;
        if (!task || typeof task.prompt !== "string" || !task.prompt.trim()) {
          return { ok: false, message: "opencode.run requires a non-empty prompt." };
        }
        if (!task.cwd || typeof task.cwd !== "string") {
          return { ok: false, message: "opencode.run requires a cwd." };
        }
        const result = await ctx.invokeNode({
          params: task,
          timeoutMs: task.timeoutMs,
        });
        if (!result.ok) {
          return { ok: false, message: result.message ?? "opencode.run failed on node." };
        }
        return { ok: true, payload: result.payload };
      },
    });

    // ------------------------------------------------------------------
    // Tools
    // ------------------------------------------------------------------

    api.registerTool({
      name: "fleet_dispatch",
      label: "Fleet Dispatch",
      description:
        "Dispatch an OpenCode coding task to one or more remote OpenClaw nodes (dev2, dev3, ...). Returns per-node results. Use for multi-file coding work on remote dev hosts. Optionally filter nodes by capability constraints (GPU, disk, RAM, tools, models) so work routes to nodes that can actually handle it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: { type: "string", description: "The coding task / goal for OpenCode." },
          cwd: { type: "string", description: "Working directory on the target node(s)." },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          transport: { type: "string", enum: ["http", "acp"], description: "OpenCode transport." },
          model: { type: "string", description: "Optional model override (must exist on node)." },
          agent: { type: "string", description: "Optional OpenCode agent (build/plan)." },
          timeoutMs: { type: "number", description: "Per-node timeout, ms." },
          maxIdleMs: { type: "number", description: "Kill the run if no output for this long, ms (stuck-loop guard). Default 120000." },
          maxDurationMs: { type: "number", description: "Kill the run if total runtime exceeds this, ms (stuck-loop guard). Default 600000." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for the worker process (per-dispatch environment). PATH/HOME/LD_* are ignored for safety." },
          ref: { type: "object", additionalProperties: false, properties: { branch: { type: "string", description: "Branch to check out before running." }, commit: { type: "string", description: "Commit SHA to check out before running." } }, description: "Git ref to check out before running. Refused if the checkout has uncommitted changes." },
          requires: {
            type: "object",
            additionalProperties: false,
            description: "Capability constraints. Only nodes satisfying ALL constraints receive the task.",
            properties: {
              gpu: { type: "boolean", description: "Require a GPU (true) or a specific GPU substring." },
              minDiskGb: { type: "number", description: "Minimum free disk in GB." },
              minMemGb: { type: "number", description: "Minimum RAM in GB." },
              tools: { type: "array", items: { type: "string" }, description: "Required installed tools (e.g. docker, node)." },
              models: { type: "array", items: { type: "string" }, description: "Required available models." },
            },
          },
        },
        required: ["prompt", "cwd"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as {
          prompt: string;
          cwd: string;
          nodes?: string[];
          transport?: "http" | "acp";
          model?: string;
          agent?: string;
          timeoutMs?: number;
          maxIdleMs?: number;
          maxDurationMs?: number;
          env?: Record<string, string>;
          ref?: { branch?: string; commit?: string };
          requires?: {
            gpu?: boolean;
            minDiskGb?: number;
            minMemGb?: number;
            tools?: string[];
            models?: string[];
          };
        };
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        let targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;

        // Apply capability constraints if provided.
        if (p.requires) {
          const { detectNodeCapabilities, satisfiesConstraints } = await import("./capabilities.js");
          const filtered: typeof targets = [];
          const skipped: string[] = [];
          for (const node of targets) {
            const host = node.remoteIp ?? node.displayName ?? node.nodeId;
            const caps = await detectNodeCapabilities(host, node.displayName ?? node.nodeId);
            const check = satisfiesConstraints(caps, p.requires);
            if (check.ok) filtered.push(node);
            else skipped.push(`${node.displayName ?? node.nodeId} (${check.reason})`);
          }
          targets = filtered;
          if (skipped.length) {
            return jsonResult({
              skipped: skipped,
              note: "Nodes skipped for not meeting capability constraints.",
            });
          }
        }

        if (!targets.length) {
          return jsonResult(
            `No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`,
          );
        }

        const transport = p.transport ?? cfg.defaultTransport ?? "http";
        const { upsertRun, newRunId, probeRun, loadLedger } = await import("./ledger.js");
        const rootDir = api.rootDir ?? process.cwd();

        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const runId = newRunId();
          const task: OpenCodeTask = {
            prompt: p.prompt,
            cwd: p.cwd,
            transport,
            model: p.model,
            agent: p.agent,
            timeoutMs: p.timeoutMs ?? cfg.defaultTimeoutMs,
            maxIdleMs: p.maxIdleMs,
            maxDurationMs: p.maxDurationMs,
            env: p.env,
            ref: p.ref,
          };
          // Ledger: record BEFORE the invoke so an agent/worker crash mid-run
          // still leaves a discoverable record (interruption handling).
          await upsertRun(rootDir, {
            runId,
            node: node.displayName ?? node.nodeId,
            cwd: p.cwd,
            prompt: p.prompt,
            model: p.model,
            transport,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "running",
          });
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: task,
            timeoutMs: task.timeoutMs,
            signal,
          }).catch((err: Error) => ({
            invokeTimedOut: true as const,
            message: err.message,
          }));

          // Issue #5: an invoke timeout is NOT proof the run failed — the
          // worker may still be live on the node. Never report a bare
          // TIMEOUT; tell the manager the run MAY be live and how to check.
          const timedOut = (inv as { invokeTimedOut?: boolean }).invokeTimedOut === true;
          let dispatchResult: unknown;
          if (timedOut) {
            dispatchResult = {
              ok: false,
              dispatchTimedOut: true,
              note: `Invoke relay timed out after ${task.timeoutMs}ms waiting for the synchronous result. The run MAY still be live on the node. Do NOT re-dispatch blindly — check fleet_activity / __STATUS__ on this node first, then reattach via fleet_diff or fleet_watch.`,
              error: (inv as { message?: string }).message,
            };
          } else {
            dispatchResult = inv;
          }

          // Post-dispatch working-tree state so the manager knows what state
          // the node is in (issue #4). Also serves as the live-run probe for
          // issue #5: fresh uncommitted changes mean the worker did something.
          let treeState: unknown;
          try {
            const stInv = await api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params: { prompt: "__STATUS__", cwd: p.cwd, transport: "http" },
              timeoutMs: 20000,
              signal,
            });
            const stPayload = (stInv as { payload?: unknown }).payload;
            treeState =
              typeof stPayload === "string" ? JSON.parse(stPayload) : stPayload;
          } catch {
            treeState = { ok: false, note: "status check failed" };
          }
          // Update the ledger with the outcome, extracting sessionId where
          // present so runs can be reattached after interruption.
          const payload = (dispatchResult as { payload?: unknown }).payload;
          const parsedResult =
            typeof payload === "string"
              ? (JSON.parse(payload) as { ok?: boolean; summary?: string; sessionId?: string; handRaised?: boolean; question?: string })
              : ((payload as { ok?: boolean; summary?: string; sessionId?: string; handRaised?: boolean; question?: string } | undefined) ?? {});
          await upsertRun(rootDir, {
            runId,
            node: node.displayName ?? node.nodeId,
            cwd: p.cwd,
            prompt: p.prompt,
            model: p.model,
            transport,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: timedOut ? "timed-out" : parsedResult.ok === false ? "failed" : "completed",
            summary: parsedResult.summary,
            sessionId: parsedResult.sessionId,
            handRaised: parsedResult.handRaised,
            question: parsedResult.question,
          });

          results[node.displayName ?? node.nodeId] = {
            runId,
            result: dispatchResult,
            treeState,
            ...(timedOut ? { dispatchTimedOut: true, mayStillBeRunning: true } : {}),
          };
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_resume",
      label: "Fleet Resume",
      description:
        "Discover fleet work that may be in-flight after an interruption (agent session died, gateway restart, or worker died). Lists ledger runs that are not completed, probes each node for live processes and uncommitted changes, and classifies each run as live / finished-uncommitted / dead. Returns adoption guidance: attach (fleet_diff/fleet_sync) or discard. Call this at the start of any fleet interaction after an interruption.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", description: "Optional: inspect one run instead of all incomplete runs." },
          discard: { type: "boolean", description: "Discard mode: abort any live process on the node for the matched run(s) and mark them discarded. Default false (report only)." },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { runId?: string; discard?: boolean };
        const { loadLedger, upsertRun, probeRun } = await import("./ledger.js");
        const rootDir = api.rootDir ?? process.cwd();
        const runs = await loadLedger(rootDir);
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const hostFor = (name: string) =>
          nodes.find((n) => (n.displayName ?? n.nodeId) === name)?.remoteIp ?? name;

        const incomplete = runs.filter(
          (r) => (p.runId ? r.runId === p.runId : r.state === "running" || r.state === "timed-out"),
        );
        if (!incomplete.length) {
          return jsonResult({ incomplete: 0, note: "No in-flight fleet runs in the ledger." });
        }

        const findings: Array<Record<string, unknown>> = [];
        for (const run of incomplete) {
          const host = hostFor(run.node);
          const probe = await probeRun(host, run.cwd);
          let status: string;
          if (probe.procRunning) status = "live";
          else if ((probe.uncommitted ?? -1) > 0) status = "finished-uncommitted";
          else status = "dead";

          const guidance =
            status === "live"
              ? "Run is LIVE on the node. Wait or reattach with fleet_diff/fleet_watch; do not re-dispatch."
              : status === "finished-uncommitted"
                ? `Worker finished (or died) with ${probe.uncommitted} uncommitted change(s). Adopt: run fleet_sync to commit+push them, or discard.`
                : "No live process and no changes — run died before doing work. Safe to re-dispatch or discard.";

          findings.push({
            runId: run.runId,
            node: run.node,
            cwd: run.cwd,
            prompt: run.prompt.slice(0, 120),
            startedAt: run.startedAt,
            ledgerState: run.state,
            procsRunning: probe.procRunning,
            procs: probe.procs,
            uncommittedChanges: probe.uncommitted,
            status,
            guidance,
          });

          if (p.discard) {
            try {
              await api.runtime.nodes.invoke({
                nodeId: (nodes.find((n) => (n.displayName ?? n.nodeId) === run.node)?.nodeId) ?? run.node,
                command: "opencode.run",
                params: { prompt: "__ABORT__", cwd: run.cwd, transport: "http" },
                timeoutMs: 20000,
                signal,
              });
            } catch {
              // best-effort abort
            }
            await upsertRun(rootDir, { ...run, state: "discarded", updatedAt: new Date().toISOString() });
          }
        }

        return jsonResult({
          incomplete: incomplete.length,
          discarded: p.discard === true,
          runs: findings,
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
          "A clarifying question was raised and answered:",
          `Q: ${p.question}`,
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
      name: "fleet_iterate",
      label: "Fleet Iterate",
      description:
        "Dispatch a task and auto-iterate: if the worker's result indicates failure (build errors, test failures, or a hand-raise), re-dispatch with the errors appended until success, maxIterations, or NO-PROGRESS escalation. Tracks whether each iteration's output differs from the last — if the worker repeats the same errors (no progress), it escalates instead of burning tokens in a blind retry loop.",
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
        };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);

        const maxIter = p.maxIterations ?? 5;
        const escalateOnNoProgress = p.noProgressEscalate ?? true;
        const iterations: Array<{ iter: number; summary?: string; handRaised?: boolean; question?: string; error?: string; progress?: boolean }> = [];
        let currentPrompt = p.prompt;
        let prevFingerprint = "";

        for (let i = 1; i <= maxIter; i++) {
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: {
              prompt: currentPrompt,
              cwd: p.cwd,
              transport: p.transport ?? "http",
              model: p.model,
              timeoutMs: p.timeoutMs ?? 300_000,
            },
            timeoutMs: p.timeoutMs ?? 300_000,
            signal,
          });
          const payload = (inv as { payload?: unknown }).payload;
          const parsed =
            typeof payload === "string"
              ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string })
              : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string } | undefined) ?? {});

          // Fingerprint the output to detect progress (or lack thereof).
          const fingerprint = (parsed.summary ?? "").slice(0, 500) + "|" + (parsed.error ?? "").slice(0, 500);
          const progress = i === 1 ? true : fingerprint !== prevFingerprint;
          prevFingerprint = fingerprint;

          iterations.push({
            iter: i,
            summary: parsed.summary,
            handRaised: parsed.handRaised,
            question: parsed.question,
            error: parsed.error,
            progress,
          });

          // Hand-raise: stop and let the caller answer.
          if (parsed.handRaised) {
            return jsonResult({ iterations, handRaised: true, question: parsed.question, done: false });
          }

          // Success check.
          const looksFailed = parsed.ok === false || /error|failed|timed out|stuck/i.test(parsed.summary ?? "");
          const success = p.successMarker ? (parsed.summary ?? "").includes(p.successMarker) : !looksFailed;
          if (success) {
            return jsonResult({ iterations, done: true, success: true, finalSummary: parsed.summary });
          }

          // NO-PROGRESS escalation: same output as last iteration → stop, don't burn tokens.
          if (escalateOnNoProgress && i > 1 && !progress) {
            return jsonResult({
              iterations,
              done: false,
              success: false,
              escalated: true,
              reason: "no progress across iterations (identical output)",
              recommendation:
                "Escalate: switch to a heavier model, change the approach, or hand off to a human. Do not keep retrying the same prompt.",
            });
          }

          // Re-dispatch with the failure context appended.
          currentPrompt = [
            p.prompt,
            "",
            `Iteration ${i} did not succeed. The worker reported:`,
            parsed.summary ? `Output: ${parsed.summary.slice(0, 2000)}` : "",
            parsed.error ? `Error: ${parsed.error.slice(0, 2000)}` : "",
            "",
            "Fix the issues above and try again. Do not repeat the same approach.",
          ].join("\n");
        }

        return jsonResult({ iterations, done: true, success: false, note: `exceeded ${maxIter} iterations` });
      },
    });

    api.registerTool({
      name: "fleet_watch",
      label: "Fleet Watch",
      description:
        "Dispatch a task and watch it live: streams progress updates to the agent as the worker runs (via onUpdate), polls the node's activity, and returns the final result when the task completes. This is the monitoring view — use it when you want to see a task in progress rather than fire-and-forget.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          prompt: { type: "string", description: "The task / goal for OpenCode." },
          model: { type: "string", description: "Optional model override." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
          timeoutMs: { type: "number", description: "Per-run timeout, ms." },
          pollMs: { type: "number", description: "Activity poll interval, ms (default 15000)." },
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
        };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);

        const timeoutMs = p.timeoutMs ?? 300_000;
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
          },
          timeoutMs,
          signal,
        });

        // Poll activity and stream progress until the dispatch settles.
        let settled = false;
        let lastActivity = "";
        const pollLoop = (async () => {
          while (!settled && Date.now() - startedAt < timeoutMs) {
            await new Promise((r) => setTimeout(r, pollMs));
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

        const result = await dispatchPromise;
        settled = true;
        await pollLoop;

        const payload = (result as { payload?: unknown }).payload;
        const parsed =
          typeof payload === "string"
            ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string })
            : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string } | undefined) ?? {});

        onUpdate?.({
          content: [{ type: "text", text: `Task complete: ${parsed.summary ?? "(no summary)"}` }],
          details: { progress: "complete" },
          progress: { text: "Task complete", visibility: "channel", privacy: "public" },
        });

        return jsonResult({
          done: true,
          ok: parsed.ok,
          summary: parsed.summary,
          handRaised: parsed.handRaised,
          question: parsed.question,
          error: parsed.error,
          elapsedMs: Date.now() - startedAt,
        });
      },
    });

    api.registerTool({
      name: "fleet_provision",
      label: "Fleet Provision",
      description:
        "Provision a repository to one or more fleet nodes WITHOUT giving them GitHub credentials. The manager clones the repo (with its own credentials), ships a git bundle to the node, and the node unpacks it into the target directory. Workers stay credential-free and offline-capable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string", description: "Git URL the manager can access (e.g. git@github.com:org/repo)." },
          cwd: { type: "string", description: "Target directory on the node(s)." },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          branch: { type: "string", description: "Branch to check out (default main)." },
          commit: { type: "string", description: "Optional commit SHA to check out." },
        },
        required: ["repo", "cwd"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { repo: string; cwd: string; nodes?: string[]; branch?: string; commit?: string };
        const { createRepoBundle, provisionToNode, cleanupBundle } = await import("./provision.js");

        // Resolve target nodes.
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(`No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`);
        }

        // Create the bundle once (manager-side, with manager creds).
        const bundle = await createRepoBundle({ repo: p.repo, cwd: p.cwd, branch: p.branch, commit: p.commit });
        if (bundle.error || !bundle.bundlePath) {
          return jsonResult({ ok: false, error: bundle.error ?? "bundle creation failed" });
        }

        // Ship to each node via SSH (manager has SSH access to nodes).
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          // Node-channel fallback for SSH-free nodes (e.g. Windows): ships the
          // bundle in chunks through opencode.run control messages.
          const channelInvoke = async (params: Record<string, unknown>, timeoutMs?: number) =>
            api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params,
              timeoutMs: timeoutMs ?? 60_000,
              signal,
            });
          const r = await provisionToNode(
            host,
            bundle.bundlePath,
            {
              repo: p.repo,
              cwd: p.cwd,
              branch: p.branch,
              commit: p.commit,
            },
            channelInvoke,
          );
          results[node.displayName ?? node.nodeId] = r;
        }
        // Clean up the manager-side bundle + staging dir to avoid bloat.
        await cleanupBundle(bundle.bundlePath);
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_provision_config",
      label: "Fleet Provision Config",
      description:
        "Ship OpenCode agent definitions, global rules (AGENTS.md), skills, and opencode.json to fleet nodes so workers work consistently with the manager. The manager holds the source-of-truth config; workers get it via SSH (no worker credentials needed).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          configDir: {
            type: "string",
            description: "Local dir containing agents/, skills/, AGENTS.md, opencode.json to ship. Defaults to plugin's config dir.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[]; configDir?: string };
        const { provisionConfigToNode, discoverLocalConfig } = await import("./config-provision.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) return jsonResult(`No fleet nodes found.`);

        // Discover what config is available to ship (report search paths).
        const baseDir = p.configDir ?? join(api.rootDir ?? process.cwd(), "config");
        const local = await discoverLocalConfig(baseDir);
        if (!local.agentsDir && !local.globalRulesFile && !local.skillsDir && !local.opencodeConfigFile) {
          return jsonResult({
            ok: false,
            searched: local.report.searched,
            missing: local.report.missing,
            note: `No config found. Create agents/, skills/, AGENTS.md, or opencode.json under the searched paths above.`,
          });
        }

        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await provisionConfigToNode(host, local);
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_sync",
      label: "Fleet Sync",
      description:
        "Pull changes made on a fleet node back to GitHub. The worker creates a bundle of its changes; the manager applies and pushes with its own credentials. Workers never need GitHub credentials.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          repo: { type: "string", description: "Git URL the manager can access." },
          branch: { type: "string", description: "Branch to push to (default main)." },
        },
        required: ["node", "cwd", "repo"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; cwd: string; repo: string; branch?: string };
        const { syncFromNode } = await import("./provision.js");
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const host = node.remoteIp ?? node.displayName ?? node.nodeId;
        const r = await syncFromNode(host, p.cwd, p.repo, p.branch ?? "main");
        return jsonResult(r);
      },
    });

    api.registerTool({
      name: "fleet_cleanup",
      label: "Fleet Cleanup",
      description:
        "Keep fleet nodes tidy: remove leftover git bundles, run git GC on checkouts to prevent bloat, and report disk usage. Run periodically to avoid node bloat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          cwd: { type: "string", description: "Optional checkout dir to GC on each node." },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[]; cwd?: string };
        const { cleanupNode } = await import("./provision.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(`No fleet nodes found.`);
        }
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          const entry: Record<string, unknown> = await cleanupNode(host, p.cwd);
          // Report (not delete) uncommitted worker changes (issue #4).
          if (p.cwd) {
            try {
              const stInv = await api.runtime.nodes.invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: { prompt: "__STATUS__", cwd: p.cwd, transport: "http" },
                timeoutMs: 20000,
                signal,
              });
              const stPayload = (stInv as { payload?: unknown }).payload;
              entry.treeState = typeof stPayload === "string" ? JSON.parse(stPayload) : stPayload;
            } catch {
              entry.treeState = { ok: false, note: "status check failed" };
            }
          }
          results[node.displayName ?? node.nodeId] = entry;
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_deploy",
      label: "Fleet Deploy",
      description:
        "One-command deploy of the opencode-fleet plugin: build, pack, install on the gateway + all worker nodes, restart node services. Returns a gatewayRestartRequired signal — the caller must perform the final gateway restart (it kills the session). Use after any plugin code change.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pluginDir: {
            type: "string",
            description: "Plugin repo root (where package.json lives). Defaults to the plugin's own dir.",
          },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node SSH hosts to deploy to. Omit for all fleet nodes.",
          },
          restartNodes: { type: "boolean", description: "Restart node services after install (default true)." },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { pluginDir?: string; nodes?: string[]; restartNodes?: boolean };
        const { deployPlugin } = await import("./deploy.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        const hosts = targets.map((n) => n.remoteIp ?? n.displayName ?? n.nodeId);
        const pluginDir = p.pluginDir ?? join(api.rootDir ?? process.cwd(), "..");
        const r = await deployPlugin({
          pluginDir,
          nodes: hosts,
          restartNodes: p.restartNodes ?? true,
        });
        return jsonResult(r);
      },
    });

    api.registerTool({
      name: "fleet_recipe_recommend",
      label: "Fleet Recipe Recommend",
      description:
        "Recommend the best (model, thinking, agent, transport) combo for a task type + codebase, learned from past outcomes. Gives agents knobs to turn for speed / token efficiency: use a light model for simple tasks, a heavier model for complex ones, and a review-grade model for review. Returns the recommended combo and whether it was learned or a default.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskType: {
            type: "string",
            enum: ["simple-fix", "refactor", "feature", "review", "explore"],
            description: "Type of task.",
          },
          codebase: { type: "string", description: "Repo or codebase name." },
        },
        required: ["taskType", "codebase"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { taskType: string; codebase: string };
        const { recommendCombo, seedDefaults, resolveModelForClass } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        const seed = seedDefaults().find((d) => d.taskType === p.taskType);
        const defaults = seed?.combo ?? {
          model: "aperture-anthropic/glm-5.3-flash:cloud",
          transport: "http",
        };
        const rec = await recommendCombo(storePath, p.taskType, p.codebase, defaults);

        // Resolve the recommended model class against the CURRENT catalog so
        // the recommendation survives model churn (4-6 week cycle).
        let availableModels: string[] = [];
        try {
          const res = await fetch(cfg.apertureUrl ?? "https://ai.tailf9480.ts.net/v1/models", { signal });
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id?: string }> };
            availableModels = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
          }
        } catch {
          // Catalog unavailable — use the stored model as-is.
        }
        const modelClass = seed?.modelClass ?? "mid";
        const resolvedModel = resolveModelForClass(modelClass, availableModels, rec.combo.model);

        return jsonResult({
          ...rec,
          modelClass,
          resolvedModel,
          note:
            "Model resolved to the current catalog for its capability class, so the recipe stays valid as models churn.",
        });
      },
    });

    api.registerTool({
      name: "fleet_recipe_record",
      label: "Fleet Recipe Record",
      description:
        "Record the outcome of a fleet dispatch (combo used, tokens, cost, success, churn) so the recipe store learns which LLM/tooling/prompt combos work for which codebases and tasks. Call this after each dispatch to improve future recommendations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskType: { type: "string", description: "Type of task (simple-fix, refactor, feature, review, explore)." },
          codebase: { type: "string", description: "Repo or codebase name." },
          model: { type: "string", description: "Model used." },
          thinking: { type: "string", enum: ["low", "medium", "high"], description: "Thinking level used." },
          agent: { type: "string", description: "Agent used (build, plan, code-reviewer, explore)." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport used." },
          tokens: { type: "number", description: "Token usage." },
          cost: { type: "number", description: "Cost in USD." },
          success: { type: "boolean", description: "Whether the task succeeded." },
          churn: { type: "boolean", description: "Whether the task churned (too-light model / repeated attempts)." },
          rating: { type: "number", description: "Subjective rating 1-5 (5 = excellent fit for this task)." },
          goodFor: { type: "string", description: "What this combo was good for (indication)." },
          badFor: { type: "string", description: "What this combo was bad for (contraindication)." },
          notes: { type: "string", description: "Free-text notes on what worked." },
        },
        required: ["taskType", "codebase", "model", "success"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as {
          taskType: string;
          codebase: string;
          model: string;
          thinking?: "low" | "medium" | "high";
          agent?: string;
          transport?: "http" | "acp";
          tokens?: number;
          cost?: number;
          success: boolean;
          churn?: boolean;
          rating?: number;
          goodFor?: string;
          badFor?: string;
          notes?: string;
        };
        const { recordOutcome } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        const entry = await recordOutcome(storePath, {
          taskType: p.taskType,
          codebase: p.codebase,
          combo: { model: p.model, thinking: p.thinking, agent: p.agent, transport: p.transport },
          tokens: p.tokens,
          cost: p.cost,
          success: p.success,
          churn: p.churn,
          rating: p.rating,
          goodFor: p.goodFor,
          badFor: p.badFor,
          notes: p.notes,
          timestamp: new Date().toISOString(),
        });
        return jsonResult(entry);
      },
    });

    api.registerTool({
      name: "fleet_recipe_list",
      label: "Fleet Recipe List",
      description: "List all learned fleet recipes (task type + codebase + combo + stats) so agents can see what combos have been tried and how they performed.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const { loadStore } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        const store = await loadStore(storePath);
        return jsonResult(store.recipes);
      },
    });

    api.registerTool({
      name: "fleet_models",
      label: "Fleet Models",
      description:
        "List the LLM models available to OpenCode on fleet nodes (via the Aperture gateway). Returns model ids, provider, context window, and pricing so you can pick the right model per task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: {
            type: "string",
            description: "Optional node to query. Omit to query the Aperture gateway directly.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node?: string };
        // If a node is specified, read its OpenCode config for the model catalog.
        if (p.node) {
          const list = await api.runtime.nodes.list();
          const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
          if (!node) return jsonResult(`Node "${p.node}" not found.`);
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: { prompt: "__MODELS__", cwd: "/", transport: "http" },
            timeoutMs: 20000,
            signal,
          });
          return jsonResult(inv);
        }
        // Otherwise query the Aperture gateway directly.
        const apertureUrl = cfg.apertureUrl ?? "https://ai.tailf9480.ts.net/v1/models";
        try {
          const res = await fetch(apertureUrl, { signal });
          if (!res.ok) return jsonResult(`Aperture gateway returned ${res.status}.`);
          const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
          const models = (data.data ?? []).map((m) => ({
            id: m.id,
            displayName: m.display_name,
            contextWindow: m.context_window_tokens,
            maxOutput: m.max_output_tokens,
            pricing: m.pricing,
            provider: (m.metadata as { provider?: { name?: string } } | undefined)?.provider?.name,
          }));
          return jsonResult(models);
        } catch (err) {
          return jsonResult(`Failed to query Aperture: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "fleet_status",
      label: "Fleet Status",
      description: "Show health and connectivity of all fleet OpenCode nodes (dev2, dev3, ...).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const list = await api.runtime.nodes.list();
        return jsonResult(
          (list.nodes ?? []).map((n) => ({
            node: n.displayName ?? n.nodeId,
            id: n.nodeId,
            connected: n.connected ?? false,
            platform: n.platform,
            commands: n.commands ?? [],
            invocable: n.invocableCommands ?? [],
          })),
        );
      },
    });

    api.registerTool({
      name: "fleet_activity",
      label: "Fleet Activity",
      description:
        "Show running OpenCode processes on fleet nodes: pid, elapsed time, cpu, and command. SSHes into each node and inspects its process table so you can see which nodes are busy before dispatching more work.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[] };
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(
            `No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`,
          );
        }
        const results: Record<string, NodeActivityEntry[] | { error: string }> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await getNodeActivity(host, async () => {
            // Fallback: ask the node host command to run ps locally.
            const inv = await api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params: { prompt: "__ACTIVITY__", cwd: "/", transport: "http" },
              timeoutMs: 20000,
              signal,
            });
            const payload = (inv as { payload?: unknown }).payload;
            const parsed =
              typeof payload === "string"
                ? (JSON.parse(payload) as { activity?: NodeActivityEntry[]; error?: string })
                : ((payload as { activity?: NodeActivityEntry[]; error?: string } | undefined) ?? {});
            if (parsed.activity) return parsed.activity;
            return { error: parsed.error ?? "node returned no activity" };
          });
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_capabilities",
      label: "Fleet Capabilities",
      description:
        "Detect and report each fleet node's capabilities (CPU, RAM, disk, GPU, installed tools, available models). Use this to route work to nodes that can handle it, especially when nodes have diverging capabilities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[] };
        const { detectNodeCapabilities } = await import("./capabilities.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = nodes.filter((n) =>
          (cfg.nodePrefixes ?? ["dev"]).some((prefix) => (n.displayName ?? n.nodeId).startsWith(prefix)),
        );
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) return jsonResult(`No fleet nodes found.`);
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await detectNodeCapabilities(host, node.displayName ?? node.nodeId);
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_abort",
      label: "Fleet Abort",
      description: "Abort a running OpenCode session on a fleet node.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          sessionId: { type: "string", description: "Optional session id to abort." },
        },
        required: ["node"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; sessionId?: string };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: { prompt: "__ABORT__", cwd: "/", transport: "http", sessionId: p.sessionId },
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
        },
        required: ["node", "sessionId"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; sessionId: string };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: { prompt: "__DIFF__", cwd: "/", transport: "http", sessionId: p.sessionId },
          timeoutMs: 30000,
          signal,
        });
        return jsonResult(inv);
      },
    });
  },
});

/** ps command listing running OpenCode processes on a node. */
function remoteBundlePath(transferId: string): string {
  // Windows-safe temp path (no /tmp assumption).
  return join(tmpdir(), `fleet-${transferId}.bundle`);
}

const OPCODE_PS_COMMAND =
  // Match any opencode invocation — including `timeout N opencode run ...`
  // wrapper processes and detached/`nohup` runs — so activity detection
  // covers dispatch runs, not just serve/acp daemons (issue #5).
  `ps -eo pid,etime,pcpu,command | grep -iE "[o]pencode" | grep -vE "grep|opencode-fleet|node-activity" | grep -vE "^[0-9]+ .*opencode (serve|acp) --hostname" || true`;

/**
 * Parse `ps -eo pid,etime,pcpu,command` lines into activity entries.
 */
function parseActivity(raw: string): NodeActivityEntry[] {
  const out: NodeActivityEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pid, elapsed, cpu, ...rest] = trimmed.split(/\s+/);
    const command = rest.join(" ");
    if (!pid || !command) continue;
    out.push({
      pid: Number.isFinite(Number(pid)) ? Number(pid) : undefined,
      elapsed,
      cpu,
      command,
    });
  }
  return out;
}

/**
 * Manager-side: list running OpenCode processes on a node over SSH
 * (same execFile ssh pattern as provision.ts). Falls back to the node
 * invoke command (`__ACTIVITY__`) when SSH is unavailable.
 */
async function getNodeActivity(
  host: string,
  invokeFallback?: () => Promise<NodeActivityEntry[] | { error: string }>,
): Promise<NodeActivityEntry[] | { error: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      "ssh",
      [...SSH_ARGS, host, OPCODE_PS_COMMAND],
      { timeout: 20_000 },
    );
    return parseActivity(stdout);
  } catch (sshErr) {
    // Fall back to the node host command channel when SSH is unavailable.
    if (invokeFallback) return invokeFallback();
    return { error: (sshErr as Error).message };
  }
}

/**
 * Read the model catalog from the node's OpenCode config.
 */
async function readNodeModels(): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(homedir(), ".config", "opencode", "opencode.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      model?: string;
      provider?: Record<string, { name?: string; models?: Record<string, { name?: string }> }>;
    };
    const out: Array<Record<string, unknown>> = [];
    if (cfg.model) out.push({ default: true, id: cfg.model });
    for (const [providerId, p] of Object.entries(cfg.provider ?? {})) {
      for (const [modelId, m] of Object.entries(p.models ?? {})) {
        out.push({ provider: providerId, id: `${providerId}/${modelId}`, name: m.name ?? modelId });
      }
    }
    return out;
  } catch {
    return [{ error: "no OpenCode config found on this node" }];
  }
}

/**
 * Run a shell command on the node host, streaming output chunks.
 * Watchdog: kills the process if no output arrives within maxIdleMs, or if
 * total runtime exceeds maxDurationMs (stuck-loop guard).
 */
async function runShell(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => Promise<void>,
  maxIdleMs?: number,
  maxDurationMs?: number,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastChunkAt = Date.now();
    const startedAt = Date.now();

    const finish = (extra: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      resolve(stdout + (stderr ? `\n${stderr}` : "") + extra);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("\n[timeout]");
    }, timeoutMs);

    // Idle watchdog: kill if no output for maxIdleMs.
    const idleTimer = setInterval(() => {
      if (settled) return;
      if (maxIdleMs && Date.now() - lastChunkAt > maxIdleMs) {
        child.kill("SIGKILL");
        finish(`\n[stuck: no output for ${Math.round((Date.now() - lastChunkAt) / 1000)}s]`);
      }
      if (maxDurationMs && Date.now() - startedAt > maxDurationMs) {
        child.kill("SIGKILL");
        finish(`\n[stuck: exceeded max duration ${Math.round(maxDurationMs / 1000)}s]`);
      }
    }, 5000);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      lastChunkAt = Date.now();
      if (onChunk) onChunk(s).catch(() => {});
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish(`\nERROR: ${err.message}`);
    });
    child.on("close", (code) => {
      finish("");
    });

    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}
