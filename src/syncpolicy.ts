/**
 * Publish policy for `fleet_sync` (issue #33).
 *
 * A worker's work is pushed with the MANAGER's credentials. A confused or
 * prompt-injected worker must therefore not be able to land code on a
 * protected branch, change CI configuration, or publish a secret unnoticed.
 *
 * - Protected branches (default: main, master) are never pushed directly unless
 *   the operator lists them in `allowDirectPush`; the work is redirected to a
 *   `fleet/<name>` branch for review instead.
 * - Changes to CI/CODEOWNERS paths are refused unless `allowSensitivePaths`.
 * - Added lines that look like credentials are refused.
 * - Branch names and the repo argument are validated/ `--`-separated so a value
 *   starting with `-` cannot be read as a git option.
 */

import { redactSecrets } from "./untrusted.js";

export interface SyncPolicy {
  /** Branches that must not receive direct pushes. Default ["main", "master"]. */
  protectedBranches: string[];
  /** Protected branches the operator allows direct pushes to. Default []. */
  allowDirectPush: string[];
  /** Allow changes to CI/CODEOWNERS paths. Default false. */
  allowSensitivePaths: boolean;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  protectedBranches: ["main", "master"],
  allowDirectPush: [],
  allowSensitivePaths: false,
};

export function resolvePolicy(cfg?: Partial<SyncPolicy>): SyncPolicy {
  return {
    protectedBranches: cfg?.protectedBranches ?? DEFAULT_SYNC_POLICY.protectedBranches,
    allowDirectPush: cfg?.allowDirectPush ?? DEFAULT_SYNC_POLICY.allowDirectPush,
    allowSensitivePaths: cfg?.allowSensitivePaths === true,
  };
}

/** Conservative subset of valid git ref names; rejects leading '-', '..', '//', '@{', trailing '.lock' or '/'. */
export function isSafeBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.split("/").some((seg) => seg.startsWith(".") || seg.endsWith(".lock"))
  );
}

export interface Destination {
  branch: string;
  /** Set when the requested destination was protected and the push was redirected. */
  redirectedFrom?: string;
}

/**
 * Pick the branch actually pushed to. A protected destination without an
 * explicit `allowDirectPush` entry is redirected to `fleet/<workerBranch>`
 * (or `fleet/<label>` when the worker is itself on the protected branch).
 */
export function resolveDestination(
  requested: string,
  workerBranch: string,
  label: string,
  policy: SyncPolicy,
): Destination {
  const isProtected = policy.protectedBranches.includes(requested);
  if (!isProtected || policy.allowDirectPush.includes(requested)) return { branch: requested };
  const seed = workerBranch && !policy.protectedBranches.includes(workerBranch) ? workerBranch : label;
  const safe = seed
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .split("/")
    .map((seg) => seg.replace(/^[-.]+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .join("/");
  const branch = `fleet/${safe || label}`.replace(/\.lock$/, "-lock");
  return { branch, redirectedFrom: requested };
}

const SENSITIVE_PATHS: RegExp[] = [
  /^\.github\/(workflows|actions)\//,
  /^\.github\/CODEOWNERS$/,
  /^CODEOWNERS$/,
  /^docs\/CODEOWNERS$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\//,
  /^Jenkinsfile$/,
  /^\.buildkite\//,
  /^azure-pipelines\.ya?ml$/,
];

export function sensitivePaths(files: string[]): string[] {
  return files.filter((f) => SENSITIVE_PATHS.some((re) => re.test(f)));
}

/** Added lines (from a unified diff) that contain credential-shaped text. Returns count only — never the secret. */
export function countSecretLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (redactSecrets(line) !== line) n++;
  }
  return n;
}

export type PushCheck = { ok: true } | { ok: false; error: string; detail: string };

/** Evaluate the changed files and added lines against the policy. */
export function evaluateChange(files: string[], diff: string, policy: SyncPolicy): PushCheck {
  if (!policy.allowSensitivePaths) {
    const hits = sensitivePaths(files);
    if (hits.length) {
      return {
        ok: false,
        error: "worker changes touch CI/CODEOWNERS paths",
        detail: `refused to publish changes to: ${hits.slice(0, 10).join(", ")}. A worker could use these to run code with the repo's credentials; set sync.allowSensitivePaths to permit.`,
      };
    }
  }
  const secrets = countSecretLines(diff);
  if (secrets > 0) {
    return {
      ok: false,
      error: "worker changes contain credential-shaped text",
      detail: `${secrets} added line(s) look like secrets (tokens, keys, passwords). Nothing was pushed; review the worker's diff.`,
    };
  }
  return { ok: true };
}
