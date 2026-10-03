/**
 * Issue #65 slice 2: file scope for a task spec.
 *
 * `scope.files` is a list of repo-relative paths or globs (`*`, `**`, `?`) the
 * task is expected to stay within. Advisory: the node reports which changed
 * files fell outside it (`scopeViolations`), and the scheduler (#46) can use
 * `scopeOverlap` as a conflict key. A directory is written `dir/` (everything
 * below it). Pure and dependency-light so both gateway and node can use it.
 */

import { globToRegex } from "./syncpolicy.js";

export const MAX_SCOPE_PATTERNS = 100;
export const MAX_SCOPE_PATTERN_LENGTH = 200;

export interface TaskScope {
  files: string[];
}

export type ScopeResult = { ok: true; scope?: TaskScope } | { ok: false; error: string };

/** Validate an untrusted scope. Absent/null = no scope. Present means well-formed or refused. */
export function parseScope(value: unknown): ScopeResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "scope must be an object {files: string[]}" };
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: "scope.files must be a non-empty array of path patterns" };
  if (files.length > MAX_SCOPE_PATTERNS) return { ok: false, error: `scope.files has more than ${MAX_SCOPE_PATTERNS} patterns` };
  for (const f of files) {
    if (typeof f !== "string" || f.length === 0 || f.length > MAX_SCOPE_PATTERN_LENGTH) {
      return { ok: false, error: `scope.files entries must be non-empty strings of at most ${MAX_SCOPE_PATTERN_LENGTH} characters` };
    }
    if (f.includes("\0") || f.includes("\n")) return { ok: false, error: "scope.files entries must not contain control characters" };
    if (f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f) || f.includes("\\")) {
      return { ok: false, error: `scope.files entry must be a repo-relative path: ${JSON.stringify(f.slice(0, 60))}` };
    }
    if (f.split("/").includes("..")) return { ok: false, error: `scope.files entry must not contain "..": ${JSON.stringify(f.slice(0, 60))}` };
  }
  return { ok: true, scope: { files: files.slice() as string[] } };
}

const normalize = (p: string) => p.replace(/^\.\//, "");

/** `dir/` means everything below `dir`. */
function toRegex(pattern: string): RegExp {
  const p = normalize(pattern);
  return globToRegex(p.endsWith("/") ? `${p}**` : p);
}

/** Changed files that fall outside every pattern in `scope`. */
export function scopeViolations(changed: string[], scope: TaskScope): string[] {
  const res = scope.files.map(toRegex);
  return changed.map(normalize).filter((f) => !res.some((re) => re.test(f)));
}

/** The literal directory/file prefix of a pattern, up to the first wildcard. */
function staticPrefix(pattern: string): string {
  const p = normalize(pattern);
  const i = p.search(/[*?]/);
  return i === -1 ? p : p.slice(0, i);
}

/**
 * Whether two scopes could touch the same file. Deliberately CONSERVATIVE (may
 * say true for scopes that do not truly collide, never false for ones that do):
 * a literal path is tested against the other side's globs; two patterns overlap
 * when their literal prefixes nest. `src/**` and `src/a.ts` overlap; `src/a/**`
 * and `docs/**` do not.
 */
export function scopeOverlap(a: TaskScope, b: TaskScope): boolean {
  const isLiteral = (p: string) => !/[*?]/.test(p) && !p.endsWith("/");
  for (const pa of a.files) {
    for (const pb of b.files) {
      if (isLiteral(pa) && toRegex(pb).test(normalize(pa))) return true;
      if (isLiteral(pb) && toRegex(pa).test(normalize(pb))) return true;
      const sa = staticPrefix(pa);
      const sb = staticPrefix(pb);
      if (sa.startsWith(sb) || sb.startsWith(sa)) {
        // Both literal and different: no overlap (handled above when equal).
        if (isLiteral(pa) && isLiteral(pb)) { if (normalize(pa) === normalize(pb)) return true; continue; }
        return true;
      }
    }
  }
  return false;
}
