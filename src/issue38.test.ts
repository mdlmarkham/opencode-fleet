import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B64_MARKER, parseBundleOutput, parseStatusOutput, statusCommand } from "./outputs.js";
import { acceptChunk, assembleChunks, isBase64Chunk, isCanonicalBase64, receivedCount } from "./xfer.js";
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
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.uncommittedCount).toBe(3);
      expect(r.files.split("\n")).toHaveLength(3);
      expect(r.files).toContain("f0.txt");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("clean tree: count 0, no files", () => {
    const d = repo(0);
    try {
      expect(parseStatusOutput(sh(statusCommand(q(d))))).toEqual({ ok: true, files: "", uncommittedCount: 0 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("a file named like the marker does not confuse the parser", () => {
    const d = repo(0);
    try {
      writeFileSync(join(d, "---COUNT---"), "x");
      writeFileSync(join(d, "other.txt"), "x");
      const r = parseStatusOutput(sh(statusCommand(q(d))));
      expect(r).toMatchObject({ ok: true, uncommittedCount: 2 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("missing marker or a non-numeric count is a failure, not a clean tree", () => {
    expect(parseStatusOutput("?? a\n").ok).toBe(false);
    expect(parseStatusOutput("").ok).toBe(false);
    expect(parseStatusOutput("?? a\n---COUNT---\nnope\n").ok).toBe(false);
  });
});

describe("issue #38: __BUNDLE__ parsing against a real bundle", () => {
  it("splits head and base64 payload that decodes to the bundle", () => {
    const d = repo(0);
    try {
      const out = sh(`git bundle create ${q(join(d, "s.bundle"))} --all 2>/dev/null && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD && echo "${B64_MARKER}" && base64 ${q(join(d, "s.bundle"))}`, d);
      const r = parseBundleOutput(out);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.head).toBe(sh("git rev-parse HEAD", d).trim());
      expect(r.branch).toBe("main");
      expect(Buffer.from(r.base64, "base64").equals(readFileSync(join(d, "s.bundle")))).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("a detached HEAD leaves the branch unknown; a feature branch is reported", () => {
    expect(parseBundleOutput(`abc123\nHEAD\n${B64_MARKER}\nQUJD\n`)).toMatchObject({ ok: true, head: "abc123" });
    expect((parseBundleOutput(`abc123\nHEAD\n${B64_MARKER}\nQUJD\n`) as { branch?: string }).branch).toBeUndefined();
    expect(parseBundleOutput(`abc123\nfeature/x\n${B64_MARKER}\nQUJD\n`)).toMatchObject({ ok: true, branch: "feature/x" });
  });
  it("fails closed without a marker or with an empty payload", () => {
    expect(parseBundleOutput("fatal: not a git repository").ok).toBe(false);
    expect(parseBundleOutput(`abc\n${B64_MARKER}\n   \n`).ok).toBe(false);
  });
});

describe("issue #38: chunked transfer integrity (per-chunk files)", () => {
  const withDir = async <T>(fn: (dir: string) => Promise<T>) => {
    const d = mkdtempSync(join(tmpdir(), "fleet38x-"));
    try { return await fn(join(d, "xfer")); } finally { rmSync(d, { recursive: true, force: true }); }
  };
  it("accepts in order, treats an identical retry as a no-op, rejects gaps and conflicting retries", async () => {
    await withDir(async (dir) => {
      expect(await acceptChunk(dir, 0, "AAAA", 1e6)).toEqual({ ok: true, received: 1 });
      expect(await acceptChunk(dir, 0, "AAAA", 1e6)).toEqual({ ok: true, received: 1 });
      expect(await acceptChunk(dir, 0, "BBBB", 1e6)).toMatchObject({ ok: false, error: expect.stringMatching(/different content/) });
      expect(await acceptChunk(dir, 2, "CCCC", 1e6)).toMatchObject({ ok: false, error: expect.stringMatching(/out of order/) });
      expect(await acceptChunk(dir, 1, "BBBB", 1e6)).toEqual({ ok: true, received: 2 });
      expect(await receivedCount(dir)).toBe(2);
      expect(await assembleChunks(dir)).toBe("AAAABBBB");
    });
  });
  it("rejects bad indexes, non-base64, oversize, and anything after a padded final chunk", async () => {
    await withDir(async (dir) => {
      for (const bad of [-1, 1.5, NaN]) expect((await acceptChunk(dir, bad, "AAAA", 1e6)).ok).toBe(false);
      expect((await acceptChunk(dir, 0, "AA!A", 1e6)).ok).toBe(false);
      expect((await acceptChunk(dir, 0, "AAAA", 2)).ok).toBe(false);
      expect((await acceptChunk(dir, 0, "QQ==", 1e6)).ok).toBe(true);
      expect((await acceptChunk(dir, 1, "AAAA", 1e6)).ok).toBe(false);
    });
  });
  it("base64 grammar: stray '=', wrong length and non-canonical forms are not accepted", () => {
    for (const bad of ["=", "A", "AA=A", "A=A=", "AAAA\n", "AA A"]) {
      expect(isBase64Chunk(bad) && isCanonicalBase64(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["", "AAAA", "QQ==", "QUI=", "QUJD"]) expect(isBase64Chunk(good)).toBe(true);
    expect(isCanonicalBase64("QUJD")).toBe(true);
    expect(isCanonicalBase64("QQ==")).toBe(true);
    expect(isCanonicalBase64("QR==")).toBe(false); // non-zero trailing bits
  });
  it("a duplicated (retried) chunk reassembles the exact bytes, verified by sha256", async () => {
    await withDir(async (dir) => {
      const data = Buffer.alloc(300_000, 7);
      const chunks = chunkBuffer(data, 48 * 1024);
      for (let i = 0; i < chunks.length; i++) {
        expect((await acceptChunk(dir, chunks[i].index, chunks[i].data, 1e9)).ok).toBe(true);
        if (i === 2) expect((await acceptChunk(dir, chunks[i].index, chunks[i].data, 1e9)).ok).toBe(true);
      }
      const b64 = await assembleChunks(dir);
      expect(isCanonicalBase64(b64)).toBe(true);
      expect(createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    });
  });
  it("a crash between chunks leaves a consistent count (no separate counter to desync)", async () => {
    await withDir(async (dir) => {
      await acceptChunk(dir, 0, "AAAA", 1e6);
      await acceptChunk(dir, 1, "BBBB", 1e6);
      // The receiver is stateless: a fresh call derives the same count from disk.
      expect(await receivedCount(dir)).toBe(2);
      expect((await acceptChunk(dir, 1, "BBBB", 1e6)).ok).toBe(true);
      expect(await assembleChunks(dir)).toBe("AAAABBBB");
    });
  });
});
