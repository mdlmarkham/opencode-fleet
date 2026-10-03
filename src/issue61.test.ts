import { describe, expect, it } from "vitest";
import { handleOpencodeRun } from "./node/handler.js";
import { PROTOCOL_VERSION, resolveOp } from "./protocol.js";

describe("#61: a node rejects a protocol newer than it implements", () => {
  it("resolveOp accepts the current and older protocols and an absent one", () => {
    for (const protocol of [undefined, null, 0, 1, PROTOCOL_VERSION]) {
      expect(resolveOp({ prompt: "__MODELS__", protocol }).ok, String(protocol)).toBe(true);
    }
  });
  it("refuses a newer protocol, naming both versions", () => {
    const r = resolveOp({ prompt: "__MODELS__", op: "models", protocol: PROTOCOL_VERSION + 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(new RegExp(`protocol ${PROTOCOL_VERSION + 1}.*${PROTOCOL_VERSION}`));
  });
  it("refuses garbage protocol values", () => {
    for (const bad of ["2", -1, 1.5, NaN, {}, true]) {
      expect(resolveOp({ prompt: "__MODELS__", protocol: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the node handler refuses it end to end, before running anything, and stamps its own protocol", async () => {
    const out = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__MODELS__", op: "models", cwd: "/", protocol: PROTOCOL_VERSION + 1 })));
    expect(out).toMatchObject({ ok: false, protocol: PROTOCOL_VERSION });
    expect(out.error).toMatch(/newer than this node/);
  });
});
