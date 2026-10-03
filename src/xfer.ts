/**
 * Receive side of the node-channel bundle transfer (issue #38).
 *
 * Each chunk is persisted as its own file, written atomically, so there is no
 * separate "append, then bump a counter" step that can be interrupted between
 * the two. The count of accepted chunks is derived from the files present, a
 * retry of an accepted chunk is a no-op (or a conflict error if the bytes
 * differ), and the payload is assembled in index order only when it is used.
 */

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writePrivate } from "./paths.js";

const CHUNK_RE = /^chunk-(\d{8})$/;

/** Base64 alphabet with optional trailing '=' padding; no whitespace. */
const B64_CHUNK_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64Chunk(data: unknown): data is string {
  return typeof data === "string" && B64_CHUNK_RE.test(data);
}

/** True when `b64` is canonical base64 (length multiple of 4, padding only at the end, exact round trip). */
export function isCanonicalBase64(b64: string): boolean {
  return b64.length % 4 === 0 && Buffer.from(b64, "base64").toString("base64") === b64;
}

const chunkFile = (dir: string, index: number) => join(dir, `chunk-${String(index).padStart(8, "0")}`);

/** Number of consecutive chunks (0..n-1) present in `dir`. */
export async function receivedCount(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const have = new Set(names.filter((n) => CHUNK_RE.test(n)).map((n) => parseInt(n.slice(6), 10)));
  let n = 0;
  while (have.has(n)) n++;
  return n;
}

async function totalChars(dir: string): Promise<number> {
  let total = 0;
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (CHUNK_RE.test(n)) total += (await stat(join(dir, n))).size;
  }
  return total;
}

export type AcceptResult = { ok: true; received: number } | { ok: false; error: string; received: number };

export async function acceptChunk(dir: string, index: number, data: unknown, maxTotalChars: number): Promise<AcceptResult> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const received = await receivedCount(dir);
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: `invalid chunk index: ${index}`, received };
  if (index > received) return { ok: false, error: `chunk out of order: expected ${received}, got ${index}`, received };
  if (!isBase64Chunk(data)) return { ok: false, error: "chunk is not base64", received };
  if (index < received) {
    // Retry of an accepted chunk: acknowledge only if it is byte-identical.
    const prior = await readFile(chunkFile(dir, index), "utf8");
    return prior === data
      ? { ok: true, received }
      : { ok: false, error: `chunk ${index} already received with different content`, received };
  }
  // A padded chunk can only be the last one: refuse anything after it.
  if (index > 0 && (await readFile(chunkFile(dir, index - 1), "utf8")).includes("=")) {
    return { ok: false, error: "chunk follows a padded (final) chunk", received };
  }
  if ((await totalChars(dir)) + data.length > maxTotalChars) {
    return { ok: false, error: "transfer exceeds size limit", received };
  }
  await writePrivate(chunkFile(dir, index), data);
  return { ok: true, received: received + 1 };
}

/** Concatenate the accepted chunks in index order. */
export async function assembleChunks(dir: string): Promise<string> {
  const n = await receivedCount(dir);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(await readFile(chunkFile(dir, i), "utf8"));
  return parts.join("");
}
