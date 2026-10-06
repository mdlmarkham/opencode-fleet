/**
 * GitHub projection of a mission (issue #132, slice T-1). The internal mission record (#123) is the
 * source of truth; GitHub is a one-way PROJECTION of progress, never on the execution critical path.
 *
 * Rules:
 *  - One owner per field: this module only ever writes ONE comment per mission (found by a hidden marker
 *    and edited in place) and `fleet:`-prefixed labels. It never edits an issue's title, body or anyone
 *    else's comment.
 *  - Idempotent: the rendered body is hashed; an unchanged projection makes no call.
 *  - GitHub down or rate-limited never blocks a mission: a failed send leaves the projection pending and
 *    the next flush retries.
 *  - The token stays with OpenClaw's secrets: it is read at call time from the environment variable the
 *    operator names (`projection.tokenEnv`, default GITHUB_TOKEN), held only in a closure for the request,
 *    never written to config, ledger, journal, logs or the projection itself, and scrubbed from errors.
 *  - Everything in the projection is built from ids, statuses and bounded evidence strings that were
 *    already redacted on entry to the record; mission text is still clipped and stripped of markdown
 *    control characters here.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "./untrusted.js";
import type { MissionRecord } from "./mission-store.js";

export interface GitHubTransport {
  listComments(issue: number): Promise<Array<{ id: number; body: string }>>;
  createComment(issue: number, body: string): Promise<{ id: number }>;
  updateComment(commentId: number, body: string): Promise<void>;
  /** Replace the issue's `fleet:*` labels with exactly `labels`, leaving every other label alone. */
  setFleetLabels(issue: number, labels: string[]): Promise<void>;
}

