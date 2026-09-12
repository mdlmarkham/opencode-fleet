import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");

/**
 * Issue #21 regression guards. The bug was a false-negative-as-success: the
 * detached dispatch path returned an optimistic handle even when the node-side
 * launch had failed or the relay timed out, with a note asserting the handle
 * "is valid regardless".
 *
 * These assert the *shape* of the fix in source, since the dispatch path needs
 * a live node.invoke to exercise end-to-end. The behavioral contract is:
 *   1. nodeRejected -> ok:false, no optimistic handle
 *   2. invokeTimedOut && !ackOk -> ok:false with invokeTimedOut
 *   3. ackOk -> ok handle with the pid
 *   4. no fabricated "valid regardless" claim on failure
 *   5. run_status distinguishes never-started from cleaned
 */
describe("issue #21: fleet_dispatch launch-failure reporting", () => {
  it("fails closed on node rejection or invoke timeout with no ack", () => {
    expect(src).toContain("const nodeRejected = launchPayload.ok === false");
    expect(src).toContain("const ackOk = launchPayload.detached === true");
    expect(src).toContain("if (nodeRejected || (invokeTimedOut && !ackOk))");
    // The failure handle must be explicit about not being a valid run.
    expect(src).toContain("ok: false,");
    expect(src).toContain("Launch was NOT confirmed.");
  });

  it("never asserts a failed handle is valid", () => {
    expect(src).not.toContain("the run handle is valid regardless");
  });

  it("honestly qualifies an unacked launch instead of fabricating validity", () => {
    expect(src).toContain("Launch ack not received — the run may not have started.");
    expect(src).toContain("Verify with fleet_run_status(runId) before relying on this handle.");
  });

  it("distinguishes never-started from cleaned in run status", () => {
    expect(src).toContain('"never-started"');
    expect(src).toContain('"cleaned"');
    expect(src).toContain("Launch was never acknowledged — the run did not start.");
  });

  it("raises the launcher timeout above the old 15s", () => {
    // detachedLaunchCommand call must not use 15_000 any more.
    expect(src).toMatch(/runShell\(detachedLaunchCommand\([^)]*\), 45_000/);
  });
});
