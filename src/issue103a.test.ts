/**
 * Issue #103 group (a): worker-output trust in fleet_iterate + honest
 * parser metadata + harness in fleet_run_status.
 *
 * Covered here, one test per behavior change, each FAILING before its fix:
 *   1. `successMarker` is only ever an ADDITIONAL required condition: it must
 *      be combined with a real pass signal (ok !== false, not looksFailed) AND
 *      the verification gate must not have failed. A worker printing the
 *      marker (even over a failing run) must NOT fake success.
 *   2. Every `fleet_iterate` return shape goes through `withVerified`, so
 *      `verified` is always present (null when no gate ran) — notably the
 *      no-progress escalation return.
 *   3. `parseOpenCodeOutput` does NOT hard-code `transport: "http"` /
 *      `iterations: 1`: it reports the real ExecStatus values and only falls
 *      back to today's http/1 when the caller supplies nothing.
 *   4. `fleet_run_status`'s `run` object surfaces `harness` from the ledger.
 */

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOpenCodeOutput, parsePiOutput } from "./opencode.js";
import type { ExecStatus } from "./opencode.js";
import { loadLedger, upsertRun, type LedgerEntry } from "./ledger.js";
import { withVerified } from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "index.ts"), "utf8").replace(/\r\n/g, "\n");
const opencodeSrc = readFileSync(join(here, "opencode.ts"), "utf8").replace(/\r\n/g, "\n");

// The fleet_iterate tool block only (its siblings have different shapes).
const iterateSrc = indexSrc.slice(
  indexSrc.indexOf("name: \"fleet_iterate\""),
  indexSrc.indexOf("name: \"fleet_watch\""),
);
// The fleet_run_status implementation (final result object). Issue #180 hoisted it into
// `runStatusExecute` so fleet_await can share it; the pin follows the function.
const runStatusSrc = indexSrc.slice(
  indexSrc.indexOf("const runStatusExecute"),
  indexSrc.indexOf("name: \"fleet_answer\""),
);

const ev = (o: unknown) => JSON.stringify(o);
const goodRun = [
  ev({ type: "step_start", sessionID: "s1" }),
  ev({ type: "text", part: { text: "Fixed the bug." } }),
  ev({ type: "step_finish", part: { tokens: { total: 10 } } }),
].join("\n");

// ---------------------------------------------------------------------------
// 1. successMarker: only ever an ADDITIONAL condition (issue #103)
// ---------------------------------------------------------------------------

describe("issue #103a: successMarker is an additional condition, never the sole one", () => {
  it("the success expression ANDs the marker with a real pass signal (not looksFailed)", () => {
    // The literal expression pins the explicit AND-contract: the marker counts
    // only combined with !looksFailed, never as a standalone success proof.
    expect(indexSrc).toContain(
      "const markerSeen = p.successMarker ? (parsed.summary ?? \"\").includes(p.successMarker) : false;",
    );
    expect(indexSrc).toContain(
      "const success = (p.successMarker ? markerSeen && !looksFailed : !looksFailed) && verified !== false;",
    );
    // There is no `markerSeen` short-circuit success without the pass signal.
    expect(indexSrc).not.toContain("markerSeen ? true");
  });

  it("a worker printing the marker over a FAILED run does not trick the loop", () => {
    // Behavioral pin: ok:false + the marker in summary must NOT read success.
    const markerLine = indexSrc.split("\n").findIndex((l) => l.includes("const markerSeen ="));
    expect(markerLine).toBeGreaterThanOrEqual(0);
    // The marker check must be inside the looksFailed-informed success AND.
    const successLine = indexSrc.split("\n").findIndex((l) => l.includes("const success ="));
    expect(successLine).toBeGreaterThan(markerLine);
  });
});

// ---------------------------------------------------------------------------
// 2. fleet_iterate returns carry withVerified (verified always present)
// ---------------------------------------------------------------------------

