import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { parseDefaultBranch } from "../provision.js";
import { type FleetConfig } from "./shared.js";

/**
 * Issue #260 item 2: the read-only `fleet_prs` stack / stale-base check.
 *
 * Lists a GitHub repo's open PRs and flags what a merge queue must resolve:
 *   - `stackedOn` — the PR's base is another OPEN PR's head (a stack); a chain
 *     of 3+ resolves each PR to the PR under it.
 *   - `baseMergedNotRetargeted` — the base branch no longer exists on origin
 *     and is not the default branch and is not another open PR's head (typical
 *     after a squash-merge + branch-delete; GitHub leaves the PR aimed at
 *     nothing). The note says so; merging or retargeting is a human call.
 *
 * READ-ONLY by contract: `gh pr list` plus two `git ls-remote` probes. No PR
 * writes, no comments, no labels, no retargeting. A gh/git failure or
 * malformed JSON returns `{ok:false}` naming the command and the stderr head —
 * the tool never throws.
 */

export interface PrRow {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

export interface AnalyzedPr {
  number: number;
  title: string;
  head: string;
  base: string;
  url: string;
  stackedOn?: number;
  baseMergedNotRetargeted?: boolean;
  note?: string;
}

export interface StackReport {
  counts: { open: number; stacked: number; staleBase: number };
  prs: AnalyzedPr[];
}

/**
 * Pure stack analysis. `defaultBranch` and `remoteBranches` come from a live
 * origin; `prs` are the OPEN PRs. Every flag is derived against all three, so
 * a base that is the default branch or still an existing remote branch is
 * never flagged, and a base that is another open PR's head reads as the stack.
 */
export function analyzeStacks(prs: PrRow[], remoteBranches: string[], defaultBranch: string): StackReport {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  // head branch -> lowest-open-numbered PR carrying it (one canonical parent
  // per stack link, so a chain of 3+ resolves deterministically).
  const headToPr = new Map<string, number>();
  for (const p of sorted) {
    const prev = headToPr.get(p.headRefName);
    if (prev === undefined || p.number < prev) headToPr.set(p.headRefName, p.number);
  }
  const existing = new Set(remoteBranches);
  const out: AnalyzedPr[] = sorted.map((p) => {
    const base = p.baseRefName;
    const stackedOn = headToPr.get(base);
    const goneBase =
      base !== defaultBranch && !existing.has(base) && stackedOn === undefined;
    return {
      number: p.number,
      title: p.title,
      head: p.headRefName,
      base,
      url: p.url,
      ...(stackedOn !== undefined ? { stackedOn } : {}),
      ...(goneBase
        ? { baseMergedNotRetargeted: true, note: `base merged, PR not retargeted (base branch ${base} no longer exists)` }
        : {}),
    };
  });
  return {
    counts: {
      open: sorted.length,
      stacked: out.filter((x) => x.stackedOn !== undefined).length,
      staleBase: out.filter((x) => x.baseMergedNotRetargeted === true).length,
    },
    prs: out,
  };
}

/** Parse `git ls-remote --heads origin` output into bare branch names. */
export function parseRemoteHeads(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "ref:") continue; // symref preamble; not a head
    const ref = fields[1];
    if (ref?.startsWith("refs/heads/")) out.push(ref.slice("refs/heads/".length));
  }
  return out;
}

type CmdResult = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * One read-only command, mirroring the src/tools/project.ts execFile pattern.
 * The rejection is turned into a named failure (command + stderr head); nothing
 * here throws.
 */
async function runCmd(cmd: string, args: string[], cwd: string): Promise<CmdResult> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(cmd, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as { stderr?: unknown; message?: unknown };
    const stderrHead = (typeof err.stderr === "string" ? err.stderr : "")
      .trim()
      .split("\n")
      .filter(Boolean)[0];
    const firstLines = String(err.message ?? "").split("\n").filter(Boolean);
    const msgHead = firstLines.find((l) => !l.startsWith("Command failed")) ?? firstLines[0] ?? "";
    const head = stderrHead ?? msgHead;
    return { ok: false, error: `\`${cmd} ${args.join(" ")}\` failed: ${head.slice(0, 300) || "unknown error"}` };
  }
}

/** Parse the `gh pr list --json ...` payload; anything malformed is a named failure. */
export function parseGhPrList(stdout: string): { ok: true; prs: PrRow[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return { ok: false, error: `\`gh pr list\` returned malformed JSON: ${(e as Error).message.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "`gh pr list` returned JSON that is not an array of PRs" };
  const prs: PrRow[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const o = x as Record<string, unknown>;
    const number = Number(o.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    prs.push({
      number,
      title: typeof o.title === "string" ? o.title : "",
      headRefName: typeof o.headRefName === "string" ? o.headRefName : "",
      baseRefName: typeof o.baseRefName === "string" ? o.baseRefName : "",
      url: typeof o.url === "string" ? o.url : "",
    });
  }
  return { ok: true, prs };
}

export function registerPrsTools(api: OpenClawPluginApi, _cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_prs",
    label: "Fleet PRs",
    description:
      "Read-only PR check: `repo` is a checkout with the GitHub repo at origin; list open PRs (number, title, head, base, url), flag stackedOn (base = another open PR's head) and a base gone from origin (squash-merged + deleted: retarget or merge). gh pr list; failures are ok:false with stderr.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string", description: "Absolute checkout path; commands run with cwd there." },
      },
      required: ["repo"],
    },
    execute: async (_toolCallId, params) => {
      const p = params as { repo?: string };
      if (typeof p.repo !== "string" || !p.repo.startsWith("/")) {
        return jsonResult({ ok: false, error: "repo must be an absolute path to a local checkout" });
      }
      const gh = await runCmd("gh", ["pr", "list", "--state", "open", "--json", "number,title,headRefName,baseRefName,url", "--limit", "200"], p.repo);
      if (!gh.ok) return jsonResult({ ok: false, error: gh.error });
      const prCheck = parseGhPrList(gh.stdout);
      if (!prCheck.ok) return jsonResult({ ok: false, error: prCheck.error });
      const heads = await runCmd("git", ["-C", p.repo, "ls-remote", "--heads", "origin"], p.repo);
      if (!heads.ok) return jsonResult({ ok: false, error: heads.error });
      const symref = await runCmd("git", ["-C", p.repo, "ls-remote", "--symref", "origin", "HEAD"], p.repo);
      if (!symref.ok) return jsonResult({ ok: false, error: symref.error });
      const defaultBranch = parseDefaultBranch(symref.stdout);
      if (!defaultBranch) {
        return jsonResult({ ok: false, error: "could not resolve the default branch from `git -C <repo> ls-remote --symref origin HEAD`" });
      }
      const report = analyzeStacks(prCheck.prs, parseRemoteHeads(heads.stdout), defaultBranch);
      return jsonResult({
        ok: true,
        repo: p.repo,
        defaultBranch,
        counts: report.counts,
        prs: report.prs,
      });
    },
  });
}