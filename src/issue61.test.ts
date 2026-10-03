import { describe, expect, it } from "vitest";
import { handleOpencodeRun } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { PROTOCOL_VERSION, resolveOp } from "./protocol.js";

/** A node of protocol `pv` applying the #61 rule to whatever the gateway forwards. */
function oldNode(pv: number) {
  const seen: Array<Record<string, unknown>> = [];
  const invoke = async (a: { params: Record<string, unknown> }) => {
    seen.push(a.params);
    const need = a.params.protocol;
    if (typeof need === "number" && need > pv) {
      return { ok: true as const, payload: { ok: false, error: `request needs protocol ${need}, newer than this node's protocol ${pv}`, protocol: pv } };
    }
    return { ok: true as const, payload: { ok: true, ...(pv > 0 ? { protocol: pv } : {}) } };
  };
  const ctx = (params: Record<string, unknown>): PolicyCtx => ({ params, node: { nodeId: "n1" }, invokeNode: invoke } as unknown as PolicyCtx);
  return { seen, ctx };
}

describe("#61: the node refuses what it cannot honor", () => {
  it("accepts an absent protocol and any protocol up to its own", () => {
    for (const protocol of [undefined, 0, 1, PROTOCOL_VERSION]) {
      expect(resolveOp({ prompt: "__MODELS__", protocol }).ok, String(protocol)).toBe(true);
    }
  });
  it("refuses a newer protocol, naming both versions", () => {
    const r = resolveOp({ prompt: "__MODELS__", op: "models", protocol: PROTOCOL_VERSION + 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(new RegExp(`protocol ${PROTOCOL_VERSION + 1}.*${PROTOCOL_VERSION}`));
  });
  it("refuses a present non-numeric value, including null", () => {
    for (const bad of [null, "2", -1, 1.5, NaN, {}, true]) {
      expect(resolveOp({ prompt: "__MODELS__", protocol: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the node handler refuses it end to end and stamps its own protocol", async () => {
    const out = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__MODELS__", op: "models", cwd: "/", protocol: PROTOCOL_VERSION + 1 })));
    expect(out).toMatchObject({ ok: false, protocol: PROTOCOL_VERSION });
    expect(out.error).toMatch(/newer than this node/);
  });
});

describe("#61: a current gateway still works against older nodes (the regression the first attempt had)", () => {
  for (const pv of [0, 1]) {
    it(`a plain run on a protocol-${pv} node is served: the gateway sends no protocol`, async () => {
      const n = oldNode(pv);
      const r = await handleOpencodeRunPolicy(n.ctx({ prompt: "do work", cwd: "/w" }), newProtocolCache());
      expect(r.ok).toBe(true);
      expect((r as { payload: { ok: boolean } }).payload.ok).toBe(true);
      expect("protocol" in n.seen[0]).toBe(false);
    });
    it(`the discovery probe carries no protocol, so a protocol-${pv} node answers it and is learned as old`, async () => {
      const n = oldNode(pv);
      const cache = newProtocolCache();
      const r = await handleOpencodeRunPolicy(n.ctx({ prompt: "do work", cwd: "/w", expect: { files: ["a"] } }), cache);
      expect(n.seen[0]).toMatchObject({ prompt: "__RUN_STATUS__", op: "run.status" });
      expect("protocol" in n.seen[0]).toBe(false);
      expect(r.ok).toBe(false); // refused by the gateway for the right reason, not by a poisoned probe
      expect((r as { message: string }).message).toMatch(new RegExp(`protocol ${pv}`));
      expect(n.seen).toHaveLength(1); // the task itself was never sent
    });
  }
  it("a caller cannot smuggle its own protocol through the gateway", async () => {
    const n = oldNode(1);
    await handleOpencodeRunPolicy(n.ctx({ prompt: "do work", cwd: "/w", protocol: 99 }), newProtocolCache());
    expect("protocol" in n.seen[0]).toBe(false);
  });
  it("a feature that needs a protocol stamps exactly that minimum, after discovery", async () => {
    const n = oldNode(PROTOCOL_VERSION);
    const r = await handleOpencodeRunPolicy(n.ctx({ prompt: "do work", cwd: "/w", harness: "pi" }), newProtocolCache());
    expect(r.ok).toBe(true);
    expect("protocol" in n.seen[0]).toBe(false); // probe
    expect(n.seen[1]).toMatchObject({ harness: "pi", protocol: 1 }); // pi needs 1, not the gateway's max
  });
});
