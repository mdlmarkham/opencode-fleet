/**
 * Parsers for the node shell outputs that carry data after a marker line
 * (issue #38). They were previously inlined and split on a JS string containing
 * a literal backslash-n ("---COUNT\\n"), which never matches the real newline,
 * so `__STATUS__` always reported 0 uncommitted files. Pure functions so they
 * can be tested against real command output.
 */

export const COUNT_MARKER = "---COUNT---";
export const B64_MARKER = "---B64---";

/** Command run on the node for `__STATUS__`; parsed by `parseStatusOutput`. */
export function statusCommand(quotedCwd: string): string {
  return (
    `cd ${quotedCwd} && git status --porcelain 2>/dev/null | head -50; ` +
    `echo "${COUNT_MARKER}"; git status --porcelain 2>/dev/null | wc -l`
  );
}

export interface StatusResult {
  files: string;
  uncommittedCount: number;
}

export function parseStatusOutput(out: string): StatusResult {
  const i = out.indexOf(COUNT_MARKER);
  if (i < 0) return { files: out.trim(), uncommittedCount: 0 };
  const files = out.slice(0, i).trim();
  const n = parseInt(out.slice(i + COUNT_MARKER.length).trim(), 10);
  return { files, uncommittedCount: Number.isFinite(n) ? n : 0 };
}

export type BundleParse = { ok: true; head: string; base64: string } | { ok: false; error: string };

/**
 * Split `__BUNDLE__` output into the metadata before the marker (last line is
 * the HEAD sha) and the base64 payload after it. Fails closed on a missing
 * marker or an empty payload.
 */
export function parseBundleOutput(out: string): BundleParse {
  const i = out.indexOf(B64_MARKER);
  if (i < 0) return { ok: false, error: `bundle failed: ${out.slice(0, 300)}` };
  const meta = out.slice(0, i);
  const base64 = out.slice(i + B64_MARKER.length).replace(/\s+/g, "");
  if (!base64) return { ok: false, error: `bundle failed: ${meta.slice(0, 300) || "empty bundle"}` };
  const lines = meta.trim().split("\n");
  const head = (lines[lines.length - 1] ?? "").trim().slice(-40);
  return { ok: true, head, base64 };
}

export type ChunkAction = { action: "append" } | { action: "skip" } | { action: "error"; error: string };

/**
 * Decide what to do with an incoming transfer chunk given how many have been
 * accepted so far. A retried invoke (index already accepted) is acknowledged
 * without appending again; a gap is an error.
 */
export function nextChunkAction(received: number, index: number): ChunkAction {
  if (!Number.isInteger(index) || index < 0) return { action: "error", error: `invalid chunk index: ${index}` };
  if (index < received) return { action: "skip" };
  if (index > received) return { action: "error", error: `chunk out of order: expected ${received}, got ${index}` };
  return { action: "append" };
}

/** Maximum base64 characters accepted for a single transferred bundle (~256 MiB decoded). */
export const MAX_TRANSFER_B64 = 350 * 1024 * 1024;
