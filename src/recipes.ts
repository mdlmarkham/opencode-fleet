/**
 * Fleet recipe store — learn which (LLM, thinking, agent, transport) combos
 * work for which codebases/tasks, and recommend the right combo.
 *
 * Agents record outcomes after each dispatch; the store accumulates which
 * combos work. `recommend` reads the store and picks the best-known combo for
 * a task type, giving agents "knobs" to turn for speed / token efficiency.
 *
 * Knobs:
 *  - model: light (cheap/fast) vs heavy (capable) vs review-grade
 *  - thinking: low/medium/high (reasoning effort)
 *  - agent: build / plan / code-reviewer (subagent)
 *  - transport: http / acp
 *
 * Store: JSON file in the plugin state dir.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface RecipeCombo {
  model: string;
  thinking?: "low" | "medium" | "high";
  agent?: string;
  transport?: "http" | "acp";
}

/**
 * Model capability class — the durable knob that survives model churn.
 * Specific model IDs churn every 4-6 weeks; the class (fast/cheap, mid,
 * heavy/review) is what actually predicts fit for a task type.
 */
export type ModelClass = "fast" | "mid" | "heavy" | "review";

/**
 * Map a model ID to its capability class. Falls back to "mid" when unknown.
 * This is the layer that lets recipes survive model churn: a recipe says
 * "use a fast model for simple-fix", and the resolver maps that to whatever
 * fast model is currently available.
 */
export function classifyModel(model: string): ModelClass {
  const m = model.toLowerCase();
  if (m.includes("flash") || m.includes("haiku") || m.includes("mini") || m.includes("fast") || m.includes("lite")) {
    return "fast";
  }
  if (m.includes("sonnet") || m.includes("glm-5.3") || m.includes("glm-5.2") || m.includes("opus")) {
    return "heavy";
  }
  if (m.includes("review") || m.includes("critic")) {
    return "review";
  }
  return "mid";
}

/**
 * Resolve a capability class to a concrete model from the available catalog.
 * Picks the cheapest/fastest available model in the class, so recipes stay
 * valid as models churn.
 */
export function resolveModelForClass(
  cls: ModelClass,
  availableModels: string[],
  fallback: string,
): string {
  if (!availableModels.length) return fallback;
  // Prefer models whose name matches the class intent.
  const candidates = availableModels.filter((m) => classifyModel(m) === cls);
  if (candidates.length) return candidates[0];
  // Fall back to the first available model.
  return availableModels[0] ?? fallback;
}

export interface RecipeOutcome {
  taskType: string;
  codebase: string;
  combo: RecipeCombo;
  /** Token usage (input+output). */
  tokens?: number;
  /** Cost in USD. */
  cost?: number;
  /** Whether the task succeeded. */
  success: boolean;
  /** Whether the task churned (repeated attempts / too-light model). */
  churn?: boolean;
  /** Free-text notes on what worked. */
  notes?: string;
  /** Subjective rating 1-5 (5 = excellent fit). */
  rating?: number;
  /** What this combo was good for (indication). */
  goodFor?: string;
  /** What this combo was bad for (contraindication). */
  badFor?: string;
  timestamp: string;
}

export interface RecipeEntry {
  taskType: string;
  codebase: string;
  combo: RecipeCombo;
  /** Aggregate stats across outcomes for this combo. */
  avgTokens?: number;
  avgCost?: number;
  successRate?: number;
  churnRate?: number;
  avgRating?: number;
  count: number;
  notes?: string;
  /** Derived: task types this combo is good for. */
  indicatedFor?: string[];
  /** Derived: task types this combo is bad for. */
  contraindicatedFor?: string[];
  lastUsed: string;
}

interface RecipeStore {
  recipes: RecipeEntry[];
  outcomes: RecipeOutcome[];
}

const DEFAULT_STORE: RecipeStore = { recipes: [], outcomes: [] };

/**
 * Load the recipe store from a JSON file.
 */
export async function loadStore(storePath: string): Promise<RecipeStore> {
  try {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw) as RecipeStore;
  } catch {
    return { ...DEFAULT_STORE, recipes: [], outcomes: [] };
  }
}

/**
 * Save the recipe store to a JSON file.
 */
export async function saveStore(storePath: string, store: RecipeStore): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Record an outcome and update the aggregate recipe entry.
 */
