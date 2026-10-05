/**
 * Plugin-minted reviews (issue #177), without needing the OpenClaw session API (#176): the plugin
 * writes the reviewer's task, the caller runs it as an ordinary fleet worker run, and the plugin
 * COLLECTS the verdict from that run and records it as `source: "spawned"`.
 *
 * What makes a spawned record stronger than a caller-asserted one:
 *  - the verdict comes from an independent worker run whose id is on the record;
 *  - the run must carry a single-use nonce the plugin minted for exactly one head sha;
 *  - every command the reviewer claims to have run must appear in the run's audit manifest of
 *    commands actually executed, and one of them must be `git rev-parse HEAD` whose output is the
 *    head sha, so the checkout is bound to the reviewed commit;
 *  - the existing PASS rules still apply (evidence, no failed command, no open blocking finding).
 *
 * What it still does not prove: exit codes and output tails are the reviewer's own report (the
 * manifest records that a command ran, not what it returned). Pure except the small pending store.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PENDING_TTL_MS = 24 * 60 * 60_000;
const SHA = /^[0-9a-f]{40}$/;

export interface ReviewRequest {
  headSha: string;
  pr?: number;
  base?: string;
  testCommand?: string;
  buildCommand?: string;
}

export function newNonce(): string { return `rv-${randomUUID().replace(/-/g, "").slice(0, 16)}`; }

/** The task text for the reviewer worker. Data (the sha, the commands) is validated by the caller. */
export function buildReviewerPrompt(req: ReviewRequest, nonce: string): string {
  const build = req.buildCommand ?? "npm run build";
  const test = req.testCommand ?? "npm test";
  return [
    `REVIEW-TOKEN: ${nonce}`,
    "",
    `You are an independent adversarial reviewer of commit ${req.headSha}${req.pr ? ` (pull request #${req.pr})` : ""}. You are NOT the author. Do not modify, commit or push anything.`,
    "",
    "Do this, running the commands for real (do not guess results):",
    "1. `git rev-parse HEAD` and confirm it prints the commit above. If it does not, stop and report BLOCKED.",
    req.base ? `2. Read the change against ${req.base}: \`git diff ${req.base}...HEAD\`.` : "2. Read the change in this checkout.",
    `3. Run the build: \`${build}\`, then the tests: \`${test}\`. A reviewer that cannot run its tools reports BLOCKED, never PASS.`,
    "4. Hunt for real defects: correctness, security (injection, secrets, fail-open paths), missing tests, behaviour changes. Try to reproduce each finding with a command.",
    "",
    "Finish with ONE fenced ```json block, and nothing after it:",
    "```json",
    '{ "verdict": "PASS|FAIL|BLOCKED", "headSha": "<the sha git rev-parse printed>",',
    '  "commands": [ { "command": "<exactly what you ran>", "exitCode": 0, "outputTail": "<last lines of its output>" } ],',
    '  "findings": [ { "severity": "blocking|major|minor|nit", "summary": "<one sentence>", "file": "<path, optional>" } ],',
    '  "contractChange": false }',
    "```",
    "Rules: list EVERY command you ran, including `git rev-parse HEAD`. A PASS must have every command exit 0 and no blocking or major finding. A FAIL must list findings.",
  ].join("\n");
}

export interface ReviewerReport {
  verdict: string;
  headSha?: string;
  commands?: Array<{ command?: unknown; exitCode?: unknown; outputTail?: unknown }>;
  findings?: unknown;
  contractChange?: unknown;
}

const MAX_OUTPUT = 60_000;

/** The reviewer's JSON verdict from its final output: the LAST fenced json block (untrusted text, bounded). */
export function parseReviewerOutput(output: string): { ok: true; report: ReviewerReport } | { ok: false; error: string } {
  const text = String(output ?? "").slice(-MAX_OUTPUT);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1]![1]! : undefined;
  if (raw === undefined) return { ok: false, error: "the reviewer's output has no fenced ```json verdict block" };
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { verdict?: unknown }).verdict !== "string") return { ok: false, error: "the verdict block is not an object with a string `verdict`" };
    return { ok: true, report: v as ReviewerReport };
  } catch {
    return { ok: false, error: "the verdict block is not valid JSON" };
  }
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Claimed commands that are NOT in the run's manifest of executed commands. A claimed command counts
 * as executed when some manifest entry equals it or contains it (a manifest entry is often the whole
 * `cd x && npm test` line the reviewer's shell tool ran).
 */
export function unexecutedClaims(claimed: string[], manifest: Array<{ tool?: string; input?: string }>): string[] {
  const ran = manifest.map((m) => norm(String(m.input ?? "")));
  return claimed.filter((c) => {
    const n = norm(c);
    return n === "" || !ran.some((r) => r === n || r.includes(n));
  });
}

/** Is `git rev-parse HEAD` among the executed commands, and did the reviewer report the head sha as its output? */
export function headBinding(report: ReviewerReport, headSha: string, manifest: Array<{ input?: string }>): { ok: true } | { ok: false; error: string } {
  const claim = (report.commands ?? []).find((c) => typeof c.command === "string" && /\bgit\s+rev-parse\s+(--verify\s+)?HEAD\b/.test(c.command));
  if (!claim) return { ok: false, error: "the reviewer did not run `git rev-parse HEAD`, so the checkout is not bound to the reviewed commit" };
  if (!manifest.some((m) => /\bgit\s+rev-parse\s+(--verify\s+)?HEAD\b/.test(String(m.input ?? "")))) return { ok: false, error: "`git rev-parse HEAD` is not in the run's manifest of executed commands" };
  if (!String(claim.outputTail ?? "").toLowerCase().includes(headSha.toLowerCase())) return { ok: false, error: "the `git rev-parse HEAD` output does not show the reviewed head sha: the reviewer checked out a different commit" };
  if (typeof report.headSha !== "string" || report.headSha.toLowerCase() !== headSha.toLowerCase()) return { ok: false, error: "the reviewer's reported headSha is not the reviewed head" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pending store: nonce -> what it was minted for. Single use, expiring.
// ---------------------------------------------------------------------------

export interface Pending {
  headSha: string;
  pr?: number;
  author?: string;
  createdAt: number;
}

const pendingPath = (rootDir: string): string => join(rootDir, ".opencode-fleet", "review-pending.json");

async function load(rootDir: string): Promise<Record<string, Pending>> {
  try {
    const v = JSON.parse(await readFile(pendingPath(rootDir), "utf8")) as Record<string, Pending>;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
async function save(rootDir: string, v: Record<string, Pending>): Promise<void> {
  const file = pendingPath(rootDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(v), { mode: 0o600 });
  await rename(tmp, file);
}

export async function addPending(rootDir: string, nonce: string, p: Pending, now: number = Date.now()): Promise<void> {
  if (!SHA.test(p.headSha)) throw new Error("headSha must be 40 hex");
  const cur = await load(rootDir);
  for (const [k, v] of Object.entries(cur)) if (now - v.createdAt > PENDING_TTL_MS) delete cur[k];
  cur[nonce] = p;
  await save(rootDir, cur);
}

/** Read a nonce without consuming it (so a collect that fails validation can be retried). */
export async function peekPending(rootDir: string, nonce: string, now: number = Date.now()): Promise<Pending | undefined> {
  const p = (await load(rootDir))[nonce];
  return p && now - p.createdAt <= PENDING_TTL_MS ? p : undefined;
}

/** Take a nonce: returns what it was minted for and removes it (single use). Undefined when unknown or expired. */
export async function takePending(rootDir: string, nonce: string, now: number = Date.now()): Promise<Pending | undefined> {
  const cur = await load(rootDir);
  const p = cur[nonce];
  if (!p) return undefined;
  delete cur[nonce];
  await save(rootDir, cur);
  return now - p.createdAt > PENDING_TTL_MS ? undefined : p;
}
