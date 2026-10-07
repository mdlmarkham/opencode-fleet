/**
 * Per-run audit trail (issue #42): what a run did, in a form that can be read
 * long after the engine and the gateway are gone.
 *
 * Pure parsing and composition live here; the node handler wires the file I/O.
 * Raw evidence stays on the node (private state dir); redaction happens at the
 * gateway boundary (`fleet_run_report`), never at write time, so the evidence
 * needed to debug the redactor itself is not destroyed.
 */

import { redactSecrets } from "./untrusted.js";
import { parsePiJsonEvents } from "./opencode.js";

export interface FileChange {
  /** git name-status letter (A, M, D, R, C, T) or `?` for an untracked file. */
  status: string;
  path: string;
}

export interface Changes {
  endHead?: string;
  files: FileChange[];
  diffStat: string;
  /** Issue #271: endHead == startHead while file changes exist (uncommitted work, nothing to publish). */
  dirtyWorktree?: boolean;
}

/**
 * Parse the capture the run script writes at completion:
 *
 *   endHead=<sha>
 *   ---status
 *   M\tpath            (git diff --name-status <start>)
 *   ?\tpath            (untracked)
 *   ---stat
 *   <git diff --stat>
 *   dirtyWorktree=1    (issue #271: changed files but the branch tip did not move)
 */
export function parseChanges(text: string): Changes {
  const out: Changes = { files: [], diffStat: "" };
  let section: "head" | "status" | "stat" = "head";
  const stat: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "---status") { section = "status"; continue; }
    if (line === "---stat") { section = "stat"; continue; }
    if (section === "head") {
      const m = line.match(/^endHead=([0-9a-f]{40,64})$/);
      if (m) out.endHead = m[1];
    } else if (section === "status") {
      const m = line.match(/^([A-Z?])\d*\t(.+)$/);
      // renames/copies list "old\tnew": keep the destination
      if (m) out.files.push({ status: m[1], path: m[2].includes("\t") ? m[2].split("\t").pop()! : m[2] });
    } else {
      stat.push(line);
    }
  }
  out.diffStat = stat.join("\n").trim();
  // Issue #271: the run script appends this marker when it captured file
  // changes with an unmoved branch tip (work left uncommitted on the run
  // branch). Nothing appends it in the committed or no-change cases.
  if (/^dirtyWorktree=1$/m.test(text)) out.dirtyWorktree = true;
  return out;
}

export interface Commands {
  /** True when the engine's stream reports tool calls at all. False means "unknown", never "none". */
  commandsRecorded: boolean;
  /** `exitCode` is recorded only when the engine's event carried a numeric one; absent = unknown, never 0. */
  commands: Array<{ tool: string; input: string; exitCode?: number }>;
  eventCount: number;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
}

/**
 * Pi's `--mode json` stream (#137): tool calls come from `tool_execution_start` events and token
 * counts from each assistant `message_end`'s `usage`. Pi without `--mode json` prints plain text,
 * so `commandsRecorded` stays false (unknown, never "none"). Shapes follow Pi's docs and are read
 * defensively; field-name variants are accepted and anything else is skipped.
 */
