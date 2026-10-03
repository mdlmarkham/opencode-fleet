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

export type StatusResult =
  | { ok: true; files: string; uncommittedCount: number }
  | { ok: false; error: string };

/**
 * Parse `statusCommand` output. The separator is the LAST marker line (a
 * tracked file may itself be named like the marker); a missing marker or a
 * non-numeric count is a failure, never "clean".
 */
export function parseStatusOutput(out: string): StatusResult {
  const i = out.lastIndexOf(COUNT_MARKER);
  if (i < 0) return { ok: false, error: `status failed: ${out.trim().slice(0, 200) || "no output"}` };
  const tail = out.slice(i + COUNT_MARKER.length).trim();
  if (!/^\d+$/.test(tail)) return { ok: false, error: `status failed: unexpected count ${JSON.stringify(tail.slice(0, 40))}` };
  return { ok: true, files: out.slice(0, i).trim(), uncommittedCount: parseInt(tail, 10) };
}

export type BundleParse = { ok: true; head: string; branch?: string; base64: string } | { ok: false; error: string };

/**
 * Split `__BUNDLE__` output into the metadata before the marker (second-last
 * line the HEAD sha, last line the checked-out branch, `HEAD` when detached)
 * and the base64 payload after it. Fails closed on a missing
 * marker or an empty payload.
 */
export function parseBundleOutput(out: string): BundleParse {
  const i = out.indexOf(B64_MARKER);
  if (i < 0) return { ok: false, error: `bundle failed: ${out.slice(0, 300)}` };
  const meta = out.slice(0, i);
  const base64 = out.slice(i + B64_MARKER.length).replace(/\s+/g, "");
  if (!base64) return { ok: false, error: `bundle failed: ${meta.slice(0, 300) || "empty bundle"}` };
  const lines = meta.trim().split("\n");
  const branchLine = (lines[lines.length - 1] ?? "").trim();
  const head = (lines[lines.length - 2] ?? "").trim().slice(-40);
  // A detached HEAD reports "HEAD"; leave the branch unknown rather than guess.
  const branch = branchLine && branchLine !== "HEAD" ? branchLine : undefined;
  return { ok: true, head, ...(branch ? { branch } : {}), base64 };
}

/** Maximum base64 characters accepted for a single transferred bundle (~256 MiB decoded). */
export const MAX_TRANSFER_B64 = 350 * 1024 * 1024;
