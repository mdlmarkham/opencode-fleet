import { describe, expect, it } from "vitest";
import { makeDecider, parseS1Config, type S1Config } from "./decision-backends.js";
import type { DecideInput, S1Fetch, S1RequestInit } from "./decision.js";

const cfg = (over: Record<string, unknown>): S1Config => {
  const r = parseS1Config(over);
  if (!r.ok) throw new Error(r.error);
  return r.config;
};
// Assembled at runtime so no secret-shaped literal sits in the source.
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const BEARER = "Bearer " + "abcdef0123456789abcdef0123456789";
const DB = "postgres://admin:" + "hunter2pass" + "@db.internal:5432/app";

const input: DecideInput = {
  state: { note: `token ${GH}` },
  questions: {
    b: { type: "boolean", instructions: `Spec: use ${GH}`, criteria: { hint: BEARER } },
    c: { type: "choice", instructions: `Connect with ${DB}`, criteria: { optA: `uses ${GH}`, optB: "plain" } },
    s: { type: "score", instructions: `auth ${BEARER}`, criteria: [`low ${DB}`, "high"] },
  },
};
const run = async (config: S1Config) => {
  let body = "";
  const fetch: S1Fetch = async (_u: string, init: S1RequestInit) => {
    body = String(init.body);
    return { ok: true, status: 200, json: async () => ({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  await makeDecider(config, { fetch })(input);
  return body;
};

describe("#101: egress redacts every string a request carries", () => {
  it("hosted backend: no secret reaches the wire, ids stay", async () => {
    const body = await run(cfg({ backend: "zen-jev", backends: { "zen-jev": { url: "https://s1.example.net", allowEgress: true } } }));
    for (const s of [GH, BEARER, "hunter2pass"]) expect(body).not.toContain(s);
    for (const id of ["optA", "optB", "\"b\"", "\"c\"", "\"s\""]) expect(body).toContain(id);
  });
  it("loopback local-kev sends as-is", async () => {
    const body = await run(cfg({}));
    expect(body).toContain(GH);
    expect(body).toContain("hunter2pass");
  });
});
