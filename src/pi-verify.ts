/**
 * Checks a captured Pi session against every flag and event name this plugin relies on
 * (issue #137, "live verification"). Every such name was taken from Pi's docs, not a live run, so
 * this turns "someone should check on a real node" into one capture + one command:
 *
 *   node scripts/pi-capture.mjs > pi-capture.json      (on the node, where `pi` is installed)
 *   node dist/pi-verify-cli.js pi-capture.json         (anywhere; pure, offline)
 *
 * Pure: no spawning, no network. It reuses the production parsers (`parsePiJsonEvents`,
 * `parsePiOutput`, `extractEvents`), so a name the parser reads but the capture lacks is reported
 * as such, not guessed at.
 */

import { parsePiJsonEvents, parsePiOutput } from "./opencode.js";
import { extractEvents } from "./audit.js";
import { redactSecrets } from "./untrusted.js";

export interface PiCaptureRun {
  name: "text" | "tool";
  prompt: string;
  exitCode: number | null;
  stdout: string;
  stderr?: string;
}
export interface PiCapture {
  capturedAt?: string;
  piVersion?: string;
  help: string;
  runs: PiCaptureRun[];
}

export type CheckStatus = "confirmed" | "missing" | "unverifiable";
export interface PiCheck {
  id: string;
  /** What the plugin relies on. */
  assumes: string;
  status: CheckStatus;
  /** What happens in production while this is not confirmed. */
  effect: string;
  detail?: string;
  /** A missing required check fails the run of this verifier; an optional one is only reported. */
  required: boolean;
}

const BASELINE_FLAGS = ["--no-session", "--no-approve", "--no-extensions", "--no-skills"];
const RESTRICTION_FLAGS: Array<[string, string]> = [
  ["--tools", "a piTools allowlist dispatch refuses with exit 67 on this node"],
  ["--no-tools", "piTools: [] refuses with exit 67 on this node"],
  ["--offline", "piOffline refuses with exit 67 on this node"],
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first `x.y.z` in a version banner, or undefined. */
export function parsePiVersion(text: string | undefined): string | undefined {
  return /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text ?? "")?.[0];
}

function flagChecks(help: string): PiCheck[] {
  const has = (f: string): boolean => new RegExp(`(^|[^\\w-])${f.replace(/-/g, "\\-")}(?![\\w-])`).test(help);
  const out: PiCheck[] = [];
  for (const f of BASELINE_FLAGS) {
    const ok = has(f);
    out.push({ id: `flag:${f}`, assumes: `pi --help lists ${f}`, status: ok ? "confirmed" : "missing", effect: `the baseline hardening flag ${f} is silently not applied`, required: false });
  }
  for (const [f, effect] of RESTRICTION_FLAGS) {
    const ok = has(f);
    out.push({ id: `flag:${f}`, assumes: `pi --help lists ${f}`, status: ok ? "confirmed" : "missing", effect, required: false });
  }
  const mode = has("--mode");
  out.push({ id: "flag:--mode", assumes: "pi --help lists --mode (with a json value)", status: mode && /\bjson\b/i.test(help) ? "confirmed" : "missing", effect: "piJson falls back to plain-text output: no tool calls, usage or cost in the audit manifest", required: false });
  return out;
}

