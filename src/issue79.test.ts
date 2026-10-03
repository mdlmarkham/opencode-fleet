import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  combineWithStatic, isLoopbackUrl, makeDecider, needsEgress, parseS1Config, recordOverride, redactDeep,
  type AuditEntry, type S1Config,
} from "./decision-backends.js";
import type { DecideInput, S1Fetch, S1RequestInit } from "./decision.js";

const cfg = (over: Record<string, unknown> = {}): S1Config => {
  const r = parseS1Config(over);
  if (!r.ok) throw new Error(r.error);
  return r.config;
};
const Q: DecideInput = { state: { command: "rm -rf node_modules" }, questions: { risk: { type: "boolean", instructions: "Should this be blocked?" } } };
const reply = (p: number, model = "kev-1") => ({ model, answers: { risk: { type: "noul", noul: p } }, usage: { input_tokens: 3, output_tokens: 1 } });
function fetchOf(payload: unknown, seen?: { url?: string; init?: S1RequestInit }, status = 200): S1Fetch {
  return async (url, init) => {
    if (seen) { seen.url = url; seen.init = init; }
    return { ok: status < 300, status, json: async () => payload };
  };
}

describe("#79: config", () => {
  it("defaults are the safe ones: local-kev, shadow, nothing enabled", () => {
    const c = cfg(undefined);
    expect(c).toMatchObject({ backend: "local-kev", mode: "shadow", thresholds: {}, backends: {} });
  });
  it("validates every field", () => {
    for (const bad of [
      "x", { backend: "gpt" }, { mode: "on" }, { timeoutMs: 5 }, { timeoutMs: 999999 }, { thresholds: { risk: 2 } }, { thresholds: { risk: "a" } },
      { calibration: {} }, { calibration: { model: "" } }, { backends: { nope: {} } }, { backends: { "zen-jev": { url: "ftp://x" } } },
      { backends: { "zen-jev": { allowEgress: "yes" } } }, { backends: { "zen-jev": { apiKey: "" } } },
    ]) expect(parseS1Config(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parseS1Config({ backend: "zen-jev", mode: "enforce", thresholds: { risk: 0.8 }, backends: { "zen-jev": { url: "https://s1.example.net", allowEgress: true } } }).ok).toBe(true);
  });
  it("the manifest declares the s1 config", () => {
    const m = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(m.configSchema.properties.s1.properties.mode.default).toBe("shadow");
    expect(m.configSchema.properties.s1.properties.backends.additionalProperties.properties.allowEgress.default).toBe(false);
  });
});

describe("#79: egress", () => {
  it("loopback detection", () => {
    for (const u of ["http://127.0.0.1:8009", "http://localhost:1", "http://[::1]:9", "http://127.5.5.5"]) expect(isLoopbackUrl(u), u).toBe(true);
    for (const u of ["http://10.0.0.5", "https://s1.example.net", "http://127.0.0.1.evil.net", "nonsense"]) expect(isLoopbackUrl(u), u).toBe(false);
  });
  it("hosted backends always need opt-in; local-kev only when pointed off-machine", () => {
    expect(needsEgress("local-kev", "http://127.0.0.1:8009")).toBe(false);
    expect(needsEgress("local-kev", "http://10.0.0.5:8009")).toBe(true);
    expect(needsEgress("zen-jev", "http://127.0.0.1:1")).toBe(true);
  });
  it("without allowEgress a hosted backend is refused BEFORE any request is made", async () => {
    let called = false;
    const d = makeDecider(cfg({ backend: "zen-jev", backends: { "zen-jev": { url: "https://s1.example.net" } } }), { fetch: async () => { called = true; return { ok: true, status: 200, json: async () => reply(1) }; } });
    const r = await d(Q);
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/allowEgress/);
  });
  it("with allowEgress it is called, secrets are redacted from what is sent, and the key goes in a header only", async () => {
    const seen: { url?: string; init?: S1RequestInit } = {};
    const d = makeDecider(cfg({ backend: "zen-jev", backends: { "zen-jev": { url: "https://s1.example.net", allowEgress: true, apiKey: "sekrit-key", model: "jev-1" } } }), { fetch: fetchOf(reply(0.9, "jev-1"), seen) });
    const r = await d({ ...Q, state: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://x", nested: { token: "ghp_" + "A".repeat(36) } } });
    expect(r.ok).toBe(true);
    expect(seen.url).toBe("https://s1.example.net/v1/systemone");
    expect(seen.init?.headers.authorization).toBe("Bearer sekrit-key");
    expect(seen.init?.body).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(seen.init?.body).not.toContain("ghp_AAAA");
    expect(seen.init?.body).not.toContain("sekrit-key");
    expect(JSON.parse(seen.init!.body).model).toBe("jev-1");
  });
  it("local-kev on loopback sends the state as-is (nothing leaves) and needs no opt-in", async () => {
    const seen: { url?: string; init?: S1RequestInit } = {};
    const d = makeDecider(cfg({}), { fetch: fetchOf(reply(0.2), seen) });
    expect((await d(Q)).ok).toBe(true);
    expect(seen.url).toBe("http://127.0.0.1:8009/v1/systemone");
    expect(JSON.parse(seen.init!.body).state).toEqual(Q.state);
  });
  it("redactDeep reaches nested strings and arrays and leaves other values alone", () => {
    const out = redactDeep({ a: ["x", { b: "ghp_" + "B".repeat(36) }], n: 5, ok: true }) as { a: [string, { b: string }]; n: number };
    expect(out.a[1].b).not.toContain("BBBB");
    expect(out.n).toBe(5);
  });
});

describe("#79: every failure mode leaves the STATIC verdict in force, never allow-by-silence", () => {
  const enforce = cfg({ mode: "enforce", thresholds: { risk: 0.5 } });
  const allow = { action: "allow" as const };
  const failures: Array<[string, () => Promise<ReturnType<typeof makeDecider> extends (...a: never[]) => infer R ? Awaited<R> : never>]> = [
    ["layer off", () => makeDecider(cfg({ mode: "off" }), { fetch: fetchOf(reply(1)) })(Q)],
    ["backend down (throws)", () => makeDecider(enforce, { fetch: async () => { throw new Error("ECONNREFUSED"); } })(Q)],
    ["HTTP 500", () => makeDecider(enforce, { fetch: fetchOf({}, undefined, 500) })(Q)],
    ["malformed reply", () => makeDecider(enforce, { fetch: fetchOf({ model: "m", answers: { risk: { type: "essay" } }, usage: { input_tokens: 1, output_tokens: 1 } }) })(Q)],
    ["not JSON object", () => makeDecider(enforce, { fetch: fetchOf("nope") })(Q)],
  ];
  for (const [name, run] of failures) {
    it(`${name}: no decision, static allow stays allow, static block stays block`, async () => {
      const d = await run();
      expect(d.ok).toBe(false);
      expect(combineWithStatic(allow, d, "risk", enforce)).toMatchObject({ action: "allow", source: "static" });
      expect(combineWithStatic({ action: "block", reason: "deny-list" }, d, "risk", enforce)).toMatchObject({ action: "block", source: "static", reason: "deny-list" });
    });
  }
  it("a timeout is a failure too, not a hang", async () => {
    const hang: S1Fetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const d = await makeDecider({ ...enforce, timeoutMs: 100 }, { fetch: hang })(Q);
    expect(d.ok).toBe(false);
    expect(combineWithStatic(allow, d, "risk", enforce).action).toBe("allow");
  });
});

describe("#79: combining with the static rules", () => {
  const enforce = cfg({ mode: "enforce", thresholds: { risk: 0.5 } });
  const shadow = cfg({ mode: "shadow", thresholds: { risk: 0.5 } });
  const ask = (c: S1Config, p: number, model?: string) => makeDecider(c, { fetch: fetchOf(reply(p, model)) })(Q);

  it("S1 can never lift a static block, however low it scores", async () => {
    expect(combineWithStatic({ action: "block" }, await ask(enforce, 0), "risk", enforce).action).toBe("block");
  });
  it("enforce: at/above the threshold adds a block; below it allows", async () => {
    expect(combineWithStatic({ action: "allow" }, await ask(enforce, 0.5), "risk", enforce)).toMatchObject({ action: "block", source: "s1" });
    expect(combineWithStatic({ action: "allow" }, await ask(enforce, 0.49), "risk", enforce)).toMatchObject({ action: "allow" });
  });
  it("shadow: never acts, but records what it would have done", async () => {
    const o = combineWithStatic({ action: "allow" }, await ask(shadow, 0.99), "risk", shadow);
    expect(o).toMatchObject({ action: "allow", source: "static", shadow: { wouldBlock: true, probability: 0.99, threshold: 0.5 } });
  });
  it("no calibrated threshold for the question: S1 is not acted on", async () => {
    const noTh = cfg({ mode: "enforce" });
    expect(combineWithStatic({ action: "allow" }, await ask(noTh, 1), "risk", noTh).action).toBe("allow");
  });
  it("a model that differs from the calibrated one downgrades enforce to shadow, with a warning", async () => {
    const c = cfg({ mode: "enforce", thresholds: { risk: 0.5 }, calibration: { model: "kev-1" } });
    const same = await ask(c, 0.9, "kev-1");
    expect(same.meta.effectiveMode).toBe("enforce");
    const other = await ask(c, 0.9, "kev-2");
    expect(other.meta.effectiveMode).toBe("shadow");
    expect(other.meta.warnings.join()).toMatch(/re-run the #78 calibration/);
    expect(combineWithStatic({ action: "allow" }, other, "risk", c)).toMatchObject({ action: "allow", shadow: { wouldBlock: true } });
  });
  it("a non-boolean answer is not acted on", async () => {
    const d = await makeDecider(enforce, { fetch: fetchOf({ model: "m", answers: { risk: { type: "choice", choice: "x" } }, usage: { input_tokens: 1, output_tokens: 1 } }) })({ state: {}, questions: { risk: { type: "choice", instructions: "i", criteria: { x: "x" } } } });
    expect(combineWithStatic({ action: "allow" }, d, "risk", enforce).action).toBe("allow");
  });
});

describe("#79: audit", () => {
  it("logs backend, model, mode, latency, usage and question ids for every call, success or failure, and never the state or key", async () => {
    const log: AuditEntry[] = [];
    let t = 1000;
    const now = () => (t += 40);
    const ok = makeDecider(cfg({ backends: { "local-kev": { apiKey: "sekrit" } } }), { fetch: fetchOf(reply(0.3)), sink: (e) => void log.push(e), now });
    await ok(Q);
    await makeDecider(cfg({ mode: "off" }), { sink: (e) => void log.push(e), now })(Q);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: "decision", backend: "local-kev", model: "kev-1", mode: "shadow", ok: true, questionIds: ["risk"], usage: { input_tokens: 3, output_tokens: 1 } });
    expect((log[0] as { latencyMs: number }).latencyMs).toBeGreaterThan(0);
    expect(log[1]).toMatchObject({ ok: false, mode: "off" });
    expect(JSON.stringify(log)).not.toContain("rm -rf");
    expect(JSON.stringify(log)).not.toContain("sekrit");
  });
  it("a throwing audit sink does not change the decision", async () => {
    const d = await makeDecider(cfg({}), { fetch: fetchOf(reply(0.3)), sink: () => { throw new Error("disk full"); } })(Q);
    expect(d.ok).toBe(true);
  });
  it("an override is recorded, never silent", async () => {
    const log: AuditEntry[] = [];
    const e = await recordOverride((x) => void log.push(x), { runId: "r1", subject: "git push origin fix/x", by: "operator", reason: "false block" }, () => new Date("2026-01-01T00:00:00Z"));
    expect(e).toMatchObject({ kind: "override", ts: "2026-01-01T00:00:00.000Z", runId: "r1" });
    expect(log).toEqual([e]);
  });
});