export async function recordOutcome(storePath: string, outcome: RecipeOutcome): Promise<RecipeEntry> {
  const store = await loadStore(storePath);
  store.outcomes.push(outcome);

  // Find or create the aggregate entry for this taskType+codebase+combo.
  const key = `${outcome.taskType}|${outcome.codebase}|${outcome.combo.model}|${outcome.combo.thinking ?? ""}|${outcome.combo.agent ?? ""}`;
  let entry = store.recipes.find(
    (r) =>
      r.taskType === outcome.taskType &&
      r.codebase === outcome.codebase &&
      r.combo.model === outcome.combo.model &&
      r.combo.thinking === outcome.combo.thinking &&
      r.combo.agent === outcome.combo.agent,
  );
  if (!entry) {
    entry = {
      taskType: outcome.taskType,
      codebase: outcome.codebase,
      combo: outcome.combo,
      count: 0,
      lastUsed: outcome.timestamp,
    };
    store.recipes.push(entry);
  }

  // Recompute aggregates from all matching outcomes.
  const matching = store.outcomes.filter(
    (o) =>
      o.taskType === outcome.taskType &&
      o.codebase === outcome.codebase &&
      o.combo.model === outcome.combo.model &&
      o.combo.thinking === outcome.combo.thinking &&
      o.combo.agent === outcome.combo.agent,
  );
  const total = matching.length;
  const successes = matching.filter((o) => o.success).length;
  const churns = matching.filter((o) => o.churn).length;
  const tokens = matching.filter((o) => o.tokens != null).map((o) => o.tokens!);
  const costs = matching.filter((o) => o.cost != null).map((o) => o.cost!);
  const ratings = matching.filter((o) => o.rating != null).map((o) => o.rating!);

  entry.count = total;
  entry.successRate = total ? successes / total : 0;
  entry.churnRate = total ? churns / total : 0;
  entry.avgTokens = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : undefined;
  entry.avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined;
  entry.avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : undefined;
  entry.lastUsed = outcome.timestamp;
  if (outcome.notes) entry.notes = outcome.notes;

  // Derive indications / contraindications across ALL outcomes for this combo
  // (not just this taskType), so the store learns "X is good for A, bad for B".
  const allForCombo = store.outcomes.filter(
    (o) =>
      o.combo.model === outcome.combo.model &&
      o.combo.thinking === outcome.combo.thinking &&
      o.combo.agent === outcome.combo.agent,
  );
  const byTask = new Map<string, { success: number; total: number; ratingSum: number; ratingCount: number }>();
  for (const o of allForCombo) {
    const t = byTask.get(o.taskType) ?? { success: 0, total: 0, ratingSum: 0, ratingCount: 0 };
    t.total++;
    if (o.success) t.success++;
    if (o.rating != null) {
      t.ratingSum += o.rating;
      t.ratingCount++;
    }
    byTask.set(o.taskType, t);
  }
  const indicated: string[] = [];
  const contraindicated: string[] = [];
  for (const [taskType, t] of byTask) {
    const successRate = t.total ? t.success / t.total : 0;
    const avgRating = t.ratingCount ? t.ratingSum / t.ratingCount : 0;
    if (successRate >= 0.8 && avgRating >= 4) indicated.push(taskType);
    else if (successRate < 0.5 || avgRating < 2.5) contraindicated.push(taskType);
  }
  entry.indicatedFor = indicated;
  entry.contraindicatedFor = contraindicated;

  await saveStore(storePath, store);
  return entry;
}

/**
 * Recommend the best combo for a task type + codebase.
 * Picks the highest-success-rate, lowest-churn recipe; falls back to defaults.
 */
export async function recommendCombo(
  storePath: string,
  taskType: string,
  codebase: string,
  defaults: RecipeCombo,
): Promise<{ combo: RecipeCombo; entry?: RecipeEntry; source: "learned" | "default" }> {
  const store = await loadStore(storePath);
  const candidates = store.recipes.filter((r) => r.taskType === taskType && r.codebase === codebase);

  if (candidates.length) {
    // Score: success rate up, churn rate down, prefer lower cost.
    // Cost is in dollars (0.01-0.2); scale it modestly so it tunes the
    // ranking without letting a cheap-but-churning model win.
    const scored = candidates
      .map((r) => ({
        r,
        score: (r.successRate ?? 0) * 3 - (r.churnRate ?? 0) * 2 - (r.avgCost ?? 0) * 5,
      }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0].r;
    return { combo: best.combo, entry: best, source: "learned" };
  }

  return { combo: defaults, source: "default" };
}

/**
 * Seed the store with sensible defaults for common task types.
 * Uses model CLASS (durable) rather than specific model IDs, so recipes
 * survive the 4-6 week model churn cycle.
 */
export function seedDefaults(): Array<{ taskType: string; combo: RecipeCombo; modelClass: ModelClass }> {
  return [
    {
      taskType: "simple-fix",
      combo: { model: "aperture-anthropic/deepseek-v4-flash:cloud", thinking: "low", agent: "build", transport: "http" },
      modelClass: "fast",
    },
    {
      taskType: "refactor",
      combo: { model: "aperture-anthropic/glm-5.3-flash:cloud", thinking: "medium", agent: "build", transport: "http" },
      modelClass: "mid",
    },
    {
      taskType: "feature",
      combo: { model: "aperture-anthropic/glm-5.3-flash:cloud", thinking: "medium", agent: "build", transport: "http" },
      modelClass: "mid",
    },
    {
      taskType: "review",
      combo: { model: "aperture-anthropic/glm-5.3-flash:cloud", thinking: "high", agent: "code-reviewer", transport: "acp" },
      modelClass: "review",
    },
    {
      taskType: "explore",
      combo: { model: "aperture-anthropic/deepseek-v4-flash:cloud", thinking: "low", agent: "explore", transport: "http" },
      modelClass: "fast",
    },
  ];
}
