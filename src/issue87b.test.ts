import { describe, expect, it } from "vitest";
import {
  HAND_RAISE_CRITERIA,
  SATISFIED_THRESHOLD,
  adjudicateCompletion,
  routeEngine,
  triageHandRaise,
  type DecideFn,
} from "./s1-hooks.js";
import type { DecideInput, FleetAnswer, FleetQuestion } from "./decision.js";

// ---------------------------------------------------------------------------
// Stub decideFn: records the exact request handed to it and replies with a
// canned answer for the (single) question that was asked. No network, no
// server — the hooks drive everything through the injected fn.
// ---------------------------------------------------------------------------

type DecideCalls = DecideInput[];

function okDecide(answer: FleetAnswer, calls?: DecideCalls): DecideFn {
  return async (input) => {
    calls?.push(input);
    const id = Object.keys(input.questions)[0];
    return {
      ok: true,
      model: "stub-s1",
      answers: { [id]: answer },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  };
}

function failingDecide(calls?: DecideCalls, error = "S1 returned HTTP 503"): DecideFn {
  return async (input) => {
    calls?.push(input);
    return { ok: false, error };
  };
}

/** Asserts the hook asked exactly ONE question; returns { id, question }. */
function singleQuestion(call: DecideInput): { id: string; question: FleetQuestion } {
  const ids = Object.keys(call.questions);
  expect(ids).toHaveLength(1);
  return { id: ids[0], question: call.questions[ids[0]] };
}

// ---------------------------------------------------------------------------
// 1. adjudicateCompletion
// ---------------------------------------------------------------------------

const ADJUDICATE_INPUT = {
  acceptance: ["fleet tests green", "ledger schema migrated"],
  diffSummary: "adds verify hook; +120/-4 across 3 files",
  verifyDetails: "npm test: 210 passed, 0 failed; migration dry-run ok",
};

describe("issue #87b: adjudicateCompletion (S1 boolean hook)", () => {
  it("happy path: stubbed YES answer drives satisfied=true + confidence", async () => {
    const calls: DecideCalls = [];
    const r = await adjudicateCompletion(ADJUDICATE_INPUT, okDecide({ type: "boolean", probabilityTrue: 0.93 }, calls));
    expect(r.satisfied).toBe(true);
    expect(r.confidence).toBe(0.93);
    expect(typeof r.reason).toBe("string");
  });

  it("happy path: a NO answer (below threshold) yields satisfied=false, not null", async () => {
    const r = await adjudicateCompletion(ADJUDICATE_INPUT, okDecide({ type: "boolean", probabilityTrue: 0.4 }));
    expect(r.satisfied).toBe(false);
    expect(r.confidence).toBe(0.4);
  });

  it("boundary: probabilityTrue exactly at SATISFIED_THRESHOLD counts as satisfied", async () => {
    const r = await adjudicateCompletion(
      ADJUDICATE_INPUT,
      okDecide({ type: "boolean", probabilityTrue: SATISFIED_THRESHOLD }),
    );
    expect(r.satisfied).toBe(true);
    expect(r.confidence).toBe(SATISFIED_THRESHOLD);
  });

  it("sends ONE boolean question over the acceptance set, with the artifact in state", async () => {
    const calls: DecideCalls = [];
    await adjudicateCompletion(ADJUDICATE_INPUT, okDecide({ type: "boolean", probabilityTrue: 0.93 }, calls));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined(); // narrows strict indexing below
    if (!call) return;
    const { question } = singleQuestion(call);
    expect(question.type).toBe("boolean");
    expect(
      question.instructions.startsWith("Does this change satisfy the stated acceptance criteria?"),
    ).toBe(true);
    // The instructions carry the real values (specific binary, not vague safety).
    for (const criterion of ADJUDICATE_INPUT.acceptance) {
      expect(question.instructions).toContain(criterion);
    }
    expect(question.instructions).toContain(ADJUDICATE_INPUT.diffSummary);
    expect(question.instructions).toContain(ADJUDICATE_INPUT.verifyDetails);
    // ... and the concrete artifact travels in state.
    expect(call.state).toEqual(ADJUDICATE_INPUT);
  });

  it("fallback: decide {ok:false} -> satisfied=null (never assumes true), reason carries the error", async () => {
    const calls: DecideCalls = [];
    const r = await adjudicateCompletion(ADJUDICATE_INPUT, failingDecide(calls, "S1 returned HTTP 503"));
    expect(r.satisfied).toBeNull();
    expect(r.confidence).toBeUndefined();
    expect(r.reason).toContain("503");
    expect(calls).toHaveLength(1); // it did ask, then fell back safely
  });

  it("fallback: a malformed (non-boolean) answer is treated as unavailable -> satisfied=null", async () => {
    const r = await adjudicateCompletion(
      ADJUDICATE_INPUT,
      okDecide({ type: "choice", choice: "yes" }), // valid choice answer, wrong for this hook
    );
    expect(r.satisfied).toBeNull();
    expect(r.reason).toContain("malformed");
  });
});

// ---------------------------------------------------------------------------
// 2. triageHandRaise
// ---------------------------------------------------------------------------

const HAND_INPUT = {
  question: "Should we roll back node-3 outside the maintenance window?",
  context: "run r9: canary healthy; node-3 disk pressure 92%; rollback policy says wait for the window",
};

describe("issue #87b: triageHandRaise (S1 choice hook)", () => {
  it("happy path: stubbed 'answer' selection yields action=answer", async () => {
    const calls: DecideCalls = [];
    const r = await triageHandRaise(
      HAND_INPUT,
      okDecide({ type: "choice", choice: "answer", reason: "policy text resolves it" }, calls),
    );
    expect(r.action).toBe("answer");
    expect(r.reason).toContain("answer");
  });

  it("happy path: stubbed 'escalate' selection yields action=escalate", async () => {
    const r = await triageHandRaise(HAND_INPUT, okDecide({ type: "choice", choice: "escalate" }));
    expect(r.action).toBe("escalate");
  });

  it("sends ONE choice question with the #87 criteria, with the artifact in state", async () => {
    const calls: DecideCalls = [];
    await triageHandRaise(HAND_INPUT, okDecide({ type: "choice", choice: "answer" }, calls));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const { question } = singleQuestion(call);
    expect(question.type).toBe("choice");
    expect(question.criteria).toEqual(HAND_RAISE_CRITERIA);
    expect(question.instructions).toContain(HAND_INPUT.question);
    expect(question.instructions).toContain(HAND_INPUT.context);
    expect(call.state).toEqual(HAND_INPUT);
  });

  it("fallback: decide {ok:false} -> escalate (never silently swallow), reason carries the error", async () => {
    const calls: DecideCalls = [];
    const r = await triageHandRaise(HAND_INPUT, failingDecide(calls, "S1 returned HTTP 503"));
    expect(r.action).toBe("escalate");
    expect(r.reason).toContain("503");
    expect(calls).toHaveLength(1); // it did ask, then fell back safely
  });

  it("fallback: an unrecognized selection -> escalate", async () => {
    const r = await triageHandRaise(HAND_INPUT, okDecide({ type: "choice", choice: "summon" }));
    expect(r.action).toBe("escalate");
    expect(r.reason).toContain("summon");
  });
});

// ---------------------------------------------------------------------------
// 3. routeEngine
// ---------------------------------------------------------------------------

const ROUTE_INPUT = {
  spec: "rewrite the recovery planner; heavy TS refactoring with a long test loop",
  candidates: ["codex", "claude", "gemini"],
};

describe("issue #87b: routeEngine (S1 score hook)", () => {
  it("happy path: returns the top-scoring candidate", async () => {
    const calls: DecideCalls = [];
    const r = await routeEngine(
      ROUTE_INPUT,
      okDecide({ type: "score", score: 1, confidence: 0.8, probabilities: [0.15, 0.8, 0.05] }, calls),
    );
    expect(r.engine).toBe("claude");
    expect(typeof r.reason).toBe("string");
  });

  it("ties break deterministically to the first candidate in criteria order", async () => {
    const r = await routeEngine(
      ROUTE_INPUT,
      okDecide({ type: "score", score: 0, confidence: 1, probabilities: [0.9, 0.9, 0.05] }),
    );
    expect(r.engine).toBe("codex");
  });

  it("sends ONE score question over the candidate engines, with the artifact in state", async () => {
    const calls: DecideCalls = [];
    await routeEngine(
      ROUTE_INPUT,
      okDecide({ type: "score", score: 1, confidence: 0.8, probabilities: [0.15, 0.8, 0.05] }, calls),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const { question } = singleQuestion(call);
    expect(question.type).toBe("score");
    expect(question.criteria).toEqual(ROUTE_INPUT.candidates);
    expect(question.instructions).toContain(ROUTE_INPUT.spec);
    expect(call.state).toEqual(ROUTE_INPUT);
  });

  it("fallback: decide {ok:false} -> engine=null, reason carries the error", async () => {
    const calls: DecideCalls = [];
    const r = await routeEngine(ROUTE_INPUT, failingDecide(calls, "S1 returned HTTP 503"));
    expect(r.engine).toBeNull();
    expect(r.reason).toContain("503");
    expect(calls).toHaveLength(1); // it did ask, then fell back safely
  });

  it("fallback: probabilities that don't line up with the candidates -> engine=null", async () => {
    const r = await routeEngine(
      ROUTE_INPUT,
      okDecide({ type: "score", score: 0, confidence: 1, probabilities: [0.5, 0.5] }),
    );
    expect(r.engine).toBeNull();
  });
});