export const marker = (missionId: string): string => `<!-- fleet-mission:${missionId} -->`;
const clip = (s: string, n: number): string => redactSecrets(s).replace(/[\r\n\t|`<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

const BOX: Record<string, string> = { verified: "x", superseded: "x" };

/** Deterministic progress comment: phase, per-spec checklist, open assumptions and risks. */
export function renderProgress(r: MissionRecord): string {
  const specs = Object.values(r.supervisor.specs);
  const done = specs.filter((s) => s.status === "verified").length;
  const L = [marker(r.missionId), `**Mission \`${clip(r.missionId, 64)}\`** — phase **${r.phase}**, plan v${r.planVersion}, ${done}/${specs.length} specs verified.`, ""];
  for (const s of specs) L.push(`- [${BOX[s.status] ?? " "}] \`${clip(s.spec.id, 40)}\` ${clip(s.spec.goal, 100)} — ${s.status}${s.runId ? ` (run \`${clip(s.runId, 40)}\`)` : ""}${s.escalation ? ` — ESCALATED: ${clip(s.escalation.reason, 120)}` : ""}`);
  const open = r.assumptions.filter((a) => a.status === "open");
  if (open.length) L.push("", "Assumptions made, unconfirmed:", ...open.slice(0, 10).map((a) => `- ${clip(a.text, 160)}`));
  const risks = r.risks.filter((x) => x.severity !== "low");
  if (risks.length) L.push("", "Risks:", ...risks.slice(0, 10).map((x) => `- ${x.severity}: ${clip(x.text, 160)}`));
  L.push("", "_Projected from the mission record by opencode-fleet; the record is the source of truth. Edits here are not read back._");
  return L.join("\n").slice(0, 60_000);
}

/** Labels the projection owns, derived from state only. */
export function fleetLabels(r: MissionRecord): string[] {
  const specs = Object.values(r.supervisor.specs);
  const out = [`fleet:${r.phase}`];
  if (specs.some((s) => s.status === "escalated")) out.push("fleet:escalated");
  return out;
}

export interface ProjState { issue: number; commentId?: number; bodyHash?: string; labelsHash?: string }
const stateFile = (root: string, id: string): string => join(root, ".opencode-fleet", "missions", id, "projection.json");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function loadState(root: string, id: string): Promise<ProjState | undefined> {
  try { const s = JSON.parse(await readFile(stateFile(root, id), "utf8")) as ProjState; return Number.isInteger(s.issue) ? s : undefined; } catch { return undefined; }
}
async function saveState(root: string, id: string, s: ProjState): Promise<void> {
  const f = stateFile(root, id);
  await mkdir(join(root, ".opencode-fleet", "missions", id), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await rename(tmp, f);
}

export interface FlushResult { ok: boolean; sent: Array<"comment-created" | "comment-updated" | "labels">; skipped: boolean; pending?: boolean; error?: string }

/**
 * Project the record onto `issue`. Idempotent (unchanged = no calls) and failure-tolerant: an error is
 * returned as `pending: true`, state is only advanced after a successful send, and nothing throws.
 */
export async function flushProjection(root: string, record: MissionRecord, issue: number, transport: GitHubTransport, scrub: string[] = []): Promise<FlushResult> {
  const sent: FlushResult["sent"] = [];
  const clean = (m: string): string => { let t = redactSecrets(m); for (const s of scrub) if (s) t = t.split(s).join("[REDACTED]"); return t.slice(0, 300); };
  try {
    if (!Number.isInteger(issue) || issue < 1) return { ok: false, sent, skipped: false, error: "issue must be a positive integer" };
    let st = await loadState(root, record.missionId);
    if (st && st.issue !== issue) st = undefined; // a new target starts clean
    st ??= { issue };
    const body = renderProgress(record);
    const bh = hash(body);
    if (st.bodyHash !== bh) {
      if (st.commentId === undefined) {
        const existing = (await transport.listComments(issue)).find((c) => c.body.includes(marker(record.missionId)));
        if (existing) st.commentId = existing.id;
      }
      if (st.commentId === undefined) { st.commentId = (await transport.createComment(issue, body)).id; sent.push("comment-created"); }
      else { await transport.updateComment(st.commentId, body); sent.push("comment-updated"); }
      st.bodyHash = bh;
      await saveState(root, record.missionId, st);
    }
    const labels = fleetLabels(record);
    const lh = hash(labels.join(","));
    if (st.labelsHash !== lh) {
      await transport.setFleetLabels(issue, labels);
      sent.push("labels");
      st.labelsHash = lh;
      await saveState(root, record.missionId, st);
    }
    return { ok: true, sent, skipped: sent.length === 0 };
  } catch (e) {
    return { ok: false, sent, skipped: false, pending: true, error: clean((e as Error).message) };
  }
}

// ---- the REST transport ---------------------------------------------------------------------------------------

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** GitHub REST over an injected fetch. The token lives only in this closure and is sent as a bearer header. */
export function restTransport(repo: string, token: string, fetchFn: Fetch, timeoutMs = 15_000): GitHubTransport {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("projection.repo must look like owner/name");
  const base = `https://api.github.com/repos/${repo}`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${base}${path}`, { method, signal: ctl.signal, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "opencode-fleet" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} -> HTTP ${res.status}${res.status === 403 || res.status === 429 ? " (rate limited or forbidden; will retry)" : ""}`);
      return await res.json();
    } finally { clearTimeout(t); }
  };
  return {
    listComments: async (issue) => ((await call("GET", `/issues/${issue}/comments?per_page=100`)) as Array<{ id: number; body: string }>).map((c) => ({ id: c.id, body: String(c.body ?? "") })),
    createComment: async (issue, body) => ({ id: ((await call("POST", `/issues/${issue}/comments`, { body })) as { id: number }).id }),
    updateComment: async (id, body) => { await call("PATCH", `/issues/comments/${id}`, { body }); },
    setFleetLabels: async (issue, labels) => {
      const cur = (await call("GET", `/issues/${issue}/labels?per_page=100`)) as Array<{ name: string }>;
      const keep = cur.map((l) => l.name).filter((n) => !n.startsWith("fleet:"));
      await call("PUT", `/issues/${issue}/labels`, { labels: [...keep, ...labels] });
    },
  };
}

/** Read the token from the environment variable the operator named; undefined when unset. Never logged. */
export function tokenFromEnv(name: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env[name && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) ? name : "GITHUB_TOKEN"];
  return v && v.trim() ? v.trim() : undefined;
}