function extractPiEvents(raw: string): Commands {
  const events = parsePiJsonEvents(raw);
  if (!events) return { commandsRecorded: false, commands: [], eventCount: 0 };
  const commands: Commands["commands"] = [];
  const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  let sawUsage = false;
  const callIndex = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tool_execution_start" && typeof e.toolName === "string") {
      const a = e.args;
      const isObj = typeof a === "object" && a !== null && !Array.isArray(a);
      const rec = isObj ? (a as Record<string, unknown>) : {};
      const text = typeof rec.command === "string" ? rec.command : typeof rec.path === "string" ? rec.path : a !== undefined ? JSON.stringify(a) : "";
      commands.push({ tool: e.toolName, input: text.slice(0, 2000) });
      if (typeof e.toolCallId === "string") callIndex.set(e.toolCallId, commands.length - 1);
    } else if (e.type === "tool_execution_end" && typeof e.toolCallId === "string" && callIndex.has(e.toolCallId)) {
      const r = e.result as { exitCode?: unknown; details?: { exitCode?: unknown } } | null | undefined;
      const code = r?.exitCode ?? r?.details?.exitCode;
      if (typeof code === "number" && Number.isInteger(code)) commands[callIndex.get(e.toolCallId)!]!.exitCode = code;
    } else if (e.type === "message_end") {
      const m = e.message as { role?: unknown; usage?: unknown } | null | undefined;
      const usage = m && m.role === "assistant" && typeof m.usage === "object" && m.usage !== null ? (m.usage as Record<string, unknown>) : undefined;
      if (!usage) continue;
      const cost = usage.cost;
      const costNum = typeof cost === "number" ? cost : typeof cost === "object" && cost !== null ? num((cost as Record<string, unknown>).total) : 0;
      u.inputTokens += num(usage.input ?? usage.inputTokens);
      u.outputTokens += num(usage.output ?? usage.outputTokens);
      u.cacheReadTokens += num(usage.cacheRead ?? usage.cacheReadTokens);
      u.cacheWriteTokens += num(usage.cacheWrite ?? usage.cacheWriteTokens);
      u.costUsd += costNum;
      sawUsage = true;
    }
  }
  return { commandsRecorded: true, commands, eventCount: events.length, ...(sawUsage ? { usage: u } : {}) };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Best-effort extraction from an engine's structured event stream. opencode's
 * `--format json` emits NDJSON: `tool_use` events carry the tool name and its
 * input, `step_finish` events carry token counts and cost. The schema is the
 * engine's, so unknown shapes are skipped rather than guessed at; Pi's
 * `--mode json` stream is handled separately (extractPiEvents); plain Pi text is unknown.
 */
export function extractEvents(raw: string, harness: string): Commands {
  if (harness === "pi") return extractPiEvents(raw);
  if (harness !== "opencode") return { commandsRecorded: false, commands: [], eventCount: 0 };
  const commands: Commands["commands"] = [];
  let eventCount = 0;
  const u = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  let sawUsage = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt.type !== "string") continue;
    eventCount++;
    if (evt.type === "tool_use" && typeof evt.part?.tool === "string") {
      const input = evt.part.state?.input;
      const text = typeof input?.command === "string" ? input.command : typeof input?.filePath === "string" ? input.filePath : input !== undefined ? JSON.stringify(input) : "";
      const exit = evt.part.state?.metadata?.exit;
      commands.push({ tool: evt.part.tool, input: text.slice(0, 2000), ...(typeof exit === "number" && Number.isInteger(exit) ? { exitCode: exit } : {}) });
    }
    if (evt.type === "step_finish" && evt.part && typeof evt.part === "object") {
      const t = evt.part.tokens;
      if (t && typeof t === "object") {
        sawUsage = true;
        u.inputTokens += num(t.input);
        u.outputTokens += num(t.output);
        u.reasoningTokens += num(t.reasoning);
        u.cacheReadTokens += num(t.cache?.read);
        u.cacheWriteTokens += num(t.cache?.write);
      }
      if (typeof evt.part.cost === "number") { sawUsage = true; u.costUsd += num(evt.part.cost); }
    }
  }
  return { commandsRecorded: eventCount > 0, commands, eventCount, ...(sawUsage ? { usage: u } : {}) };
}

export interface ManifestInput {
  runId: string;
  harness: string;
  piModel?: string;
  cwd?: string;
  startHead?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  verified?: boolean | null;
  verifyDetails?: unknown;
  /** Issue #324b: the gate could not run its toolchain (missing tool); unverified, not failed. */
  gateUnavailable?: boolean;
  missing?: string;
  scope?: { files: string[] };
  changes?: Changes;
  events: Commands;
  log: { bytes: number; truncated: boolean; originalBytes?: number };
}

export const MANIFEST_VERSION = 1;

