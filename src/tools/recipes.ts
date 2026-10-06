import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { type FleetConfig } from "./shared.js";

export function registerRecipesTools(api: OpenClawPluginApi, cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_recipe_recommend",
    label: "Fleet Recipe Recommend",
    description:
      "Recommend a (model, thinking, agent, transport) combo for a task type + codebase, learned from past outcomes: light model for simple tasks, heavier for complex, review-grade for review. Says whether it was learned or a default.",
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
      const { recommendCombo, seedDefaults, resolveModelForClass } = await import("../recipes.js");
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
        // No catalog configured: skip live resolution and use the stored model.
        const res = cfg.apertureUrl ? await fetch(cfg.apertureUrl, { signal }) : undefined;
        if (res?.ok) {
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
      "Record a dispatch's outcome (combo, tokens, cost, success, churn) so fleet_recipe_recommend learns what works for which codebase and task. Call after each dispatch.",
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
        success: { type: "boolean", description: "Whether the task succeeded. Not trusted on its own: with runId, a run whose verification gate or process FAILED is recorded as a failure whatever is passed here." },
        runId: { type: "string", description: "The fleet runId this outcome is about. When given, success is derived from the run's recorded result (verified/state), never from self-report alone." },
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
        runId?: string;
        churn?: boolean;
        rating?: number;
        goodFor?: string;
        badFor?: string;
        notes?: string;
      };
      const { recordOutcome } = await import("../recipes.js");
      const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
      // Issue #65: success derives from the recorded run, not from self-report.
      let derived = { success: p.success, overridden: false };
      if (p.runId) {
        const { loadLedger, recipeSuccess } = await import("../ledger.js");
        derived = recipeSuccess(p.success, (await loadLedger(api.rootDir ?? process.cwd())).find((r) => r.runId === p.runId));
      }
      const entry = await recordOutcome(storePath, {
        taskType: p.taskType,
        codebase: p.codebase,
        combo: { model: p.model, thinking: p.thinking, agent: p.agent, transport: p.transport },
        tokens: p.tokens,
        cost: p.cost,
        success: derived.success,
        churn: p.churn,
        rating: p.rating,
        goodFor: p.goodFor,
        badFor: p.badFor,
        notes: derived.overridden ? `${p.notes ? `${p.notes}\n` : ""}success overridden to false: run ${p.runId} failed (verification gate or process).` : p.notes,
        timestamp: new Date().toISOString(),
      });
      return jsonResult(derived.overridden ? { ...entry, successOverridden: true } : entry);
    },
  });

  api.registerTool({
    name: "fleet_recipe_list",
    label: "Fleet Recipe List",
    description: "List all learned fleet recipes (task type + codebase + combo + stats) so agents can see what combos have been tried and how they performed.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => {
      const { loadStore } = await import("../recipes.js");
      const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
      const store = await loadStore(storePath);
      return jsonResult(store.recipes);
    },
  });
}
