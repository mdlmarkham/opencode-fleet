/**
 * Issue #139 -- redactSecrets must redact credentials embedded in a URL's
 * userinfo (scheme://user:PASS@host) and in common password query params.
 *
 * Pre-existing gap: a connection string in a dispatch task or an acceptance
 * criterion reached a hosted backend verbatim.
 *
 * The userinfo password class is greedy (`[^\s@]*`) so it consumes up to the
 * LAST `@` in the authority: a password containing `@`, `/`, `?` or `#` is
 * removed whole rather than truncated at the first delimiter. The host
 * lookahead only requires a non-empty host, so single-label hosts, `host:port`
 * without a dot, and `[IPv6]` literals are redacted too.
 *
 * Every credential string below is assembled at load time, so this file never
 * carries a contiguous secret token.
 */
import { describe, it, expect } from "vitest";
import { redactSecrets } from "./untrusted.js";
import { redactDeep } from "./decision-backends.js";

// join() keeps the credential out of a single contiguous literal in the file.
const j = (...parts: string[]) => parts.join("");

const CONN = j("postgres://admin:", "s3cr3tP@ss", "@db.internal:5432/app");
const CONN_REDACTED = j("postgres://admin:", "[REDACTED]", "@db.internal:5432/app");
const CONN_REDACTED_EXACT = CONN_REDACTED;

/** Every credential body the adversarial gate proved must not survive. */
const LEAKY_URLS: Array<[string, string, string]> = [
  // [label, raw, forbidden fragment]
  ["userinfo @-in-password, dotted host", CONN, "s3cr3tP@ss"],
  ["https userinfo", j("https://u:", "hunter2xyz", "@example.com/path"), "hunter2xyz"],
  ["ssh userinfo", j("ssh://alice:", "hunter2xyz", "@git.internal:22/repo"), "hunter2xyz"],
  // Single-label hosts and host:port without a dot -- leaked before this fix.
  ["localhost:port", j("postgres://u:", "hunter2pass", "@localhost:5432/app"), "hunter2pass"],
  ["compose service name", j("redis://default:", "hunter2pass", "@redis:6379"), "hunter2pass"],
  ["bare host", j("postgres://u:", "hunter2pass", "@db/app"), "hunter2pass"],
  ["intranet host", j("http://user:", "hunter2pass", "@intranet/x"), "hunter2pass"],
  ["host:port, dotted-free", j("ssh://alice:", "pw", "@git:22/repo"), "pw@"],
  ["IPv6 literal host", j("postgres://admin:", "hunter2pass", "@[2001:db8::1]:5432/app"), "hunter2pass"],
  // Delimiters inside the password -- leaked before this fix.
  ["slash in password", j("https://u:", "pa/ss", "@host.com/x"), "pa/ss"],
  ["leading slash in password", j("https://u:", "/pa55", "@host.com/x"), "/pa55"],
  ["@ and / in password", j("https://u:", "p@ss/word", "@host.com/x"), "p@ss/word"],
];

describe("issue #139: URL credential redaction", () => {
  it("redacts URL userinfo passwords, keeping scheme/user/host readable", () => {
    for (const [, raw, forbidden] of LEAKY_URLS) {
      const out = redactSecrets(raw);
      expect(out, raw).not.toContain(forbidden);
      expect(out, raw).toContain("[REDACTED]");
    }
  });

  it("redacts dotted-host userinfo exactly, preserving the rest of the URL", () => {
    expect(redactSecrets(CONN)).toBe(CONN_REDACTED_EXACT);
    expect(redactSecrets(j("https://u:", "hunter2xyz", "@example.com/path"))).toBe(
      j("https://u:", "[REDACTED]", "@example.com/path"),
    );
    expect(redactSecrets(j("ssh://alice:", "hunter2xyz", "@git.internal:22/repo"))).toBe(
      "ssh://alice:[REDACTED]@git.internal:22/repo",
    );
  });

  it("redacts common password query params", () => {
    for (const key of ["password", "passwd", "pwd", "secret", "token", "api_key", "access_token"]) {
      const out = redactSecrets("https://host/endpoint?" + key + "=" + "supersecretvalue123");
      expect(out, key).not.toContain("supersecretvalue123");
      expect(out, key).toContain("[REDACTED");
    }
  });

  it("never lets a URL password survive redactDeep", () => {
    const state = { url: CONN, q: "?password=" + "supersecretvalue123" };
    const out = JSON.stringify(redactDeep(state));
    expect(out).not.toContain("hunter2xyz");
    expect(out).not.toContain("supersecretvalue123");
    expect(out).not.toContain("s3cr3tP@ss");
  });

  it("does not over-redact: clean URLs are byte-identical and prose is untouched", () => {
    const clean = "https://example.com/a/b?x=1&y=2";
    expect(redactSecrets(clean)).toBe(clean);
    const prose = "The password policy requires at least twelve characters.";
    expect(redactSecrets(prose)).toBe(prose);
    const emails = "mail me@x.org and hello@y.com";
    expect(redactSecrets(emails)).toBe(emails);
    const at = "plain text with an @ sign";
    expect(redactSecrets(at)).toBe(at);
  });
});
