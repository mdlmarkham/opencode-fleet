/**
 * Checks a captured opencode session against what this plugin relies on (issues #111, #137, #243):
 * the flags `opencode run` is built with, the absence of `--auto` on `acp`, the event shapes the audit
 * parser reads (tool_use input, `state.metadata.exit`, step_finish tokens/cost), and where project-local
 * agents and skills are loaded from. Everything was taken from docs and memory, not a live run; this
 * turns that into one capture and one command:
 *
 *   node scripts/opencode-capture.mjs > opencode-capture.json     (on the node)
 *   node dist/opencode-verify-cli.js opencode-capture.json        (anywhere; pure, offline)
 *
 * Pure. It reuses the production `extractEvents`, so a field the parser reads but the capture lacks is
 * reported as missing, not guessed at. A check the capture cannot speak to is `unverifiable`, never `confirmed`.
 */

import { extractEvents } from "./audit.js";
import { redactSecrets } from "./untrusted.js";

interface Probe { args?: string[]; exitCode: number | null; stdout: string; stderr?: string; error?: string }
export interface OpencodeCapture {
  capturedAt?: string;
  probes: Record<string, Probe>;
  fsFacts?: Record<string, string[] | null>;
  modelRun?: Probe;
}

export type Status = "confirmed" | "missing" | "unverifiable";
export interface OcCheck { id: string; assumes: string; status: Status; effect: string; detail?: string; required: boolean }
export interface OcReport { opencodeVersion?: string; checks: OcCheck[]; ok: boolean; summary: { confirmed: number; missing: number; unverifiable: number } }

const text = (p?: Probe): string => `${p?.stdout ?? ""}\n${p?.stderr ?? ""}`;
const hasFlag = (help: string, f: string): boolean => new RegExp(`(^|[^\\w-])${f.replace(/-/g, "\\-")}(?![\\w-])`).test(help);

export function verifyOpencodeCapture(c: OpencodeCapture): OcReport {
  const checks: OcCheck[] = [];
  const add = (x: OcCheck): void => void checks.push(x);
  const run = text(c.probes.runHelp);
  const ran = (p?: Probe): boolean => !!p && p.error === undefined && p.exitCode === 0;

  if (!ran(c.probes.runHelp)) add({ id: "run.help", assumes: "`opencode run --help` works", status: "missing", effect: "every flag below is unverifiable", required: true, detail: c.probes.runHelp?.error ?? `exit ${c.probes.runHelp?.exitCode}` });
  for (const [f, effect] of [["--format", "JSON events (commands, usage, exit codes) are not recorded"], ["--model", "per-task model selection fails"], ["--agent", "the `agent` dispatch param fails"], ["--auto", "`autoApprove` dispatches fail or prompt for permissions"]] as const) {
    add({ id: `run.${f.slice(2)}`, assumes: `\`opencode run\` accepts ${f}`, status: !ran(c.probes.runHelp) ? "unverifiable" : hasFlag(run, f) ? "confirmed" : "missing", effect, required: f !== "--agent" });
  }
  add({ id: "acp.no-auto", assumes: "`opencode acp` has no --auto flag (the plugin never passes one there)", status: !ran(c.probes.acpHelp) ? "unverifiable" : hasFlag(text(c.probes.acpHelp), "--auto") ? "missing" : "confirmed", effect: "if acp gained --auto, autoApprove on acp would be silently inert; revisit the guard", required: false });

  const agents = text(c.probes.agentList);
  add({ id: "agents.project-local", assumes: "a project-local `.opencode/agent/<name>.md` is loaded", status: !ran(c.probes.agentList) ? "unverifiable" : /fleetprobe/.test(agents) ? "confirmed" : "missing", effect: "roles shipped per project (#110) would not be found", required: false, detail: ran(c.probes.agentList) ? undefined : "`opencode agent list` is not available" });
  const dbg = `${text(c.probes.debugSkill)}\n${text(c.probes.debugPaths)}`;
  add({ id: "skills.project-local", assumes: "a project-local `.opencode/skill/<name>/SKILL.md` is loaded", status: !ran(c.probes.debugSkill) ? "unverifiable" : /fleetprobe/.test(dbg) ? "confirmed" : "missing", effect: "per-run skills in the clone (#110 R-6) would not load", required: false });
  const fs = c.fsFacts ?? {};
  const dirs = Object.entries(fs).filter(([, v]) => v !== null).map(([k]) => k);
  add({ id: "paths.global", assumes: "global agent/skill directories are under ~/.config/opencode", status: Object.keys(fs).length === 0 ? "unverifiable" : "confirmed", effect: "provisioning config to the wrong place", required: false, detail: dirs.length ? `present: ${dirs.join(", ")}` : "none of the candidate directories exist on this node" });

  const mr = c.modelRun;
  if (!mr || !ran(mr)) {
    for (const id of ["events.tool_use", "events.exit-code", "events.step_finish"]) add({ id, assumes: "event shape the audit parser reads", status: "unverifiable", effect: "manifest commands/exit codes/usage stay unrecorded", required: false, detail: mr ? `model run failed: ${mr.error ?? `exit ${mr.exitCode}`}` : "no model run captured" });
  } else {
    const ev = extractEvents(mr.stdout, "opencode");
    const probeCmd = ev.commands.find((x) => /fleet-oc-probe/.test(x.input));
    add({ id: "events.tool_use", assumes: "`tool_use` events carry `part.tool` and `part.state.input.command`", status: probeCmd ? "confirmed" : "missing", effect: "manifest `commands` stay empty and reviewer claims cannot be cross-checked", required: true, detail: probeCmd ? undefined : `${ev.eventCount} events, ${ev.commands.length} commands, none contained the probe` });
    add({ id: "events.exit-code", assumes: "bash `tool_use` events carry a numeric `part.state.metadata.exit`", status: !probeCmd ? "unverifiable" : typeof probeCmd.exitCode === "number" ? "confirmed" : "missing", effect: "exit codes stay unknown: the #243 contradiction check is inert", required: false, detail: probeCmd && typeof probeCmd.exitCode !== "number" ? "the event had no numeric metadata.exit; find the real field name and update audit.ts" : undefined });
    add({ id: "events.step_finish", assumes: "`step_finish` events carry token counts (and cost)", status: ev.usage ? "confirmed" : "missing", effect: "usage and budget accounting stay empty for opencode runs", required: false });
  }
  const summary = { confirmed: checks.filter((x) => x.status === "confirmed").length, missing: checks.filter((x) => x.status === "missing").length, unverifiable: checks.filter((x) => x.status === "unverifiable").length };
  const version = /\b\d+\.\d+\.\d+\b/.exec(text(c.probes.version))?.[0];
  return { ...(version ? { opencodeVersion: version } : {}), checks, ok: checks.every((x) => !x.required || x.status === "confirmed"), summary };
}

export function renderOpencodeReport(r: OcReport): string {
  const L = [`opencode live verification${r.opencodeVersion ? ` (opencode ${r.opencodeVersion})` : ""}: ${r.summary.confirmed} confirmed, ${r.summary.missing} missing, ${r.summary.unverifiable} unverifiable. ${r.ok ? "REQUIRED CHECKS PASS" : "REQUIRED CHECKS FAIL"}`, ""];
  for (const x of r.checks) L.push(`[${x.status.toUpperCase()}${x.required ? ", required" : ""}] ${x.id}: ${x.assumes}${x.status === "confirmed" ? "" : `\n    while this is not confirmed: ${x.effect}`}${x.detail ? `\n    ${redactSecrets(x.detail).slice(0, 200)}` : ""}`);
  return L.join("\n");
}
