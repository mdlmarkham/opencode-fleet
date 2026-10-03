import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenCodeCommand, parsePiOutput, validateHarnessTransport } from "./opencode.js";
import {
  interpretProbe,
  probeAckRecovery,
  abortStateWrite,
  interpretLiveness,
  ACK_ABSENT_NOTE,
  ACK_CONFIRMED_NOTE,
  ACK_INCONCLUSIVE_NOTE,
} from "./recovery.js";
import { shq } from "./shell.js";

/**
 * Issue #30 regression guards — the three converging reviews' findings.
 *
 * A: parsePiOutput must derive ok from real execution status.
 * B: Pi model fallback must NOT forward the opencode model ref.
 * C: Pi prompt must be injection-safe (never read as a flag).
 * D: `--auto` must be opt-in (autoApprove) and absent from the acp branch.
 * E: ack-recovery probe decision is an allow-list with three outcomes.
 */

describe("issue #30A: buildOpenCodeCommand (pi) + autoApprove", () => {
  it("drives pi with the default Pi model, prompt via stdin (findings B+C)", () => {
    const cmd = buildOpenCodeCommand({ prompt: "do work", cwd: "/work", transport: "http", harness: "pi" });
    expect(cmd).toContain("pi -p --model 'aperture/glm-5.3-flash:cloud'");
    expect(cmd).toContain("printf '%s' 'do work' |");
    expect(cmd).not.toContain("opencode run");
  });

  it("never forwards the opencode model ref to Pi (finding B)", () => {
    const cmd = buildOpenCodeCommand({
      prompt: "x",
      cwd: "/w",
      transport: "http",
      harness: "pi",
      model: "aperture-anthropic/claude-sonnet-4",
    });
    expect(cmd).not.toContain("aperture-anthropic");
    expect(cmd).toContain("'aperture/glm-5.3-flash:cloud'");
  });

  it("honors an explicit piModel", () => {
    const cmd = buildOpenCodeCommand({ prompt: "x", cwd: "/w", transport: "http", harness: "pi", piModel: "aperture/kimi-k2" });
    expect(cmd).toContain("--model 'aperture/kimi-k2'");
  });

  it("feeds the prompt via STDIN; a hostile prompt can never be a flag (finding C)", () => {
    // Live-proven on dev2 (pi 0.73.1): pi has NO `--` separator, and a
    // positional `-`-leading prompt is parsed as a flag. The fix pipes the
    // prompt via stdin, quoted.
    const hostile = `-rf /; echo "$(id)" && it's`;
    const cmd = buildOpenCodeCommand({ prompt: hostile, cwd: "/w", transport: "http", harness: "pi" });
    expect(cmd).toContain(`printf '%s' ${shq(hostile)} |`);
    expect(cmd).toContain("pi -p --model");
    // No `--` end-of-options separator (pi rejects it: Unknown option: --),
    // and no positional prompt trailing the flags.
    expect(cmd).not.toContain(" -- ");
  });

  it("omits --auto from `opencode run` by default (finding D)", () => {
    const cmd = buildOpenCodeCommand({ prompt: "x", cwd: "/w", transport: "http" });
    expect(cmd).toContain("opencode run ");
    expect(cmd).not.toContain("--auto");
  });

  it("adds --auto to `opencode run` only when autoApprove=true (finding D)", () => {
    const cmd = buildOpenCodeCommand({ prompt: "x", cwd: "/w", transport: "http", autoApprove: true });
    expect(cmd).toContain("opencode run --auto");
  });

  it("never emits --auto on the acp branch (finding D)", () => {
    const cmd = buildOpenCodeCommand({ prompt: "x", cwd: "/w", transport: "acp" });
    expect(cmd).toContain("opencode acp");
    expect(cmd).not.toContain("--auto");
  });
});

