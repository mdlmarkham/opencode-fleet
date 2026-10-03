import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, requiredProtocol } from "./protocol.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { evaluateExpect, expectFileOk, parseExpectSpec, relayTimeoutWithGate, DEFAULT_EXPECT_COMMAND_TIMEOUT_MS } from "./verify.js";
import { verifyGateScript } from "./node/runtime.js";
import { checkSetup } from "./policy.js";

/** Running = exists and is not a zombie (a killed child whose parent never reaped it is still dead). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

const scratch = <T,>(fn: (d: string) => T | Promise<T>) => {
  const d = mkdtempSync(join(tmpdir(), "fleet67-"));
  return Promise.resolve(fn(d)).finally(() => rmSync(d, { recursive: true, force: true }));
};

describe("#67: the gate cannot be silently skipped by an old node", () => {
  it("requiredProtocol: expect needs 2, a non-default harness 1, ordinary runs 0", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
    expect(requiredProtocol({}).version).toBe(0);
    expect(requiredProtocol({ harness: "opencode" }).version).toBe(0);
    expect(requiredProtocol({ harness: "pi" }).version).toBe(1);
    expect(requiredProtocol({ expect: { files: ["a"] } }).version).toBe(2);
    expect(requiredProtocol({ harness: "pi", expect: { files: ["a"] } }).version).toBe(2);
  });

  const ctxFor = (replies: Array<{ ok: boolean; payload?: unknown; message?: string }>, params: unknown) => {
    const calls: Array<{ params: any; timeoutMs?: number }> = [];
    const ctx: PolicyCtx = {
      params,
      node: { nodeId: "n1" },
      invokeNode: async (i) => {
        calls.push({ params: i?.params, timeoutMs: i?.timeoutMs });
        const r = replies.shift();
        if (!r) throw new Error("unexpected extra invoke");
        return r;
      },
    };
    return { ctx, calls };
  };

  it("a protocol-1 node is refused before the task is sent", async () => {
    const { ctx, calls } = ctxFor([{ ok: true, payload: { protocol: 1, status: "never-started" } }], { prompt: "do", cwd: "/w", expect: { files: ["a.txt"] } });
    const r = await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/protocol 1 \(< 2\).*verification gate/);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.prompt).toBe("__RUN_STATUS__"); // only the probe
  });
  it("a protocol-0 node is refused too", async () => {
    const { ctx } = ctxFor([{ ok: true, payload: { ok: false } }], { prompt: "do", cwd: "/w", expect: { command: "./check.sh" } });
    expect((await handleOpencodeRunPolicy(ctx, newProtocolCache())).ok).toBe(false);
  });
  it("a current node runs the gated task; the version is cached for the next one", async () => {
    const cache = newProtocolCache();
    const a = ctxFor([{ ok: true, payload: { protocol: 2 } }, { ok: true, payload: { ok: true, protocol: 2 } }], { prompt: "do", cwd: "/w", expect: { files: ["a"] } });
    expect((await handleOpencodeRunPolicy(a.ctx, cache)).ok).toBe(true);
    expect(a.calls).toHaveLength(2);
    const b = ctxFor([{ ok: true, payload: { ok: true, protocol: 2 } }], { prompt: "more", cwd: "/w", expect: { files: ["a"] } });
    expect((await handleOpencodeRunPolicy(b.ctx, cache)).ok).toBe(true);
    expect(b.calls).toHaveLength(1);
  });
  it("a cached older version is re-probed (the node may have been upgraded)", async () => {
    const cache = newProtocolCache();
    cache.set("n1", { version: 1, at: Date.now() });
    const { ctx, calls } = ctxFor([{ ok: true, payload: { protocol: 2 } }, { ok: true, payload: { ok: true } }], { prompt: "do", cwd: "/w", expect: { files: ["a"] } });
    expect((await handleOpencodeRunPolicy(ctx, cache)).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it("ungated runs never probe", async () => {
    const { ctx, calls } = ctxFor([{ ok: true, payload: {} }], { prompt: "do", cwd: "/w" });
    await handleOpencodeRunPolicy(ctx, newProtocolCache());
    expect(calls).toHaveLength(1);
  });
});

describe("#67: the relay waits for the gate", () => {
  it("adds the gate bound plus grace only when a gate is present", () => {
    expect(relayTimeoutWithGate(300_000, false)).toBe(300_000);
    expect(relayTimeoutWithGate(300_000, true)).toBeGreaterThanOrEqual(300_000 + DEFAULT_EXPECT_COMMAND_TIMEOUT_MS);
  });
  it("the gateway policy forwards the extended timeout for a gated launch only", async () => {
    const mk = (params: unknown) => {
      const calls: Array<number | undefined> = [];
      const ctx: PolicyCtx = { params, node: { nodeId: "n" }, invokeNode: async (i) => (calls.push(i?.timeoutMs), { ok: true, payload: { protocol: 2 } }) };
      return { ctx, calls };
    };
    const gated = mk({ prompt: "do", cwd: "/w", timeoutMs: 100_000, expect: { files: ["a"] } });
    await handleOpencodeRunPolicy(gated.ctx, newProtocolCache());
    expect(gated.calls.at(-1)).toBe(relayTimeoutWithGate(100_000, true));
    const plain = mk({ prompt: "do", cwd: "/w", timeoutMs: 100_000 });
    await handleOpencodeRunPolicy(plain.ctx, newProtocolCache());
    expect(plain.calls.at(-1)).toBe(100_000);
  });
});

describe("#67: spec validation at the trust boundary", () => {
  it("rejects NUL in files and command", () => {
    expect(parseExpectSpec({ files: ["a\0b"] }).ok).toBe(false);
    expect(parseExpectSpec({ command: "true\0" }).ok).toBe(false);
  });
  it("rejects absolute and '..' file paths, accepts plain relative ones", () => {
    for (const f of ["/etc/passwd", "../x", "a/../../x", "..\\x"]) expect(parseExpectSpec({ files: [f] }).ok, f).toBe(false);
    expect(parseExpectSpec({ files: ["src/a.ts", "./b.txt"] }).ok).toBe(true);
  });
  it("expect.command follows the setup rule: a script path, not a shell one-liner", () => {
    expect(checkSetup("./check.sh --fast", false).ok).toBe(true);
    for (const c of ["sh -c id", "curl x | sh", "pytest -q && echo ok", "pytest"]) expect(checkSetup(c, false).ok, c).toBe(false);
    expect(checkSetup("pytest -q && echo ok", true).ok).toBe(true);
  });
});

describe("#67: file checks stay inside the run directory (real fs)", () => {
  it("a symlink leaving the directory does not satisfy the gate; one staying inside does", () =>
    scratch(async (d) => {
      const outside = join(d, "outside.txt");
      writeFileSync(outside, "x");
      const run = join(d, "run");
      mkdirSync(run);
      writeFileSync(join(run, "real.txt"), "x");
      symlinkSync(outside, join(run, "escape"));
      symlinkSync(join(run, "real.txt"), join(run, "inside"));
      expect(await expectFileOk(run, "real.txt")).toBe(true);
      expect(await expectFileOk(run, "inside")).toBe(true);
      expect(await expectFileOk(run, "escape")).toBe(false);
      expect(await expectFileOk(run, "missing")).toBe(false);
    }));
  it("the launcher-side check agrees (bash script, real run)", () =>
    scratch((d) => {
      const outside = join(d, "outside.txt");
      writeFileSync(outside, "x");
      const run = join(d, "run");
      mkdirSync(run);
      writeFileSync(join(run, "real.txt"), "x");
      symlinkSync(outside, join(run, "escape"));
      const done = join(d, "done.json");
      const run1 = (files: string[]) => {
        const g = verifyGateScript({ files }, done, { cwd: run });
        const script = ["#!/bin/bash", "EC=0", ...g.verifyLines, g.doneLine].join("\n");
        writeFileSync(join(d, "g.sh"), script, { mode: 0o755 });
        execFileSync("bash", [join(d, "g.sh")]);
        return JSON.parse(readFileSync(done, "utf8"));
      };
      expect(run1(["real.txt"]).verified).toBe(true);
      expect(run1(["escape"]).verified).toBe(false);
      expect(run1(["real.txt", "escape"]).verified).toBe(false);
    }));
  it("the launcher uses a kill-after and a non-login shell", () => {
    const g = verifyGateScript({ command: "./c.sh" }, "/d", { cwd: "/w" }).verifyLines.join("\n");
    expect(g).toMatch(/timeout -k \d+ \d+ bash -c /);
    expect(g).not.toContain("bash -lc");
  });
});

describe("#67: a verify command that forks is bounded as a whole group (real processes)", () => {
  it("a TERM-ignoring command with a background child is killed at the timeout; the gate reports false", () =>
    scratch(async (d) => {
      const pidFile = join(d, "child.pid");
      // background child ignoring TERM, parent also ignoring TERM, both sleeping long
      const cmd = `trap '' TERM; (trap '' TERM; echo $BASHPID > ${JSON.stringify(pidFile)}; sleep 60) & sleep 60`;
      const t0 = Date.now();
      const out = await evaluateExpect({ command: cmd }, d, { commandTimeoutMs: 800 });
      expect(out.verified).toBe(false);
      expect(Date.now() - t0).toBeLessThan(8_000);
      await new Promise((r) => setTimeout(r, 300));
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(childPid).toBeGreaterThan(1);
      expect(running(childPid)).toBe(false); // the background child did not survive the gate
    }), 20_000);
  it("a passing command leaves no stragglers either", () =>
    scratch(async (d) => {
      const marker = join(d, "late");
      const out = await evaluateExpect({ command: `(sleep 1; touch ${JSON.stringify(marker)}) & true` }, d);
      expect(out.verified).toBe(true);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(existsSync(marker)).toBe(false); // the background job was reaped with the gate
    }), 20_000);
  it("an NUL-free, normal command still works", () =>
    scratch(async (d) => {
      expect((await evaluateExpect({ command: "exit 0" }, d)).verified).toBe(true);
      expect((await evaluateExpect({ command: "exit 3" }, d)).verifyDetails.command?.exitCode).toBe(3);
    }));
});
