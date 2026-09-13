import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const provision = readFileSync(join(here, "provision.ts"), "utf8");
const index = readFileSync(join(here, "index.ts"), "utf8");

/**
 * Issue #13 (layer 3) regression guards: fleet_sync must publish the worker's
 * work to the CORRECT destination branch.
 *
 * The layer-3 defect was a wrong-destination bug in two shapes:
 *   1. from-base64 path: `destBranch = prebuilt.branch ?? branch` collapsed the
 *      destination to the clone base (always `main` when the caller defaulted),
 *      so a feature-branch worker's commits were pushed at `main`.
 *   2. SSH path: `destBranch = workerBranch !== branch ? workerBranch : branch`
 *      could never express "pin main" (branch is always populated), and
 *      depended on an inference rather than an explicit destination.
 *
 * The fix threads an explicit destination:
 *   - `branch` is the CLONE BASE (exists on origin; safe to `--branch`).
 *   - a destination is PINNED only when the caller explicitly names one.
 *   - otherwise `chooseDest` publishes the worker's own branch when it differs
 *     from the clone base, else the clone base.
 */
describe("issue #13 layer 3: fleet_sync destination branch", () => {
  it("resolves destination through a single explicit helper", () => {
    expect(provision).toContain("const chooseDest =");
    expect(provision).toContain("pinnedDest ?? (workerBranch && workerBranch !== branch ? workerBranch : branch)");
  });

  it("does not collapse the from-base64 destination to the clone base", () => {
    // The old buggy line must be gone.
    expect(provision).not.toContain("const destBranch = prebuilt.branch ?? branch;");
    // The from-base64 path must route through the resolver.
    expect(provision).toContain("const destBranch = chooseDest(workerBranch, prebuilt.destBranch);");
  });

  it("does not infer the SSH destination from workerBranch !== branch alone", () => {
    expect(provision).not.toContain("const destBranch = workerBranch !== branch ? workerBranch : branch;");
    expect(provision).toContain("const destBranch = chooseDest(workerBranch, destBranchPinned);");
  });

  it("clones the clone base, never the worker branch, on both paths", () => {
    // Clone base must be `branch` so `--branch` always resolves on origin.
    const clones = provision.match(/git", \["clone", "--branch", ([^,]+),/g) ?? [];
    expect(clones.length).toBeGreaterThanOrEqual(2);
    for (const c of clones) expect(c).toContain('"clone", "--branch", branch,');
  });

  it("passes a pinned destination only when the caller explicitly named one", () => {
    // SSH path: 6th arg is `p.branch` (undefined when defaulted).
    expect(index).toContain("syncFromNode(host, p.cwd, p.repo, p.branch ?? \"main\", undefined, p.branch)");
    // Channel path: destBranch carries the raw (possibly undefined) caller value.
    expect(index).toContain("destBranch: p.branch,");
  });
});
