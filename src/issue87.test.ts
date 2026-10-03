import { describe, expect, it } from "vitest";
import {
  DEFAULT_S1_URL,
  type FleetQuestions,
  type S1Fetch,
  type S1RequestInit,
  type S1Response,
  decide,
  mapAnswers,
  mapQuestions,
  s1Configured,
} from "./decision.js";

const QUESTIONS: FleetQuestions = {
  proceed: { type: "boolean", instructions: "Proceed with the rollout tonight?" },
  lane: {
    type: "choice",
    instructions: "Which lane?",
    criteria: { canary: "One node first", all: "Everything at once" },
  },
  risk: {
    type: "score",
    instructions: "Rate blast radius on the declared scale.",
    criteria: ["contained", "shared-host", "fleet-wide"],
  },
};

// Valid S1 wire reply for the questions above.
const WIRE_OK = () => ({
  model: "jev",
  answers: {
    proceed: { type: "noul", noul: 0.87 },
    lane: { type: "choice", choice: "canary" },
    risk: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 } },
  },
  usage: { input_tokens: 120, output_tokens: 30 },
});

/** Fake transport that captures the request and replays a canned response. */
function fakeFetch(
  reply: { status: number; payload?: unknown },
  capture?: { url?: string; init?: S1RequestInit },
): S1Fetch {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    const res: S1Response = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (reply.payload === undefined) throw new Error("no payload");
        return reply.payload;
      },
    };
    return res;
  };
}

describe("issue #87: mapQuestions (boolean -> noul)", () => {
  it("maps boolean to noul and forwards choice/score criteria verbatim", () => {
    const r = mapQuestions(QUESTIONS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.questions.proceed).toEqual({ type: "noul", instructions: "Proceed with the rollout tonight?" });
    expect(r.questions.lane).toEqual(QUESTIONS.lane);
    expect(r.questions.risk).toEqual(QUESTIONS.risk);
    const risk = r.questions.risk;
    if (risk.type === "score") expect(risk.criteria).toEqual(["contained", "shared-host", "fleet-wide"]);
  });
  it("keeps boolean criteria when present on the noul question", () => {
    const r = mapQuestions({ b: { type: "boolean", instructions: "ok?", criteria: { scale: "0..1" } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.questions.b).toEqual({ type: "noul", instructions: "ok?", criteria: { scale: "0..1" } });
  });
  it("rejects unknown types, missing instructions and malformed criteria", () => {
    expect(mapQuestions("nope").ok).toBe(false);
    expect(mapQuestions({ x: { type: "essay", instructions: "hi" } })!.ok).toBe(false);
    expect(mapQuestions({ x: { type: "boolean" } })!.ok).toBe(false);
    expect(mapQuestions({ x: { type: "choice", instructions: "i", criteria: {} } })!.ok).toBe(false);
    expect(mapQuestions({ x: { type: "choice", instructions: "i", criteria: { a: 1 } } })!.ok).toBe(false);
    expect(mapQuestions({ x: { type: "score", instructions: "i", criteria: [] } })!.ok).toBe(false);
    expect(mapQuestions({ x: { type: "score", instructions: "i", criteria: [1] } })!.ok).toBe(false);
  });
});

describe("issue #87: mapAnswers (noul -> boolean)", () => {
  it("maps noul to { type: boolean, probabilityTrue }", () => {
    const r = mapAnswers({ proceed: { type: "noul", noul: 0.87 } }, { proceed: QUESTIONS.proceed });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answers.proceed).toEqual({ type: "boolean", probabilityTrue: 0.87 });
  });
  it("fails when noul is not a finite number, instead of defaulting", () => {
    expect(mapAnswers({ proceed: { type: "noul", noul: "0.9" } }, { proceed: QUESTIONS.proceed })!.ok).toBe(false);
    expect(mapAnswers({ proceed: { type: "noul" } }, { proceed: QUESTIONS.proceed })!.ok).toBe(false);
  });
});

describe("issue #87: mapAnswers (choice passthrough)", () => {
  it("passes choice answers through unchanged, extra fields included", () => {
    const wire = { type: "choice", choice: "canary", reason: "small blast radius", tokens: 5 } as const;
    const r = mapAnswers({ lane: wire }, { lane: QUESTIONS.lane });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answers.lane).toEqual(wire);
  });
  it("errors on choice answers for non-choice questions", () => {
    expect(mapAnswers({ proceed: { type: "choice", choice: "x" } }, { proceed: QUESTIONS.proceed })!.ok).toBe(false);
  });
});