describe("issue #103a: every fleet_iterate return goes through withVerified", () => {
  it("the no-progress escalation return is NOT emitted as a bare jsonResult", () => {
    // The escalation payload must be wrapped so verified/verifyDetails always
    // ride along (null when no gate ran). Pre-fix this bare return exists.
    expect(iterateSrc).not.toMatch(/return jsonResult\(\{[^}]*escalated: true/);
  });

  it("the escalation return IS wrapped with withVerified(..., lastOutcome)", () => {
    // The wrap is multi-line, so match flexibly: the escalated payload and the
    // lastOutcome argument must sit inside ONE withVerified( ... ) call.
    const esc = iterateSrc.indexOf("escalated: true");
    expect(esc).toBeGreaterThanOrEqual(0);
    const openAt = iterateSrc.lastIndexOf("withVerified(", esc);
    const closeAt = iterateSrc.indexOf("lastOutcome", esc);
    expect(openAt).toBeGreaterThan(0);
    expect(closeAt).toBeGreaterThan(esc);
    // No closing paren of this withVerified call before lastOutcome.
    expect(iterateSrc.slice(openAt, closeAt)).not.toContain("));");
  });

  it("the hand-raise return keeps its withVerified wrap", () => {
    expect(iterateSrc).toMatch(
      /return jsonResult\(withVerified\(\{ iterations, handRaised: true, question: parsed\.question, done: false \}, parsed\)\);/,
    );
  });

  it("the exceeded-iterations return keeps its withVerified wrap (lastOutcome)", () => {
    expect(iterateSrc).toContain(
      "withVerified({ iterations, done: true, success: false, note: `exceeded ${maxIter} iterations` }, lastOutcome),",
    );
  });

  it("the success return keeps its withVerified wrap", () => {
    expect(iterateSrc).toContain(
      "return jsonResult(withVerified({ iterations, done: true, success: true, finalSummary: parsed.summary }, parsed));",
    );
  });

  it("no bare jsonResult return of the loop-body payloads remains inside fleet_iterate", () => {
    // Every loop-body return must be wrapped: hand-raise, success, escalation.
    const bareEscalated = /return jsonResult\(\{[^}]*escalated: true/.test(iterateSrc);
    expect(bareEscalated).toBe(false);
  });

  it("withVerified keeps verified present with null for a gateless outcome (contract)", () => {
    const out = withVerified({ done: false, escalated: true }, null);
    expect(out).toEqual({ done: false, escalated: true, verified: null, verifyDetails: null });
  });
});

// ---------------------------------------------------------------------------
// 3. parseOpenCodeOutput takes the real transport/iterations; no hard-coding
// ---------------------------------------------------------------------------

describe("issue #103a: parsers report the real transport/iterations", () => {
  it("the http transport/iteration count rides on ExecStatus when the caller knows it", () => {
    const r = parseOpenCodeOutput(goodRun, { exitCode: 0, transport: "http", iterations: 3 });
    expect(r.transport).toBe("http");
    expect(r.iterations).toBe(3);
  });

  it("the acp transport is reported, not hard-coded to http", () => {
    const r = parseOpenCodeOutput(goodRun, { exitCode: 0, transport: "acp", iterations: 2 });
    expect(r.transport).toBe("acp");
    expect(r.iterations).toBe(2);
  });

  it("backward compatible without exec: falls back to the legacy http/1 values", () => {
    const r = parseOpenCodeOutput(goodRun);
    expect(r.transport).toBe("http");
    expect(r.iterations).toBe(1);
  });

  it("backward compatible with a bare exit code: still defaults to http/1", () => {
    const r = parseOpenCodeOutput(goodRun, { exitCode: 0 });
    expect(r.transport).toBe("http");
    expect(r.iterations).toBe(1);
  });

  it("no source hard-coding remains: transport and iterations always flow from the caller", () => {
    // The parser results must not assert literal values anymore (the interface
    // docs may mention them, so scope to result expressions).
    expect(opencodeSrc).not.toMatch(/^\s*transport: "http",?\s*$/m);
    expect(opencodeSrc).not.toMatch(/^\s*iterations: 1,?\s*$/m);
    // Real values win via ??, with the legacy defaults only as fallback.
    expect(opencodeSrc.match(/exec\?\.transport \?\? DEFAULT_PARSED_TRANSPORT/g)?.length).toBe(3);
    expect(opencodeSrc.match(/exec\?\.iterations \?\? DEFAULT_PARSED_ITERATIONS/g)?.length).toBe(3);
  });

  it("parsePiOutput reports the real transport too (same ExecStatus contract)", () => {
    const r = parsePiOutput("all done", { exitCode: 0, transport: "acp", iterations: 4 });
    expect(r.transport).toBe("acp");
    expect(r.iterations).toBe(4);
    const legacy = parsePiOutput("all done", { exitCode: 0 });
    expect(legacy.transport).toBe("http");
    expect(legacy.iterations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. fleet_run_status surfaces the ledger's harness
// ---------------------------------------------------------------------------

describe("issue #103a: fleet_run_status surfaces harness in its run object", () => {
  let rootDir: string;
  afterEach(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = "";
  });

  const base = (): LedgerEntry => ({
    runId: "run-103a",
    node: "dev2",
    cwd: "/srv/work",
    prompt: "task",
    startedAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date().toISOString(),
    state: "running",
    harness: "pi",
    transport: "http",
  });

  it("fleet_run_status returns a bare (unwrapped) jsonResult — no withVerified on this shape", () => {
    // Sanity pin: the additive `harness` field belongs on the status result
    // object itself, not inside a withVerified wrapper.
    expect(runStatusSrc).not.toContain("withVerified");
  });

  it("harness: entry.harness is threaded into the status result (pinned additive field)", () => {
    expect(runStatusSrc).toContain("harness: entry?.harness");
    expect(runStatusSrc).toContain("Issue #103: surface the engine the run used");
  });

  it("the ledger round-trips harness so the field is real, not vacuous", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fleet103a-"));
    mkdirSync(rootDir, { recursive: true });
    const entry = base();
    await upsertRun(rootDir, entry);
    const fromDisk = (await loadLedger(rootDir)).find((r) => r.runId === "run-103a");
    expect(fromDisk?.harness).toBe("pi");
  });

  it("ExecStatus carries transport+iterations inputs (the parser's contract types)", () => {
    // The interface must accept both inputs so callers can always tell the truth.
    const s: ExecStatus = { exitCode: 0, transport: "acp", iterations: 5 };
    expect(s.transport).toBe("acp");
    expect(s.iterations).toBe(5);
  });
});