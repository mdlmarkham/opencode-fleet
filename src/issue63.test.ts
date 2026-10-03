import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleOpencodeRun } from "./node/handler.js";

describe("#63: abort never kills by name pattern", () => {
  it("node abort without a runId refuses, and does not signal anything", async () => {
    const r = JSON.parse(await handleOpencodeRun(JSON.stringify({ prompt: "__ABORT__", op: "abort", cwd: "/", sessionId: "s1" })));
    expect(r).toMatchObject({ ok: false, aborted: false, sessionId: "s1" });
    expect(r.error).toMatch(/runId/);
  });

  it("the node handler no longer contains a pattern pkill/pgrep fallback", () => {
    const src = readFileSync(new URL("./node/handler.ts", import.meta.url), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/pkill -f/);
    expect(src).not.toMatch(/pgrep -f/);
  });

  it("fleet_abort resolves a sessionId through the ledger and requires some runId", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const at = src.indexOf('name: "fleet_abort"');
    const body = src.slice(at, at + 3500);
    expect(body).toContain("loadLedger");
    expect(body).toContain("runId required");
  });
});