describe("issue #87: mapAnswers (score probabilities ordered by criteria)", () => {
  it("builds the probabilities ARRAY from the index-keyed object in criteria order", () => {
    const r = mapAnswers(
      { risk: { type: "score", score: 2, confidence: 0.9, probabilities: { "2": 0.8, "0": 0.05, "1": 0.15 } } },
      { risk: QUESTIONS.risk },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answers.risk).toEqual({ type: "score", score: 2, confidence: 0.9, probabilities: [0.05, 0.15, 0.8] });
  });
  it("errors on missing, non-numeric, extra or unknown-type answers", () => {
    const q = { risk: QUESTIONS.risk };
    expect(mapAnswers({ risk: { type: "score", score: 1, confidence: 0.5, probabilities: { "0": 0.5, "2": 0.1 } } }, q)!.ok).toBe(false);
    expect(mapAnswers({ risk: { type: "score", score: 1, confidence: 0.5, probabilities: { "0": 0.5, "1": "x", "2": 0.1 } } }, q)!.ok).toBe(false);
    expect(mapAnswers({ risk: { type: "score", score: 1, confidence: 0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } } }, q)!.ok).toBe(false);
    expect(mapAnswers({ risk: { type: "essay", text: "meh" } }, q)!.ok).toBe(false);
    expect(mapAnswers({ no_such_id: { type: "score", score: 1, confidence: 1, probabilities: {} } }, q)!.ok).toBe(false);
    expect(mapAnswers({ risk: "yes" }, q)!.ok).toBe(false);
  });
  it("errors when a question is left unanswered", () => {
    expect(mapAnswers({ risk: { type: "score", score: 1, confidence: 1, probabilities: { "0": 1 } } }, { risk: QUESTIONS.risk, proceed: QUESTIONS.proceed })!.ok).toBe(false);
  });
});

describe("issue #87: s1Configured", () => {
  it("defaults to the gateway loopback deployment", () => {
    expect(DEFAULT_S1_URL).toBe("http://127.0.0.1:8009");
    expect(s1Configured({})).toBe("http://127.0.0.1:8009");
  });
  it("honours FLEET_S1_URL and tolerates a trailing slash", () => {
    expect(s1Configured({ FLEET_S1_URL: "http://s1.internal.example:8009/" })).toBe("http://s1.internal.example:8009");
    expect(s1Configured({ FLEET_S1_URL: "  " })).toBe("http://127.0.0.1:8009");
  });
});

describe("issue #87: decide() with an injected fetch", () => {
  it("success: POSTs the wire body and returns mapped answers + usage", async () => {
    const cap: { url?: string; init?: S1RequestInit } = {};
    const r = await decide({ state: { run: "r1" }, questions: QUESTIONS, model: "jev" }, {
      fetch: fakeFetch({ status: 200, payload: WIRE_OK() }, cap),
    });
    expect(r).toMatchObject({
      ok: true,
      model: "jev",
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    if (!r.ok) return;
    expect(r.answers.proceed).toEqual({ type: "boolean", probabilityTrue: 0.87 });
    expect(r.answers.lane).toEqual({ type: "choice", choice: "canary" });
    expect(r.answers.risk).toEqual({ type: "score", score: 2, confidence: 0.9, probabilities: [0.05, 0.15, 0.8] });
    expect(cap.url).toBe("http://127.0.0.1:8009/v1/systemone");
    expect(cap.init?.method).toBe("POST");
    const body = JSON.parse(cap.init?.body ?? "{}") as {
      model: string;
      state: unknown;
      questions: Record<string, { type: string; instructions: string; criteria?: unknown }>;
    };
    expect(body.model).toBe("jev");
    expect(body.state).toEqual({ run: "r1" });
    expect(body.questions.proceed.type).toBe("noul"); // boolean -> noul on the wire
    expect(body.questions.lane.criteria).toEqual(QUESTIONS.lane.criteria);
    expect(body.questions.risk.criteria).toEqual(["contained", "shared-host", "fleet-wide"]);
  });
  it("uses the default model alias and s1Configured URL when omitted", async () => {
    const cap: { url?: string; init?: S1RequestInit } = {};
    await decide({ state: null, questions: QUESTIONS }, { url: "http://override:9/", fetch: fakeFetch({ status: 200, payload: WIRE_OK() }, cap) });
    expect(JSON.parse(cap.init?.body ?? "{}")).toMatchObject({ model: "s1" });
    expect(cap.url).toBe("http://override:9/v1/systemone");
  });
  it("non-200 -> { ok: false } with the HTTP status", async () => {
    const r = await decide({ state: {}, questions: QUESTIONS }, { fetch: fakeFetch({ status: 500 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTTP 500/);
  });
  it("transport failure -> { ok: false }, never throws", async () => {
    const boom: S1Fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await decide({ state: {}, questions: QUESTIONS }, { fetch: boom });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ECONNREFUSED/);
  });
  it("timeout: the request is aborted after timeoutMs -> { ok: false }", async () => {
    let aborted = false;
    const hang: S1Fetch = (_url, init) =>
      new Promise<S1Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("This operation was aborted"));
        });
      });
    const r = await decide({ state: {}, questions: QUESTIONS }, { fetch: hang, timeoutMs: 25 });
    expect(aborted).toBe(true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/S1 request failed/);
  });
  it("malformed reply (HTTP 200): bad usage or bad answers -> { ok: false }", async () => {
    const badUsage = { ...WIRE_OK(), usage: { input_tokens: "many", output_tokens: 1 } };
    expect((await decide({ state: {}, questions: QUESTIONS }, { fetch: fakeFetch({ status: 200, payload: badUsage }) })).ok).toBe(false);
    const wrongType = { ...WIRE_OK(), answers: { ...WIRE_OK().answers, risk: { type: "essay", text: "meh" } } };
    const r = await decide({ state: {}, questions: QUESTIONS }, { fetch: fakeFetch({ status: 200, payload: wrongType }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/risk/);
  });
  it("invalid questions never reach the wire", async () => {
    let called = false;
    const spy: S1Fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const r = await decide({ state: {}, questions: { x: { type: "bogus", instructions: "i" } } as unknown as FleetQuestions }, { fetch: spy });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bogus/);
  });
});