import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildJsonPluginConfigSchema, jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { buildOpenCodeCommand, parseOpenCodeOutput, type OpenCodeTask } from "./opencode.js";

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
            `cd "${task.cwd}" && git diff --stat 2>/dev/null; echo "---"; git diff 2>/dev/null | head -200`,
            30_000,
            context?.signal,
          );
          return JSON.stringify({ ok: true, diff: diff.trim(), sessionId: task.sessionId });
        }
        if (task.prompt === "__MODELS__") {
          const models = await readNodeModels();
          return JSON.stringify({ ok: true, models });
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

        const result = await runShell(command, task.timeoutMs ?? 300_000, context?.signal, onChunk);
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
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const task: OpenCodeTask = {
            prompt: p.prompt,
            cwd: p.cwd,
            transport,
            model: p.model,
            agent: p.agent,
            timeoutMs: p.timeoutMs ?? cfg.defaultTimeoutMs,
          };
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: task,
            timeoutMs: task.timeoutMs,
            signal,
          });
          results[node.displayName ?? node.nodeId] = inv;
        }
        return jsonResult(results);
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
          const r = await provisionToNode(host, bundle.bundlePath, {
            repo: p.repo,
            cwd: p.cwd,
            branch: p.branch,
            commit: p.commit,
          });
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

        // Discover what config is available to ship.
        const baseDir = p.configDir ?? join(api.rootDir ?? process.cwd(), "config");
        const local = await discoverLocalConfig(baseDir);
        if (!local.agentsDir && !local.globalRulesFile && !local.skillsDir && !local.opencodeConfigFile) {
          return jsonResult(`No config found in ${baseDir}. Create agents/, skills/, AGENTS.md, or opencode.json there.`);
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
          results[node.displayName ?? node.nodeId] = await cleanupNode(host, p.cwd);
        }
        return jsonResult(results);
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
 */
async function runShell(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => Promise<void>,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        resolve(stdout + (stderr ? `\n${stderr}` : "") + "\n[timeout]");
        settled = true;
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (onChunk) onChunk(s).catch(() => {});
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (!settled) {
        clearTimeout(timer);
        resolve(stdout + (stderr ? `\n${stderr}` : "") + `\nERROR: ${err.message}`);
        settled = true;
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        clearTimeout(timer);
        resolve(stdout + (stderr ? `\n${stderr}` : ""));
        settled = true;
      }
    });

    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}
