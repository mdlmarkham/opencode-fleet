import { SSH_ARGS, sshPrefix } from "../ssh.js";
import { OPCODE_PS_COMMAND, parseActivity, type NodeActivityEntry } from "../node/runtime.js";
import { parseBudgetConfig } from "../budget.js";

export interface FleetConfig {
  /** Issue #238: where the plugin REPO checkout (package.json) lives on this host, used as fleet_deploy's default pluginDir when the installed plugin dir is not the repo. */
  deploy?: { pluginDir?: string };
  defaultTransport?: "http" | "acp";
  nodePrefixes?: string[];
  defaultTimeoutMs?: number;
  /** Node-side workspace roots (issue #103 group c); env FLEET_ALLOWED_ROOTS still overrides. */
  allowedRoots?: string[];
  /** Node-side private state dir (issue #103 group c); env FLEET_STATE_DIR still overrides. */
  stateDir?: string;
  /** Dispatch target policy (issue #168). */
  dispatch?: { defaultTarget?: "all"; piMinVersion?: string };
  /** Opt-in (issue #189): commits made in a provisioned checkout carry this identity (set in the checkout's local git config, only when it has none). */
  workerGitIdentity?: { name?: string; email?: string };
  apertureUrl?: string;
  /** Shared workspace root on nodes (default: /home/<serviceUser>/fleet when all targets share one service user). */
  fleetRoot?: string;
  /** Pi model ref (provider/id) used when harness=pi and the dispatch names none. No built-in default. */
  piDefaultModel?: string;
  /** Operator switch: let agents pass `autoApprove` on dispatch (default true). */
  allowAutoApprove?: boolean;
  /** Operator switch: let fleet_provision `setup` be an arbitrary shell command, not just a repo script (default false). */
  allowSetupCommands?: boolean;
  /** Default per-run isolation for fleet_dispatch (issue #41): none (default) or clone. */
  isolation?: "none" | "clone";
  /** Deterministic design gate for spec dispatches (issue #117): off | advise (default) | enforce, plus size bounds. */
  /** Concurrency slots (issue #39). */
  /** GitHub projection of missions (issue #132): the repo and the NAME of the env var that holds the token (the token itself stays in OpenClaw's secrets, never in config). */
  projection?: { repo?: string; tokenEnv?: string };
  capacity?: { maxConcurrentPerNode?: number; staleAfterMs?: number; minFreeDiskGb?: number };
  /** Spend caps (issue #39): per-UTC-day totals from ledger usage + per-dispatch caps. Validated by parseBudgetConfig. */
  budget?: { dailyCostUsd?: number; dailyTokens?: number; perDispatchCostUsd?: number; perDispatchTokens?: number };
  project?: { gate?: "off" | "advise" | "enforce"; maxScopePatterns?: number; maxAcceptanceItems?: number; roots?: string[]; rules?: unknown[]; requireCharterFields?: string[]; allowRepoBlocking?: boolean; screenOutput?: "off" | "shadow" | "fence" | "withhold" };
  /** S1 decision layer (issue #79): backend, mode (default shadow), thresholds, egress opt-in. Validated by parseS1Config. */
  s1?: unknown;
  /** fleet_sync publish policy (issue #33). */
  sync?: { protectedBranches?: string[]; allowDirectPush?: string[]; allowSensitivePaths?: boolean; sensitivePaths?: string[]; requireVerified?: boolean; blockOnScopeViolation?: boolean; requireReview?: boolean; requireReviewSource?: "spawned" };
  /** Dispatch env refinements: allowOnly makes injection allowlist-only; extraDeny adds refused names. */
  env?: { allowOnly?: string[]; extraDeny?: string[] };
  /** SSH client policy for manager-to-node commands. */
  ssh?: { strictHostKeyChecking?: "accept-new" | "yes" };
}

export const expectParam = (what: string) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    files: { type: "array", items: { type: "string" }, description: "Paths relative to the run cwd that must exist after the run; absolute paths and `..` are refused." },
    command: { type: "string", description: "One verification command (`bash -c` in the run cwd); must exit 0; 120s unless timeoutMs. A repo-relative script path (e.g. `./scripts/check.sh --fast`), not an arbitrary shell line, unless the operator allows setup commands." },
    commands: { type: "array", items: { type: "string" }, description: "Several commands; EVERY one must exit 0. Same rule as `command`." },
    timeoutMs: { type: "number", description: "Bound for each command, ms (default 120000)." },
  },
  description: what,
});

/**
 * Manager-side: list running OpenCode processes on a node over SSH
 * (same execFile ssh pattern as provision.ts). Falls back to the node
 * invoke command (`__ACTIVITY__`) when SSH is unavailable.
 */
export async function getNodeActivity(
  host: string,
  invokeFallback?: () => Promise<NodeActivityEntry[] | { error: string }>,
): Promise<NodeActivityEntry[] | { error: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      "ssh",
      [...sshPrefix(host, SSH_ARGS), OPCODE_PS_COMMAND],
      { timeout: 20_000 },
    );
    return parseActivity(stdout);
  } catch (sshErr) {
    // Fall back to the node host command channel when SSH is unavailable.
    if (invokeFallback) return invokeFallback();
    return { error: (sshErr as Error).message };
  }
}


/** Extract the parsed payload object from a node invoke result. */
export function payloadOf(inv: unknown): Record<string, unknown> {
  const payload = (inv as { payload?: unknown }).payload;
  if (typeof payload === "string") {
    try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
  }
  return ((payload as Record<string, unknown> | undefined) ?? {});
}
