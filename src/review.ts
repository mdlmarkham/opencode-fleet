/**
 * Review records (issues #177, #178): the adversarial review gate as data the merge path can
 * check, instead of a convention. A record is a structured verdict bound to ONE head sha.
 *
 * What this module guarantees, and what it does not:
 *  - A PASS must carry evidence: at least one executed command with exit code 0 and an output
 *    tail, and every recorded command must have succeeded (#184). A reviewer that could not run its tools is BLOCKED, never a PASS.
 *  - A PASS cannot carry an open blocking/major finding.
 *  - A record is bound to a full 40-hex head sha; a PASS for another sha is not a PASS for this
 *    one (a push invalidates it).
 *  - Reviewer-supplied text is untrusted data: redacted and bounded before it is stored.
 *  - It does NOT authenticate the reviewer. Until the plugin owns the reviewer session (#176),
 *    a record is asserted by whoever calls `fleet_review`; every record is marked
 *    `source: "recorded"` so a future spawned-reviewer path is distinguishable. The author/reviewer
 *    independence check compares the names the caller supplies.
 *
 * Pure except for the small append-only store at the bottom.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "./untrusted.js";

export const REVIEW_VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const FINDING_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ReviewCommand {
  command: string;
  exitCode: number;
  outputTail: string;
}
export interface ReviewFinding {
  severity: FindingSeverity;
  summary: string;
  file?: string;
}
export interface ReviewRecord {
  id: string;
  recordedAt: string;
  /** `recorded`: asserted by the caller. `spawned`: collected from an independent worker run (see review-spawn.ts). */
  source: "recorded" | "spawned";
  /** The reviewer run that produced a spawned record. */
  runId?: string;
  reviewerNode?: string;
  verdict: ReviewVerdict;
  headSha: string;
  pr?: number;
  reviewer: string;
  author?: string;
  evidence: { commands: ReviewCommand[] };
  findings: ReviewFinding[];
  contractChange?: boolean;
  note?: string;
}

const MAX_COMMANDS = 20;
const MAX_FINDINGS = 50;
const MAX_CMD = 300;
const MAX_TAIL = 1500;
const MAX_SUMMARY = 500;
const MAX_NAME = 100;
const SHA = /^[0-9a-f]{40}$/;

const clean = (v: unknown, max: number): string => redactSecrets(String(v ?? "")).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const tail = (v: unknown): string => redactSecrets(String(v ?? "")).trim().slice(-MAX_TAIL);

export type ReviewInput = Record<string, unknown>;

