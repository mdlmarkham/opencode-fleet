/**
 * Shared SSH options for manager→node invocations.
 *
 * `StrictHostKeyChecking=accept-new` (TOFU) is the right default for a
 * Tailscale/private-network fleet: first contact accepts the host key
 * automatically, but *changed* keys are still refused. Prevents the
 * first-contact host-key failure (issue #2) without weakening MITM
 * detection for known hosts.
 */
export const SSH_ARGS = [
  "-o",
  "ConnectTimeout=10",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

/**
 * Host strings reach `ssh`/`scp` from node records and config. A value that
 * starts with `-` would be read as an option (`-oProxyCommand=...`), and one
 * with whitespace or shell metacharacters is never a host. Accept
 * `[user@]host` where host is a DNS name, IPv4, or IPv6 literal.
 */
const HOST_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;

export function isSafeSshHost(host: unknown): host is string {
  return typeof host === "string" && HOST_RE.test(host);
}

export function assertSafeHost(host: unknown): string {
  if (!isSafeSshHost(host)) throw new Error(`refusing to ssh to an unsafe host string: ${JSON.stringify(String(host).slice(0, 80))}`);
  return host;
}

/**
 * Operator-selectable host key policy. `accept-new` (TOFU, default) fits a
 * private network; `yes` requires the key to already be in known_hosts (pin
 * keys at provision time for production fleets). `no`/`off` are not offered.
 */
export type HostKeyPolicy = "accept-new" | "yes";

export function setSshOptions(opts: { strictHostKeyChecking?: string } = {}): void {
  const v = opts.strictHostKeyChecking;
  const policy: HostKeyPolicy = v === "yes" ? "yes" : "accept-new";
  const i = SSH_ARGS.findIndex((a) => a.startsWith("StrictHostKeyChecking="));
  if (i >= 0) SSH_ARGS[i] = `StrictHostKeyChecking=${policy}`;
}

/** `ssh` argv prefix: options, `--` (so the host can never be an option), then the validated host. */
export function sshPrefix(host: unknown, base: readonly string[] = SSH_ARGS): string[] {
  return [...base, "--", assertSafeHost(host)];
}

/** `scp` argv prefix: options then `--`; use `scpRemote()` for any host:path operand. */
export function scpPrefix(base: readonly string[] = SSH_ARGS): string[] {
  return [...base, "--"];
}

/** A `host:path` scp operand with the host validated. */
export function scpRemote(host: unknown, path: string): string {
  const h = assertSafeHost(host);
  // scp splits host from path at the first colon, so an IPv6 literal must be
  // bracketed (keeping any `user@` outside the brackets).
  const at = h.lastIndexOf("@");
  const user = at >= 0 ? h.slice(0, at + 1) : "";
  const bare = at >= 0 ? h.slice(at + 1) : h;
  return `${user}${bare.includes(":") ? `[${bare}]` : bare}:${path}`;
}
