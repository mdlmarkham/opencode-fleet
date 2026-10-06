/**
 * Minimum Pi version enforcement (issue #137). Pi's flag set drifts between releases (the comment about
 * `--` support was already wrong once), so an operator can require a minimum. The check fails CLOSED:
 * a version that cannot be read is a refusal, never a pass.
 */

/**
 * The version from the banner line only: a line that is just a version, or one that starts with `pi`.
 * Other lines (a node deprecation warning, an "update available 9.9.9" notice) are never read as Pi's version,
 * so noise cannot make an old Pi pass.
 */
export function bannerVersion(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:v?(\d+\.\d+\.\d+)|pi\b\D*?v?(\d+\.\d+\.\d+))\s*$/i.exec(line);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

export const PI_VERSION_COMMAND = "pi --version 2>&1 | head -n 5";

const parts = (v: string): [number, number, number] => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)!; return [Number(m[1]), Number(m[2]), Number(m[3])]; };

/** -1 / 0 / 1, comparing numeric major.minor.patch. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export function checkPiVersion(probeOutput: string, min: string): { ok: true; version: string } | { ok: false; error: string } {
  if (!/^\d+\.\d+\.\d+$/.test(min)) return { ok: false, error: `dispatch.piMinVersion "${min.slice(0, 20)}" is not major.minor.patch` };
  const v = bannerVersion(probeOutput);
  if (!v) return { ok: false, error: `could not read this node's Pi version (needs >= ${min}); is \`pi\` installed on the service user's PATH?` };
  return compareVersions(v, min) >= 0 ? { ok: true, version: v } : { ok: false, error: `Pi ${v} is older than the required ${min}; upgrade Pi on the node` };
}
