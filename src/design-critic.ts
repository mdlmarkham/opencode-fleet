/**
 * Design critic integration (issue #118), deterministic side. The critic is a role (roles.ts,
 * `design-critic`) whose output is parsed, never trusted. This module decides how that output may touch
 * the design gate, with the rules the issue sets:
 *
 *  - It runs ONLY when the deterministic gate has no hard objection (`shouldRunCritic`): it never
 *    replaces a predictable check.
 *  - Its findings are merged as NUDGES. They are never silently a block: a critic proposal of
 *    `needs-design` or `decompose` becomes a block-candidate only when an operator-enabled rule says so.
 *  - Timeout, unavailability or malformed output falls back to the deterministic verdict and SAYS SO;
 *    "the critic said nothing" is never an allow.
 *  - Hygiene: at most N nudges per dispatch, ranked by severity x confidence; one the caller already
 *    acknowledged for the same decision is suppressed; an identical nudge already shown on a recent run
 *    is not repeated.
 *  - Critic text is untrusted data: clipped and stripped before it is shown, and it can run nothing.
 */

import { createHash } from "node:crypto";
import { checkOutput, BUILTIN_ROLES } from "./roles.js";
import type { GateResult, Objection } from "./design-gate.js";

export interface Critique { claim: string; evidence: string; alternative: string; confidence: number; severity: "low" | "medium" | "high"; /** What the critic proposes the verdict should be, if anything. */ proposes?: "needs-design" | "decompose" }

export type CriticOutcome = { status: "ok"; critiques: Critique[] } | { status: "fallback"; reason: "timeout" | "unavailable" | "malformed"; detail?: string };

const clip = (s: string, n: number): string => s.replace(/[\r\n\t`<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Parse the role's raw output into an outcome. Anything that fails the schema is `malformed`, never repaired. */
export function parseCriticOutput(raw: unknown): CriticOutcome {
  const ck = checkOutput(BUILTIN_ROLES["design-critic"], raw);
  if (!ck.ok) return { status: "fallback", reason: "malformed", detail: ck.error.slice(0, 200) };
  const items = (raw as { critiques: Array<Record<string, unknown>> }).critiques;
  return {
    status: "ok",
    critiques: items.map((c) => ({
      claim: String(c.claim), evidence: String(c.evidence), alternative: String(c.alternative),
      confidence: c.confidence as number, severity: c.severity as Critique["severity"],
      ...(c.proposes === "needs-design" || c.proposes === "decompose" ? { proposes: c.proposes } : {}),
    })),
  };
}

/** The critic runs only when nothing in the deterministic gate is a hard objection. */
export const shouldRunCritic = (g: GateResult): boolean => !g.blocked && g.objections.every((o) => o.severity === "nudge" || o.acknowledged !== undefined);

/** Stable id for a critique, so acknowledgement and de-duplication work across runs. */
export const critiqueId = (c: Pick<Critique, "claim">): string => `critic.${createHash("sha256").update(c.claim.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 10)}`;

const SEV = { low: 1, medium: 2, high: 3 } as const;

export interface MergeOpts {
  /** Max critic nudges added to one dispatch. Default 3. */
  maxNudges?: number;
  /** Critique ids the caller has acknowledged for this decision. */
  acknowledged?: string[];
  /** Critique ids already shown on recent runs of this project. */
  recentlyShown?: string[];
  /** Operator-enabled rule: a critic proposal of needs-design/decompose becomes a block-candidate. */
  operatorBlocks?: boolean;
}

export interface Merged { gate: GateResult; critic: { status: "merged" | "skipped" | "fallback"; reason?: string; added: string[]; suppressed: string[] } }

export function mergeCritique(gate: GateResult, outcome: CriticOutcome, opts: MergeOpts = {}): Merged {
  if (!shouldRunCritic(gate)) return { gate, critic: { status: "skipped", reason: "the deterministic gate has a hard objection; the critic does not run", added: [], suppressed: [] } };
  if (outcome.status === "fallback") return { gate, critic: { status: "fallback", reason: `critic ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}: the deterministic verdict stands`, added: [], suppressed: [] } };
  const ack = new Set(opts.acknowledged ?? []);
  const shown = new Set(opts.recentlyShown ?? []);
  const suppressed: string[] = [];
  const ranked = [...outcome.critiques]
    .map((c) => ({ c, id: critiqueId(c) }))
    .filter(({ id }) => { if (ack.has(id) || shown.has(id)) { suppressed.push(id); return false; } return true; })
    .sort((a, b) => SEV[b.c.severity] * b.c.confidence - SEV[a.c.severity] * a.c.confidence || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, opts.maxNudges ?? 3));
  const added: Objection[] = ranked.map(({ c, id }) => ({
    id,
    severity: opts.operatorBlocks === true && c.proposes ? "block-candidate" : "nudge",
    message: `Critic (${c.severity}, confidence ${c.confidence}): ${clip(c.claim, 200)}${c.proposes ? ` [proposes ${c.proposes}]` : ""}`,
    evidence: clip(c.evidence, 300),
    suggestion: clip(c.alternative, 300),
  }));
  const objections = [...gate.objections, ...added];
  const blocked = objections.some((o) => !o.acknowledged && (o.severity === "block-candidate" || o.severity === "block"));
  const proposes = opts.operatorBlocks === true ? ranked.find(({ c }) => c.proposes)?.c.proposes : undefined;
  // The verdict only changes through an operator-enabled rule; otherwise nudges leave it at accept-with-nudges.
  const verdict = proposes && gate.verdict !== "reject-with-reason" ? proposes : added.length && gate.verdict === "accept" ? "accept-with-nudges" : gate.verdict;
  return { gate: { ...gate, objections, blocked, verdict }, critic: { status: "merged", added: added.map((o) => o.id), suppressed } };
}
