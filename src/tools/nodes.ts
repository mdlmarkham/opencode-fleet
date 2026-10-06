import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { type NodeActivityEntry } from "../node/runtime.js";
import { parseBudgetConfig } from "../budget.js";
import { type FleetConfig, getNodeActivity } from "./shared.js";

export function registerNodesTools(api: OpenClawPluginApi, cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_capacity",
    label: "Fleet Capacity",
    description:
      "Concurrency slots per node: the limit (node `maxConcurrent`, else `capacity.maxConcurrentPerNode`, else unlimited), runs holding slots with ages, free slots, and runs suspected stale (still `running` past `capacity.staleAfterMs`; settle with fleet_run_status or fleet_recover). A dispatch to a full node returns a retryable `no-capacity`. Also today's budget (spent, remaining, per-dispatch caps) when configured.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { nodes: { type: "array", items: { type: "string" }, description: "Node display names or ids. Omit for all fleet nodes." } },
    },
    execute: async (_toolCallId, params) => {
      const p = params as { nodes?: string[] };
      const cfg = (api.pluginConfig ?? {}) as FleetConfig;
      const list = await api.runtime.nodes.list();
      const fleet = (await import("../membership.js")).resolveFleetNodes(list.nodes ?? [], cfg);
      const targets = p.nodes?.length ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId)) : fleet;
      const { slotLimit, staleAfter, liveRuns } = await import("../capacity.js");
      const { loadLedger } = await import("../ledger.js");
      const runs = await loadLedger(api.rootDir ?? process.cwd());
      const now = Date.now();
      const age = (r: { updatedAt?: string; startedAt: string }) => Math.round((now - Date.parse(r.updatedAt || r.startedAt)) / 1000);
      const out = targets.map((n) => {
        const name = n.displayName ?? n.nodeId;
        const limit = slotLimit(cfg.capacity, (n as { member?: { maxConcurrent?: unknown } }).member);
        const { live, stale } = liveRuns(runs, [n.displayName, n.nodeId].filter((x): x is string => !!x), now, staleAfter(cfg.capacity));
        return {
          node: name,
          ...(limit.ok ? { limit: limit.limit ?? null, free: limit.limit === undefined ? null : Math.max(0, limit.limit - live.length) } : { configError: limit.error }),
          running: live.map((r) => ({ runId: r.runId, ageSeconds: age(r) })),
          suspectedStale: stale.map((r) => ({ runId: r.runId, ageSeconds: age(r) })),
        };
      });
      // Issue #39 (budget slice): today's spend/remaining and the per-dispatch caps,
      // derived from the ledger, so budget state is visible without a dispatch refusal.
      const { parseBudgetConfig, daySpent } = await import("../budget.js");
      const budget = parseBudgetConfig(cfg.budget);
      const spent = budget.ok && budget.config ? daySpent(runs, new Date(now).toISOString()) : undefined;
      return jsonResult({
        ok: true,
        staleAfterMs: staleAfter(cfg.capacity),
        nodes: out,
        ...(budget.ok && budget.config ? { budget: { ...budget.config, spent, ...(spent && budget.config.dailyCostUsd !== undefined ? { remainingCostUsd: Math.max(0, budget.config.dailyCostUsd - spent.costUsd) } : {}), ...(spent && budget.config.dailyTokens !== undefined ? { remainingTokens: Math.max(0, budget.config.dailyTokens - spent.tokens) } : {}) } } : {}),
      });
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
      const apertureUrl = cfg.apertureUrl;
      if (!apertureUrl) {
        return jsonResult("No model catalog configured: set apertureUrl in the opencode-fleet plugin config (an OpenAI-style /v1/models URL), or use nodes that report their own models.");
      }
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
    name: "fleet_board",
    label: "Fleet Board",
    description:
      "ONE call that renders the whole fleet's state: in-flight runs, anything that needs a human (hand-raise, failed verification gate), stale runs, and failures — with age, engine, node and the verification outcome. Use this INSTEAD of polling fleet_run_status per run: it is the single bounded read that answers 'how is it going'. Ledger-backed (fast, no node round-trips per run beyond the ledger).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeLanded: { type: "boolean", description: "Also list completed runs (default false: the quiet majority is summarised in the header only)." },
        staleMinutes: { type: "number", description: "A running run older than this with no completion is 'stale' (default 45)." },
        tasksDir: { type: "string", description: "Directory holding the work-graph journal (tasks.jsonl). When given, the board JOINS each run to its task by issue number and shows plan-vs-execution state/mismatches. Omit to show execution only." },
      },
    },
    execute: async (toolCallId, params) => {
      const p = params as { includeLanded?: boolean; staleMinutes?: number; tasksDir?: string };
      const { loadLedger } = await import("../ledger.js");
      const { renderBoard } = await import("../board.js");
      const entries = await loadLedger(api.rootDir ?? process.cwd());
      const opts: {
        staleMs?: number;
        buckets?: Array<"in-flight" | "needs-you" | "landed" | "failed" | "stale">;
        tasks?: import("../tasks.js").Task[];
      } = {};
      if (typeof p.staleMinutes === "number" && p.staleMinutes > 0) opts.staleMs = p.staleMinutes * 60_000;
      if (p.includeLanded) opts.buckets = ["needs-you", "stale", "failed", "in-flight", "landed"];
      // Issue #132 join: fold the work graph when a tasks dir is supplied.
      if (typeof p.tasksDir === "string" && p.tasksDir.trim() !== "") {
        try {
          const { openTaskTracker } = await import("../tasks.js");
          opts.tasks = await openTaskTracker(p.tasksDir).list();
        } catch {
          /* no/unreadable journal: fall back to execution-only, never fail the board */
        }
      }
      const { text, counts } = renderBoard(entries, opts);
      return jsonResult({ board: text, counts });
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
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
      const targets = p.nodes?.length
        ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
        : fleet;
      if (!targets.length) {
        return jsonResult(
          `No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`,
        );
      }
      const results: Record<string, NodeActivityEntry[] | { error: string } | { skipped: string }> = {};
      for (const node of targets) {
        // Issue #8: skip nodes that don't support opencode.run (e.g. the
        // Windows desktop node) instead of failing the whole call.
        const invocable = (node as { invocableCommands?: string[] }).invocableCommands ?? [];
        if (!invocable.includes("opencode.run")) {
          results[node.displayName ?? node.nodeId] = { skipped: "not an opencode node (no opencode.run command)" };
          continue;
        }
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
      "Report each node's capabilities: CPU, RAM, disk, GPU, installed tools, models, denyBaseline (whether the deny-rule baseline is installed), and isolation support: gitClone, bwrap (present AND usable), isolationLevels (fleet_dispatch refuses a level the node does not list). Use to route work to capable nodes.",
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
      const { detectNodeCapabilities } = await import("../capabilities.js");
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
      const targets = p.nodes?.length
        ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
        : fleet;
      if (!targets.length) return jsonResult(`No fleet nodes found.`);
      const results: Record<string, unknown> = {};
      for (const node of targets) {
        const host = node.remoteIp ?? node.displayName ?? node.nodeId;
        const svc = (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
          ?? (node as { member?: { user?: string } }).member?.user;
        results[node.displayName ?? node.nodeId] = await detectNodeCapabilities(host, node.displayName ?? node.nodeId, svc);
      }
      return jsonResult(results);
    },
  });
}