/** Validate and normalise a submitted review. Never throws. */
export function validateReview(raw: ReviewInput, now: Date = new Date(), id: string = `rv-${now.getTime().toString(36)}`, meta?: { source: "spawned"; runId: string; node: string }): { ok: true; record: ReviewRecord } | { ok: false; error: string } {
  const verdict = String(raw.verdict ?? "").toUpperCase() as ReviewVerdict;
  if (!REVIEW_VERDICTS.includes(verdict)) return { ok: false, error: `verdict must be one of ${REVIEW_VERDICTS.join(", ")}` };
  const headSha = String(raw.headSha ?? "").toLowerCase();
  if (!SHA.test(headSha)) return { ok: false, error: "headSha must be the full 40-hex commit sha the review was run against" };
  const reviewer = clean(raw.reviewer, MAX_NAME);
  if (reviewer === "") return { ok: false, error: "reviewer (who ran the review) is required" };
  const author = raw.author === undefined ? undefined : clean(raw.author, MAX_NAME);
  if (author && author.toLowerCase() === reviewer.toLowerCase()) {
    return { ok: false, error: "the reviewer must be independent of the author: reviewer and author are the same" };
  }
  let pr: number | undefined;
  if (raw.pr !== undefined) {
    if (typeof raw.pr !== "number" || !Number.isInteger(raw.pr) || raw.pr < 1) return { ok: false, error: "pr must be a positive integer" };
    pr = raw.pr;
  }

  const ev = raw.evidence as { commands?: unknown } | undefined;
  const commands: ReviewCommand[] = [];
  if (ev !== undefined && ev !== null && typeof ev === "object" && ev.commands !== undefined) {
    if (!Array.isArray(ev.commands)) return { ok: false, error: "evidence.commands must be an array" };
    for (const c of ev.commands.slice(0, MAX_COMMANDS)) {
      const o = c as Record<string, unknown>;
      const command = clean(o?.command, MAX_CMD);
      if (command === "" || typeof o?.exitCode !== "number" || !Number.isInteger(o.exitCode)) {
        return { ok: false, error: "each evidence command needs a command string and an integer exitCode" };
      }
      commands.push({ command, exitCode: o.exitCode, outputTail: tail(o.outputTail) });
    }
  }

  const findings: ReviewFinding[] = [];
  if (raw.findings !== undefined) {
    if (!Array.isArray(raw.findings)) return { ok: false, error: "findings must be an array" };
    for (const f of raw.findings.slice(0, MAX_FINDINGS)) {
      const o = f as Record<string, unknown>;
      const severity = String(o?.severity ?? "") as FindingSeverity;
      const summary = clean(o?.summary, MAX_SUMMARY);
      if (!FINDING_SEVERITIES.includes(severity) || summary === "") return { ok: false, error: `each finding needs a severity (${FINDING_SEVERITIES.join("|")}) and a summary` };
      findings.push({ severity, summary, ...(o.file !== undefined ? { file: clean(o.file, 200) } : {}) });
    }
  }

  if (verdict === "PASS") {
    if (!commands.some((c) => c.exitCode === 0)) {
      return { ok: false, error: "a PASS needs evidence: at least one executed command (e.g. the build or test run) with exitCode 0 and its output tail. A reviewer that could not run its tools must record BLOCKED, not PASS" };
    }
    // One passing command must not paper over a failed one (issue #184): every recorded command
    // has to have succeeded, so a failed verify run cannot sit next to `echo ok`.
    const failed = commands.filter((c) => c.exitCode !== 0);
    if (failed.length > 0) {
      return { ok: false, error: `a PASS cannot carry a failed command (${failed.map((c) => `\`${c.command.slice(0, 60)}\` exit ${c.exitCode}`).join(", ")}): re-run and record the real result, or record FAIL` };
    }
    const open = findings.filter((f) => f.severity === "blocking" || f.severity === "major");
    if (open.length > 0) return { ok: false, error: `a PASS cannot carry ${open.length} open blocking/major finding(s); record FAIL` };
  }
  if (verdict === "FAIL" && findings.length === 0) return { ok: false, error: "a FAIL must list at least one finding" };

  return {
    ok: true,
    record: {
      id,
      recordedAt: now.toISOString(),
      source: meta?.source ?? "recorded",
      ...(meta ? { runId: meta.runId, reviewerNode: meta.node } : {}),
      verdict,
      headSha,
      ...(pr !== undefined ? { pr } : {}),
      reviewer,
      ...(author ? { author } : {}),
      evidence: { commands },
      findings,
      ...(typeof raw.contractChange === "boolean" ? { contractChange: raw.contractChange } : {}),
      ...(raw.note !== undefined ? { note: clean(raw.note, MAX_SUMMARY) } : {}),
    },
  };
}

export type ReviewStatus = "PASS" | "FAIL" | "BLOCKED" | "STALE" | "NONE";
export interface ReviewGate {
  allow: boolean;
  status: ReviewStatus;
  reason?: string;
  record?: ReviewRecord;
}

/**
 * Can this head be merged/published? Only a PASS recorded for exactly `headSha` allows. The
 * LATEST record for the sha decides, so a later FAIL or BLOCKED withdraws an earlier PASS.
 * `pr`, when given, scopes the stale diagnosis to that PR's earlier reviews.
 */
export function reviewGate(records: ReviewRecord[], headSha: string, pr?: number, opts: { requireSource?: "spawned" } = {}): ReviewGate {
  const head = String(headSha ?? "").toLowerCase();
  if (!SHA.test(head)) return { allow: false, status: "NONE", reason: "a full 40-hex head sha is required to check for a review" };
  const forHead = records.filter((r) => r.headSha === head);
  const latest = forHead[forHead.length - 1];
  if (latest) {
    if (latest.verdict === "PASS") {
      if (opts.requireSource === "spawned" && latest.source !== "spawned") return { allow: false, status: "NONE", reason: `the PASS for head ${head.slice(0, 12)} was only recorded by the caller; sync.requireReviewSource is "spawned", so it must come from a collected reviewer run (fleet_review prepare, then collect)`, record: latest };
      return { allow: true, status: "PASS", record: latest };
    }
    const why = latest.verdict === "BLOCKED" ? "the reviewer could not run the review (BLOCKED)" : `the review FAILED with ${latest.findings.length} finding(s)`;
    return { allow: false, status: latest.verdict, reason: `${why}; a PASS for head ${head.slice(0, 12)} is required`, record: latest };
  }
  const earlier = pr !== undefined ? records.filter((r) => r.pr === pr && r.verdict === "PASS") : [];
  if (earlier.length > 0) {
    const last = earlier[earlier.length - 1]!;
    return { allow: false, status: "STALE", reason: `the last PASS (${last.headSha.slice(0, 12)}) is for an older head; the head is now ${head.slice(0, 12)} and needs a new review`, record: last };
  }
  return { allow: false, status: "NONE", reason: `no review recorded for head ${head.slice(0, 12)}` };
}

// ---------------------------------------------------------------------------
// Store: append-only JSONL under the plugin root, tolerant of a torn tail.
// ---------------------------------------------------------------------------

export const reviewsPath = (rootDir: string): string => join(rootDir, ".opencode-fleet", "reviews.jsonl");

export async function appendReview(rootDir: string, record: ReviewRecord): Promise<void> {
  const file = reviewsPath(rootDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export async function loadReviews(rootDir: string): Promise<ReviewRecord[]> {
  let text: string;
  try {
    text = await readFile(reviewsPath(rootDir), "utf8");
  } catch {
    return [];
  }
  const out: ReviewRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as ReviewRecord;
      if (r && typeof r === "object" && SHA.test(String(r.headSha)) && REVIEW_VERDICTS.includes(r.verdict)) out.push(r);
    } catch { /* a torn or foreign line is skipped, never trusted */ }
  }
  return out;
}
