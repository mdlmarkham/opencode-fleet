import { describe, expect, it } from "vitest";
import { makeDecider, parseS1Config, redactQuestions } from "./decision-backends.js";
import type { S1RequestInit } from "./decision.js";

// A recognisable secret shape (matches the github-token pattern in untrusted.ts).
const SECRET = "ghp_" + "A".repeat(36);

function hosted() {
  const r = parseS1Config({ backend: "zen-jev", backends: { "zen-jev": { url: "https://s1.example.net", allowEgress: true, model: "jev-1" } } });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}
function loopback() {
  const r = parseS1Config({ backend: "local-kev" });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const replyFor = (ids: string[]) => ({
  model: "jev-1",
  answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.5 }])),
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("issue #101: egress redaction covers question instructions + criteria", () => {
  it("redactQuestions scrubs instructions and criteria values but KEEPS keys", () => {
    const out = redactQuestions({
      q1: { type: "boolean", instructions: `safe? ${SECRET}` },
      q2: { type: "choice", instructions: "pick", criteria: { opt_a: `desc ${SECRET}` } },
      q3: { type: "score", instructions: "rate", criteria: [`low ${SECRET}`, "high"] },
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain(SECRET);
    // ids (question ids AND choice option ids) are code-defined -> unchanged
    expect(Object.keys(out)).toEqual(["q1", "q2", "q3"]);
    expect(Object.keys((out.q2 as { criteria: Record<string, unknown> }).criteria)).toEqual(["opt_a"]);
  });

  it("hosted backend: a secret seeded in state, instructions, and all criteria types never reaches the wire", async () => {
    let body = "";
    const d = makeDecider(hosted(), { fetch: async (_u, init: S1RequestInit) => { body = String(init.body); return { ok: true, status: 200, json: async () => replyFor(["q1"]) }; } });
    const r = await d({
      state: { conn: `postgres://u:p@${SECRET}` },
      questions: {
        q1: { type: "boolean", instructions: `is this safe? ${SECRET}` },
      },
    });
    expect(r.ok).toBe(true);
    expect(body).not.toContain(SECRET);
    expect(body).toContain("[REDACTED:github-token]");
  });

  it("hosted backend: choice + score criteria are redacted too", async () => {
    let body = "";
    const choiceReply = { model: "jev-1", answers: { q1: { type: "choice", choice: "a" }, q2: { type: "score", score: 0.5, confidence: 0.5, probabilities: { "0": 0.5, "1": 0.5 } } }, usage: { input_tokens: 1, output_tokens: 1 } };
    const d = makeDecider(hosted(), { fetch: async (_u, init: S1RequestInit) => { body = String(init.body); return { ok: true, status: 200, json: async () => choiceReply }; } });
    const r = await d({
      state: {},
      questions: {
        q1: { type: "choice", instructions: "pick one", criteria: { a: `opt ${SECRET}` } },
        q2: { type: "score", instructions: "rate", criteria: [`low ${SECRET}`, "high"] },
      },
    });
    expect(r.ok).toBe(true);
    expect(body).not.toContain(SECRET);
  });

  it("LOOPBACK local-kev is UNCHANGED: state and questions go as-is (nothing leaves)", async () => {
    let body = "";
    const d = makeDecider(loopback(), { fetch: async (_u, init: S1RequestInit) => { body = String(init.body); return { ok: true, status: 200, json: async () => replyFor(["q1"]) }; } });
    const r = await d({
      state: { conn: `x ${SECRET}` },
      questions: { q1: { type: "boolean", instructions: `safe? ${SECRET}` } },
    });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(body) as { state: { conn: string }; questions: { q1: { instructions: string } } };
    expect(parsed.state.conn).toBe(`x ${SECRET}`); // as-is
    expect(parsed.questions.q1.instructions).toBe(`safe? ${SECRET}`); // as-is
  });
});