export function buildManifest(i: ManifestInput) {
  const started = i.startedAt ? Date.parse(i.startedAt) : NaN;
  const finished = i.finishedAt ? Date.parse(i.finishedAt) : NaN;
  return {
    manifestVersion: MANIFEST_VERSION,
    runId: i.runId,
    harness: i.harness,
    ...(i.piModel ? { model: i.piModel } : {}),
    ...(i.cwd ? { cwd: i.cwd } : {}),
    startedAt: i.startedAt ?? null,
    finishedAt: i.finishedAt ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    exitCode: typeof i.exitCode === "number" ? i.exitCode : null,
    verified: typeof i.verified === "boolean" ? i.verified : null,
    // Issue #324b: name the could-not-run outcome (null ≠ pass ≠ fail) and, best effort, the missing
    // tool, so the audit manifest explains itself without a trip through verifyDetails.
    ...(i.gateUnavailable ? { gateUnavailable: true } : {}),
    ...(i.missing ? { missing: i.missing } : {}),
    ...(i.verifyDetails != null ? { verifyDetails: i.verifyDetails } : {}),
    startHead: i.startHead ?? null,
    endHead: i.changes?.endHead ?? null,
    // Issue #271: true only when the run left changes uncommitted with the
    // branch tip at base (a silent data-loss shape for fleet_sync);
    // undefined (field omitted) otherwise — byte-identical manifests for
    // runs that committed their work or changed nothing.
    ...(i.changes?.dirtyWorktree ? { dirtyWorktree: true } : {}),
    // null = the capture is missing (not a git repo, or the run died before the tail), never "no changes".
    filesChanged: i.changes ? i.changes.files : null,
    diffStat: i.changes ? i.changes.diffStat : null,
    // Issue #325: a run that changed NOTHING against its start commit is named explicitly, so a silent
    // no-op is not indistinguishable from a run that did the job. Derived, not asserted: `false` only
    // when the capture is present AND empty (a missing capture is `null` filesChanged = unknown, and
    // stays unknown). Distinct from `verified` — this is about whether work HAPPENED, not whether it passed.
    ...(i.changes ? { producedChanges: i.changes.files.length > 0 } : {}),
    ...(i.scope ? { scope: i.scope } : {}),
    commandsRecorded: i.events.commandsRecorded,
    commands: i.events.commands,
    eventCount: i.events.eventCount,
    ...(i.events.usage ? { usage: i.events.usage } : {}),
    log: i.log,
  };
}

export type Manifest = ReturnType<typeof buildManifest>;

/**
 * Cap a log file at `maxBytes`, keeping the head (where the run's setup shows)
 * and the tail (where the outcome is) with a marker between. Returns what
 * happened so the manifest can say the stream was truncated.
 */
export async function capLogFile(path: string, maxBytes: number, headBytes = 1024 * 1024): Promise<{ bytes: number; truncated: boolean; originalBytes?: number }> {
  const fsp = await import("node:fs/promises");
  let size: number;
  try {
    size = (await fsp.stat(path)).size;
  } catch {
    return { bytes: 0, truncated: false };
  }
  if (size <= maxBytes) return { bytes: size, truncated: false };
  const marker = Buffer.from(`\n[... ${size - maxBytes} bytes truncated by fleet audit cap ...]\n`);
  const head = Math.min(headBytes, Math.floor(maxBytes / 2));
  const tail = maxBytes - head - marker.length;
  const fh = await fsp.open(path, "r");
  try {
    const a = Buffer.alloc(head);
    const b = Buffer.alloc(Math.max(0, tail));
    await fh.read(a, 0, head, 0);
    await fh.read(b, 0, b.length, size - b.length);
    const out = Buffer.concat([a, marker, b]);
    const tmp = `${path}.cap`;
    await fsp.writeFile(tmp, out, { mode: 0o600 });
    await fsp.rename(tmp, path);
    return { bytes: out.length, truncated: true, originalBytes: size };
  } finally {
    await fh.close();
  }
}

/** Redact secrets from every string in a value (the audit store keeps raw evidence; redaction happens on the way out). */
export function redactAudit<T>(v: T): T {
  if (typeof v === "string") return redactSecrets(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactAudit) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactAudit(x)])) as T;
  return v;
}
