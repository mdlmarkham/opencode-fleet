/**
 * Shell escaping — defense against command injection.
 *
 * The plugin builds shell command strings that run on remote nodes. Any
 * user-supplied value (cwd, prompt, model, agent, commit, repo) interpolated
 * into a shell string is an injection vector: `"`, `$(...)`, backticks, and
 * `;` inside double quotes still execute in bash.
 *
 * Use `shq()` for every value interpolated into a shell string. It wraps the
 * value in single quotes and escapes embedded single quotes — the only
 * context where bash treats the content literally.
 */

/**
 * Single-quote a value for safe shell interpolation.
 * `'` → `'\''` is the standard POSIX shell escaping for single-quoted strings.
 */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a `cd <dir> && ...` prefix with the dir shell-escaped.
 */
export function cdInto(dir: string): string {
  return `cd ${shq(dir)}`;
}

/**
 * Sanitize a value for use as a single argv element (no shell involved).
 * Rejects values containing NUL or control characters that could confuse
 * argv parsing. Returns the value unchanged when safe.
 */
export function safeArg(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`unsafe argument: contains control characters`);
  }
  return value;
}