function eventChecks(run: PiCaptureRun): PiCheck[] {
  const p = (id: string, assumes: string, ok: boolean | undefined, effect: string, detail?: string, required = true): PiCheck => ({
    id: `${run.name}:${id}`,
    assumes,
    status: ok === undefined ? "unverifiable" : ok ? "confirmed" : "missing",
    effect,
    ...(detail ? { detail: redactSecrets(detail).slice(0, 300) } : {}),
    required,
  });
  const events = parsePiJsonEvents(run.stdout);
  const checks: PiCheck[] = [p("jsonl", "--mode json prints JSONL events including message_end/agent_start/agent_end", events !== null, "piJson output is treated as plain text", run.exitCode !== 0 ? `exit ${run.exitCode}: ${(run.stderr ?? "").slice(-200)}` : undefined)];
  if (!events) return checks;

  const seen = [...new Set(events.map((e) => e.type))];
  const ends = events.filter((e) => e.type === "message_end" && isObj(e.message) && e.message.role === "assistant");
  const last = ends[ends.length - 1];
  const msg = last && isObj(last.message) ? last.message : undefined;
  const text = msg && Array.isArray(msg.content) ? msg.content.some((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text !== "") : typeof msg?.content === "string" && msg.content !== "";
  checks.push(
    p("message_end", "message_end with message.role=assistant is the final message", ends.length > 0, "the final answer and HAND_RAISE are not extracted; the raw tail is used", `event types seen: ${seen.join(", ")}`),
    p("final-text", "the final assistant message.content holds text blocks ({type:text,text})", ends.length > 0 ? text : undefined, "summary falls back to the raw output tail"),
    p("stopReason", "message.stopReason is a string", ends.length > 0 ? typeof msg?.stopReason === "string" : undefined, "a model error cannot be told from success by stopReason", msg ? `stopReason=${JSON.stringify(msg.stopReason)}` : undefined, false),
  );
  const usage = isObj(msg?.usage) ? msg!.usage : undefined;
  const usageNames = usage ? Object.keys(usage) : [];
  const tokenOk = usage ? ["input", "output", "inputTokens", "outputTokens"].some((k) => typeof usage[k] === "number") : undefined;
  checks.push(
    p("usage", "message.usage carries numeric token counts (input/output, cacheRead/cacheWrite)", ends.length > 0 ? tokenOk : undefined, "the audit manifest reports no usage for Pi runs", usage ? `usage keys: ${usageNames.join(", ")}` : "no usage object on the final message", false),
    p("cost", "message.usage.cost is a number or {total}", usage ? typeof usage.cost === "number" || (isObj(usage.cost) && typeof usage.cost.total === "number") : undefined, "costUsd is 0 in the audit manifest", undefined, false),
  );
  const parsed = parsePiOutput(run.stdout, { exitCode: run.exitCode ?? 0 });
  checks.push(p("parse", "parsePiOutput yields ok with a non-empty summary", parsed.ok && (parsed.summary ?? "").trim() !== "", "the run is reported failed or empty", parsed.error));
  const manifest = extractEvents(run.stdout, "pi");
  checks.push(p("manifest", "the audit extractor records the events (commandsRecorded)", manifest.commandsRecorded, "audit manifests say commandsRecorded:false for Pi", `eventCount=${manifest.eventCount}`, false));

  if (run.name === "tool") {
    const starts = events.filter((e) => e.type === "tool_execution_start");
    const endsT = events.filter((e) => e.type === "tool_execution_end");
    const named = starts.some((e) => typeof e.toolName === "string" && typeof e.toolCallId === "string");
    const cmd = starts.some((e) => isObj(e.args) && typeof e.args.command === "string");
    const paired = starts.length > 0 && endsT.some((e) => typeof e.toolCallId === "string" && starts.some((s) => s.toolCallId === e.toolCallId));
    checks.push(
      p("tool_start", "tool_execution_start has toolName and toolCallId", starts.length > 0 ? named : false, "tool calls are not recorded in the manifest", `tools: ${starts.map((e) => String(e.toolName)).join(", ") || "(none)"}`),
      p("tool_args", "a bash tool call's args.command is the command string", starts.length > 0 ? cmd : undefined, "the recorded command is the JSON of args instead of the command", undefined, false),
      p("tool_end", "tool_execution_end shares the toolCallId (and has isError)", starts.length > 0 ? paired : undefined, "tool errors are not attributed to their call", undefined, false),
    );
  }
  return checks;
}

export interface PiVerifyReport {
  piVersion?: string;
  checks: PiCheck[];
  /** True when every required check is confirmed. */
  ok: boolean;
  summary: { confirmed: number; missing: number; unverifiable: number };
}

export function verifyPiCapture(capture: PiCapture): PiVerifyReport {
  const checks: PiCheck[] = [];
  const version = parsePiVersion(capture.piVersion) ?? parsePiVersion(capture.help);
  checks.push({ id: "version", assumes: "`pi --version` prints a semantic version", status: version ? "confirmed" : "unverifiable", effect: "no minimum-version check is possible", ...(version ? { detail: version } : {}), required: false });
  checks.push(...flagChecks(String(capture.help ?? "")));
  // A capture with no JSON-mode run proves nothing about the events, so it cannot pass.
  if (!(capture.runs ?? []).length) {
    checks.push({ id: "runs", assumes: "at least one captured Pi run to read events from", status: "missing", effect: "no event or usage name is verified", required: true });
  }
  for (const run of capture.runs ?? []) checks.push(...eventChecks(run));
  if (!(capture.runs ?? []).some((r) => r.name === "tool")) {
    checks.push({ id: "tool:run", assumes: "a tool-using run was captured", status: "unverifiable", effect: "tool_execution_* event names stay unverified", required: false });
  }
  const summary = { confirmed: 0, missing: 0, unverifiable: 0 };
  for (const c of checks) summary[c.status]++;
  return { ...(version ? { piVersion: version } : {}), checks, ok: checks.every((c) => !c.required || c.status === "confirmed"), summary };
}

export function renderPiReport(r: PiVerifyReport): string {
  const mark: Record<CheckStatus, string> = { confirmed: "OK     ", missing: "MISSING", unverifiable: "UNKNOWN" };
  const lines = [`Pi live verification${r.piVersion ? ` (pi ${r.piVersion})` : ""}: ${r.summary.confirmed} confirmed, ${r.summary.missing} missing, ${r.summary.unverifiable} unverifiable. ${r.ok ? "REQUIRED CHECKS PASS" : "REQUIRED CHECKS FAIL"}`, ""];
  for (const c of r.checks) {
    lines.push(`${mark[c.status]} ${c.required ? "[required]" : "[optional]"} ${c.id}: ${c.assumes}`);
    if (c.status !== "confirmed") lines.push(`          if not fixed: ${c.effect}`);
    if (c.detail) lines.push(`          ${c.detail}`);
  }
  return lines.join("\n");
}
