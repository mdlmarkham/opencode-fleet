import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B64_MARKER, nextChunkAction, parseBundleOutput, parseStatusOutput, statusCommand } from "./outputs.js";
import { chunkBuffer } from "./ledger.js";

const sh = (cmd: string, cwd?: string) => execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function repo(dirty: number) {
  const d = mkdtempSync(join(tmpdir(), "fleet38-"));
  sh("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i", d);
  for (let i = 0; i < dirty; i++) writeFileSync(join(d, `f${i}.txt`), "x");
  return d;
}

describe("issue #38: __STATUS__ parsing against real command output", () => {
  it("reports the real uncommitted count (was always 0)", () => {
    const d = repo(3);
    try {
      const r = parseStatusOutput(sh(statusCommand(q(d))));
      expect(r.uncommittedCount).toBe(3);
      expect(r.files.split("\n")).toHaveLength(3);
      expect(r.files).toContain("f0.txt");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("clean tree: count 0, no files", () => {
    const d = repo(0);
    try {
      expect(parseStatusOutput(sh(statusCommand(q(d))))).toEqual({ files: "", uncommittedCount: 0 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("missing marker or garbage count falls back safely", () => {
    expect(parseStatusOutput("?? a\n")).toEqual({ files: "?? a", uncommittedCount: 0 });
    expect(parseStatusOutput("?? a\n---COUNT---\nnope\n").uncommittedCount).toBe(0);
  });
});

describe("issue #38: __BUNDLE__ parsing against a real bundle", () => {
  it("splits head and base64 payload that decodes to the bundle", () => {
    const d = repo(0);
    try {
      const out = sh(`git bundle create ${q(join(d, "s.bundle"))} --all 2>/dev/null && git rev-parse HEAD && echo "${B64_MARKER}" && base64 ${q(join(d, "s.bundle"))}`, d);
      const r = parseBundleOutput(out);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.head).toBe(sh("git rev-parse HEAD", d).trim());
      expect(Buffer.from(r.base64, "base64").equals(readFileSync(join(d, "s.bundle")))).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("fails closed without a marker or with an empty payload", () => {
    expect(parseBundleOutput("fatal: not a git repository").ok).toBe(false);
    expect(parseBundleOutput(`abc\n${B64_MARKER}\n   \n`).ok).toBe(false);
  });
});

describe("issue #38: chunked transfer integrity", () => {
  it("accepts in-order, skips retries of accepted chunks, rejects gaps and bad indexes", () => {
    expect(nextChunkAction(0, 0)).toEqual({ action: "append" });
    expect(nextChunkAction(3, 3)).toEqual({ action: "append" });
    expect(nextChunkAction(3, 2)).toEqual({ action: "skip" });
    expect(nextChunkAction(3, 5)).toMatchObject({ action: "error" });
    for (const bad of [-1, 1.5, NaN]) expect(nextChunkAction(0, bad)).toMatchObject({ action: "error" });
  });
  it("simulated receiver with a duplicated (retried) chunk reassembles the exact bytes", () => {
    const data = Buffer.alloc(300_000, 7);
    const chunks = chunkBuffer(data, 48 * 1024);
    let received = 0;
    let acc = "";
    const send = (i: number) => {
      const act = nextChunkAction(received, chunks[i].index);
      if (act.action === "append") { acc += chunks[i].data; received++; }
    };
    chunks.forEach((_, i) => { send(i); if (i === 2) send(i); }); // chunk 2 delivered twice
    expect(createHash("sha256").update(Buffer.from(acc, "base64")).digest("hex"))
      .toBe(createHash("sha256").update(data).digest("hex"));
  });
});
