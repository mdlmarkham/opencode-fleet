/** Scoring loop for the calibration harness (issue #78): one S1 call per item. */

import { decide, type DecideOptions } from "./decision.js";
import type { Item, ScoredItem } from "./calibrate.js";

export interface ScoreRun {
  scored: ScoredItem[];
  failed: string[];
  model?: string;
}

/**
 * Score every item with a boolean "should this be blocked?" question. Items the
 * backend fails on are listed in `failed` and are NOT scored (never as 0).
 */
export async function scoreItems(
  items: Item[],
  question: string,
  stateKey: string,
  opts: DecideOptions & { model?: string; concurrency?: number } = {},
): Promise<ScoreRun> {
  const scored: ScoredItem[] = [];
  const failed: string[] = [];
  let model: string | undefined;
  const queue = [...items];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const r = await decide(
        { state: { [stateKey]: it.text }, questions: { q: { type: "boolean", instructions: question } }, model: opts.model },
        { url: opts.url, fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 60_000 },
      );
      const a = r.ok ? r.answers.q : undefined;
      if (r.ok && a?.type === "boolean") {
        model = r.model;
        scored.push({ ...it, score: a.probabilityTrue });
      } else {
        failed.push(`${it.id}: ${r.ok ? "unexpected answer type" : r.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return { scored, failed, model };
}
