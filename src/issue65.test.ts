/**
 * Issue #65 slice 1: the structured task spec (goal / acceptance / verify) as
 * the dispatch unit, built on the EXISTING #62/#40 verify gate.
 *
 * The hard constraint is back-compat: with NO spec, every emitted string must
 * be byte-identical to today —
 *   - a prompt-only call passes the raw prompt through verbatim
 *     (renderSpec({ goal: prompt }) === prompt, byte for byte);
 *   - the ledger entry gains no `spec` key;
 *   - the gate comes from the flat `expect` exactly as before, and a specless
 *     run emits nothing extra (verified: null shape unchanged).
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTaskSpec, renderSpec, type TaskSpec } from "./spec.js";
import { evaluateExpect, parseExpectSpec, type ExpectCheck } from "./verify.js";
import { loadLedger, upsertRun, type LedgerEntry } from "./ledger.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("issue #65: renderSpec — the rendered engine prompt", () => {
  it("goal on the first line, then an 'Acceptance criteria:' bullet list", () => {
    const spec: TaskSpec = {
      goal: "Implement the config loader",
      acceptance: ["loads YAML", "fails loudly on bad input"],
    };
    expect(renderSpec(spec)).toBe(
      [
        "Implement the config loader",
        "",
        "Acceptance criteria:",
        "- loads YAML",
        "- fails loudly on bad input",
      ].join("\n"),
    );
  });

  it("prompt-only back-compat: renderSpec({ goal: prompt }) === prompt EXACTLY (byte for byte)", () => {
    const prompts = [
      "do the thing",
      "line1\nline2",
      "trailing newline\n",
      "   leading and trailing spaces   ",
      "tabs\tand   interior    spaces",
      "unicode ✓ ümlaut 🚀 — punctuation; stays",
      "__RUN_START__", // even a sentinel-shaped goal renders verbatim here; the gateway's sentinel refusal still guards it
      "",
    ];
    for (const prompt of prompts) expect(renderSpec({ goal: prompt })).toBe(prompt);
  });

  it("is deterministic: repeated calls and key-order permutations are byte-identical; no hidden state", () => {
    const spec: TaskSpec = { goal: "goal text", acceptance: ["a", "b"] };
    const first = renderSpec(spec);
    for (let i = 0; i < 5; i++) expect(renderSpec(spec)).toBe(first);
    // Key order / spread copies do not matter (a pure function of the VALUE).
    expect(renderSpec({ acceptance: ["a", "b"], goal: "goal text" })).toBe(first);
    expect(renderSpec({ ...spec, verify: { files: ["x"] } })).toBe(first);
    expect(renderSpec({ ...spec, verify: undefined })).toBe(first);
  });

  it("empty or absent acceptance renders just the goal — no header, no separator, no added newline", () => {
    expect(renderSpec({ goal: "only a goal" })).toBe("only a goal");
    expect(renderSpec({ goal: "only a goal", acceptance: [] })).toBe("only a goal");
  });

  it("blank acceptance items are dropped; real items are kept verbatim", () => {
    expect(renderSpec({ goal: "g", acceptance: ["", "   ", "real one"] })).toBe(
      "g\n\nAcceptance criteria:\n- real one",
    );
    expect(renderSpec({ goal: "g", acceptance: ["", "   "] })).toBe("g");
  });

  it("verify shapes the run's gate, never the rendered prompt", () => {
    const rendered = renderSpec({ goal: "g", acceptance: ["a"], verify: { command: "npm test -- --silent" } });
    expect(rendered).toBe("g\n\nAcceptance criteria:\n- a");
    expect(rendered).not.toContain("npm test");
  });
});

describe("issue #65: parseTaskSpec — fail-closed validation", () => {
  it("absent / null spec is ok-but-undefined (prompt-only callers are untouched)", () => {
    expect(parseTaskSpec(undefined)).toEqual({ ok: true, spec: undefined });
    expect(parseTaskSpec(null)).toEqual({ ok: true, spec: undefined });
  });

  it("accepts a well-formed spec (returned verbatim)", () => {
    const spec: TaskSpec = { goal: "g", acceptance: ["a"], verify: { files: ["f"], command: "true" } };
    expect(parseTaskSpec(spec)).toEqual({ ok: true, spec });
    expect(parseTaskSpec({ goal: "g" })).toEqual({ ok: true, spec: { goal: "g" } });
  });

  it("refuses malformed specs (never silently trimmed into a different task)", () => {
    expect(parseTaskSpec("goal only").ok).toBe(false);
    expect(parseTaskSpec(["goal"]).ok).toBe(false);
    expect(parseTaskSpec(42).ok).toBe(false);
    expect(parseTaskSpec({}).ok).toBe(false);
    expect(parseTaskSpec({ goal: "" }).ok).toBe(false);
    expect(parseTaskSpec({ goal: "   " }).ok).toBe(false);
    expect(parseTaskSpec({ goal: 7 }).ok).toBe(false);
  });

  it("refuses malformed acceptance", () => {
    expect(parseTaskSpec({ goal: "g", acceptance: "one" }).ok).toBe(false);
    expect(parseTaskSpec({ goal: "g", acceptance: [1] }).ok).toBe(false);
    expect(parseTaskSpec({ goal: "g", acceptance: [""] }).ok).toBe(false);
    expect(parseTaskSpec({ goal: "g", acceptance: ["  "] }).ok).toBe(false);
  });

  it("verify is NOT validated here: the gate stays owned by the ONE gate parser (parseExpectSpec)", () => {
    // A spec whose verify is junk parses fine as a spec; the dispatch refuses
    // it at the gate-threading point with the SAME parser the flat `expect`
    // uses — one refusal path, no duplicated gate rules (see wiring test).
    expect(parseTaskSpec({ goal: "g", verify: {} })).toEqual({ ok: true, spec: { goal: "g", verify: {} } });
    expect(parseExpectSpec({}).ok).toBe(false);
  });
});

describe("issue #65: spec.verify maps onto the EXISTING gate (reuse evaluateExpect, no duplication)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("spec.verify parses to the SAME gate as an equivalent flat `expect` and evaluates with the existing evaluator", async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet65-"));
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, "built.js"), "x");
    const verify = { files: ["built.js"], command: "test -f built.js" };
    // What the dispatch does with spec.verify...
    const fromSpec = parseExpectSpec(verify);
    // ...is exactly what it does with the flat `expect` of the same value.
    const fromFlat = parseExpectSpec({ files: ["built.js"], command: "test -f built.js" });
    expect(fromSpec).toEqual({ ok: true, expect: { files: ["built.js"], command: "test -f built.js" } });
    expect(fromSpec).toEqual(fromFlat);
    if (!fromSpec.ok) throw new Error("unreachable: spec.verify parsed fine");
    // And the mapped gate is consumed by the ONE evaluator — the same node-side
    // machinery the #62/#40 gate always used (files+command both present here).
    const outcome = await evaluateExpect(fromSpec.expect!, dir);
    expect(outcome.verified).toBe(true);
    expect(outcome.verifyDetails).toEqual({
      files: [{ path: "built.js", ok: true }],
      command: { cmd: "test -f built.js", exitCode: 0, ok: true },
    });
  });

  it("an invalid spec.verify is refused by that same gate parser — malformed gate is a clear refusal", async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet65b-"));
    const mapped = parseExpectSpec({}); // what dispatch does with spec.verify === {}
    expect(mapped.ok).toBe(false);
    expect((mapped as { error?: string }).error).toBe("expect requires at least one of files or command");
    // ...and the flat path refuses identically (one parser, one shape).
    expect(parseExpectSpec({})).toEqual(mapped);
  });

  it("a spec with NO verify maps to no gate at all (nothing extra is emitted)", () => {
    const parsed = parseExpectSpec(
      (parseTaskSpec({ goal: "g" }) as { ok: true; spec: TaskSpec }).spec.verify,
    );
    expect(parsed).toEqual({ ok: true, expect: undefined });
    // Identical to a gateless flat dispatch (verified: null shape stays as-is).
    expect(parseExpectSpec(undefined)).toEqual({ ok: true, expect: undefined });
  });
});

describe("issue #65: ledger — the run's spec is recorded", () => {
  it("a spec dispatch persists the spec on the entry (round-trips through disk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet65l-"));
    try {
      const spec: TaskSpec = { goal: "ship the parser", acceptance: ["tests green"], verify: { files: ["out.md"] } };
      const entry: LedgerEntry = {
        runId: "run-spec",
        node: "dev2",
        cwd: "/w",
        prompt: renderSpec(spec),
        startedAt: new Date(1_700_000_000_000).toISOString(),
        updatedAt: new Date().toISOString(),
        state: "running",
        spec,
      };
      await upsertRun(dir, entry);
      const runs = await loadLedger(dir);
      expect(runs[0].spec).toEqual(spec);
      expect(runs[0].prompt).toBe("ship the parser\n\nAcceptance criteria:\n- tests green");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a prompt-only dispatch leaves NO spec key on the entry (byte-compat ledger)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet65l2-"));
    try {
      const entry: LedgerEntry = {
        runId: "run-plain",
        node: "dev2",
        cwd: "/w",
        prompt: "plain prompt",
        startedAt: new Date(1_700_000_000_000).toISOString(),
        updatedAt: new Date().toISOString(),
        state: "running",
      };
      await upsertRun(dir, entry);
      const runs = await loadLedger(dir);
      expect(JSON.parse(JSON.stringify(runs[0]))).not.toHaveProperty("spec");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("issue #65: gateway wiring (fleet_dispatch)", () => {
  const src = readFileSync(join(here, "index.ts"), "utf8");

  it("fleet_dispatch accepts an optional spec and renders the prompt from goal + acceptance", () => {
    expect(src).toContain("parseTaskSpec(raw.spec)");
    // Prompt-only rides through verbatim; spec-only renders. One expression,
    // so the no-spec path cannot drift from today's behavior.
    expect(src).toContain("specCheck.spec ? renderSpec(specCheck.spec) : (raw.prompt as string)");
  });

  it("a call with NEITHER prompt nor spec is refused", () => {
    expect(src).toContain('if (!specCheck.spec && typeof raw.prompt !== "string")');
    expect(src).toContain("no task given: pass `prompt`, or a structured `spec` with at least a goal (issue #65)");
  });

  it("the rendered prompt rides the EXISTING byte-identical paths (sentinel guard + detached relay)", () => {
    // #22 pinned relay shape: the sentinel still carries the wire; the real
    // (spec-rendered) prompt rides realPrompt exactly like a flat prompt does.
    expect(src).toContain('const launchParams = { ...task, prompt: "__RUN_START__", realPrompt: p.prompt, runId };');
    // The rendered prompt is still subject to the sentinel refusal.
    expect(src).toContain("isSentinelPrompt(p.prompt?.trim())");
  });

  it("spec.verify threads into the SAME gate as the flat `expect` (one parser, one threading, one error shape)", () => {
    expect(src).toContain("parseExpectSpec(specCheck.spec.verify)");
    expect(src).toContain("parseExpectSpec(p.expect)"); // the flat path, untouched
    expect(src).toContain("expect: expectSpec.expect,"); // same node threading as #62
    // One refusal shape for both gate sources.
    expect(src).toContain("`invalid expect: ${expectSpec.error}`");
  });

  it("prompt is no longer schema-required (spec-only calls must reach the handler)", () => {
    expect(src).toContain('required: ["cwd"]');
    expect(src.match(/required: \["cwd"\]/g)?.length).toBe(1); // only fleet_dispatch changed
    expect(src).not.toContain('required: ["prompt", "cwd"]');
  });

  it("no spec => no behaviour change: today's flat `expect` path and ledger shape are untouched", () => {
    expect(src).toContain("...(specCheck.spec ? { spec: specCheck.spec } : {})");
    // The #40/#62 wiring pins are re-asserted here on purpose: slice 1 must not
    // touch them (see issue62.test.ts / issue40.test.ts for the originals).
    expect(src).toContain('verified: typeof st.verified === "boolean" ? st.verified : null');
    expect(src).toContain("verifyDetails: st.verifyDetails ?? null");
  });
});