describe("issue #30A: parsePiOutput derives ok from execution status", () => {
  it("reports success + harness=pi for a clean run", () => {
    const r = parsePiOutput("all good, 3 files changed", { exitCode: 0 });
    expect(r.ok).toBe(true);
    expect(r.harness).toBe("pi");
    expect(r.error).toBeUndefined();
  });

  it("detects HAND_RAISE", () => {
    const r = parsePiOutput("HAND_RAISE: which package manager?", { exitCode: 0 });
    expect(r.handRaised).toBe(true);
    expect(r.question).toContain("which package manager");
    expect(r.ok).toBe(true);
  });

  it("fails on a FLEET_ERROR (cd guard) marker", () => {
    const r = parsePiOutput("FLEET_ERROR: cannot enter cwd /root as svc (uid 1000): 1", { exitCode: 66 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("FLEET_ERROR");
  });

  it("fails on a non-zero exit code", () => {
    const r = parsePiOutput("boom", { exitCode: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("non-zero");
    expect(r.error).toContain("1");
  });

  it("fails on timeout (exit 124 / timedOut)", () => {
    expect(parsePiOutput("partial", { exitCode: 124 }).ok).toBe(false);
    const r = parsePiOutput("partial\n[timeout]", { timedOut: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it("fails on a watchdog (stuck) kill", () => {
    const r = parsePiOutput("hi\n[stuck: no output for 120s]", { stuck: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/watchdog/);
  });
});

describe("issue #30E: interpretProbe allow-list", () => {
  it("confirms only positive states", () => {
    expect(interpretProbe({ ok: true, state: "running" })).toBe("running");
    expect(interpretProbe({ ok: true, state: "finished" })).toBe("finished");
    expect(interpretProbe({ ok: true, state: "aborted" })).toBe("aborted");
    expect(interpretProbe({ ok: true, pid: 4321 })).toBe("running");
    expect(interpretProbe({ ok: true, alive: true })).toBe("running");
  });

  it("treats an explicit never-started as definitively absent, generic errors as inconclusive", () => {
    expect(interpretProbe({ ok: false, status: "never-started" })).toBe("absent");
    // Finding E: a generic {ok:false} with NO status is NOT proof of absence —
    // it must be inconclusive, never a re-dispatch-safe "absent".
    expect(interpretProbe({ ok: false })).toBe("inconclusive");
  });

  it("never confirms cleaned without a pid/state", () => {
    expect(interpretProbe({ ok: false, status: "cleaned" })).toBe("inconclusive");
    expect(interpretProbe({ ok: true, status: "cleaned" })).toBe("inconclusive");
    // cleaned WITH a live pid is a real confirmation.
    expect(interpretProbe({ ok: true, status: "cleaned", pid: 7 })).toBe("running");
  });

  it("treats unknown / absent / junk as inconclusive", () => {
    expect(interpretProbe({ ok: true, status: "unknown" })).toBe("inconclusive");
    expect(interpretProbe({})).toBe("inconclusive");
    expect(interpretProbe(null)).toBe("inconclusive");
    expect(interpretProbe(undefined)).toBe("inconclusive");
  });
});

describe("issue #30E: ack-recovery decision path", () => {
  /** Mirrors the dispatch decision: turn a probe outcome into a result shape. */
  const decide = async (invokeProbe: (s: AbortSignal) => Promise<unknown>) => {
    const recovery = await probeAckRecovery(invokeProbe);
    if (recovery.kind === "confirmed") {
      return { ok: true as const, recoveredFromTimeout: true as const, note: recovery.note, pid: recovery.pid };
    }
    return { ok: false as const, note: recovery.note, probe: recovery.verdict };
  };

  it("timeout + positive probe => ok:true, recoveredFromTimeout (do NOT re-dispatch)", async () => {
    const invokeProbe = vi.fn(async (_sig: AbortSignal) => ({ payload: JSON.stringify({ ok: true, state: "running", pid: 991 }) }));
    const out = await decide(invokeProbe);
    expect(out.ok).toBe(true);
    expect((out as { recoveredFromTimeout?: boolean }).recoveredFromTimeout).toBe(true);
    expect(out.note).toBe(ACK_CONFIRMED_NOTE);
    expect(invokeProbe).toHaveBeenCalledTimes(1);
    // The probe uses a FRESH timeout-only signal, never the caller's.
    const sig = invokeProbe.mock.calls[0]![0];
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
  });

  it("timeout + definitively-absent probe => ok:false, safe to re-dispatch", async () => {
    const out = await decide(async () => ({ payload: JSON.stringify({ ok: false, status: "never-started" }) }));
    expect(out.ok).toBe(false);
    expect(out.note).toBe(ACK_ABSENT_NOTE);
    expect(out.note).toContain("Safe to re-dispatch.");
  });

  it("probe THROWS => inconclusive, NOT safe to re-dispatch", async () => {
    const out = await decide(async () => {
      throw new Error("relay exploded");
    });
    expect(out.ok).toBe(false);
    expect(out.note).toBe(ACK_INCONCLUSIVE_NOTE);
    expect(out.note).not.toContain("Safe to re-dispatch.");
  });

  it("probe returns invokeTimedOut => inconclusive, NOT safe", async () => {
    const out = await decide(async () => ({ invokeTimedOut: true, message: "timeout" }));
    expect(out.ok).toBe(false);
    expect(out.note).toBe(ACK_INCONCLUSIVE_NOTE);
    expect(out.note).not.toContain("Safe to re-dispatch.");
  });

  it("probe returns an ambiguous cleaned payload => inconclusive, NOT safe", async () => {
    const out = await decide(async () => ({ payload: JSON.stringify({ ok: false, status: "cleaned" }) }));
    expect(out.ok).toBe(false);
    expect(out.probe).toBe("inconclusive");
    expect(out.note).not.toContain("Safe to re-dispatch.");
  });
});

describe("issue #30G: reject harness=pi with transport=acp", () => {
  it("returns ok:false for pi+acp (finding G)", () => {
    const v = validateHarnessTransport({ harness: "pi", transport: "acp" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/requires transport=http/);
  });
  it("allows pi+http and opencode+acp (finding G)", () => {
    expect(validateHarnessTransport({ harness: "pi", transport: "http" }).ok).toBe(true);
    expect(validateHarnessTransport({ harness: "opencode", transport: "acp" }).ok).toBe(true);
  });
});

describe("issue #30H: abort only marks aborted on CONFIRMED termination", () => {
  const prior = {
    runId: "r1",
    pid: 4242,
    harness: "pi",
    piModel: "aperture/glm-5.3-flash:cloud",
    startedAt: "t0",
  };
  it("leaves state untouched when termination is NOT confirmed (finding H)", () => {
    expect(abortStateWrite(prior, false, "t1")).toBeNull();
  });
  it("marks aborted and PRESERVES harness/pid/piModel when confirmed (finding H)", () => {
    const next = abortStateWrite(prior, true, "t1");
    expect(next).toMatchObject({
      state: "aborted",
      finishedAt: "t1",
      pid: 4242,
      harness: "pi",
      piModel: "aperture/glm-5.3-flash:cloud",
    });
  });
});

describe("issue #30I: engine-independent liveness", () => {
  it("reports alive for the recorded pid (PIDALIVE marker) (finding I)", () => {
    expect(interpretLiveness("PIDALIVE 4242", 4242).alive).toBe(true);
  });
  it("reports alive for a matching pi process line (finding I)", () => {
    expect(interpretLiveness("1234 00:10 pi -p --model x", undefined).alive).toBe(true);
  });
  it("ignores a PIDALIVE marker for a DIFFERENT pid with no procs => dead (finding I)", () => {
    expect(interpretLiveness("PIDALIVE 9999", 4242).alive).toBe(false);
  });
  it("reports dead when nothing matches (finding I)", () => {
    expect(interpretLiveness("", 4242).alive).toBe(false);
  });
});

describe("issue #48: validateHarnessTransport is the single production guard", () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  it("is called from both the gateway dispatch and the node handler", () => {
    expect((index.match(/validateHarnessTransport\(/g) ?? []).length).toBe(2);
  });
  it("no longer carries an inline copy of the predicate", () => {
    expect(index).not.toMatch(/task\.transport === "acp" && task\.harness === "pi"/);
  });
  it("the dead __RUN_ABORT__ handler is gone (fleet_abort routes through __ABORT__ + runId)", () => {
    expect(index).not.toContain('task.prompt === "__RUN_ABORT__"');
  });
});
