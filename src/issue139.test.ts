/**
 * Issue #139 -- redactSecrets must redact credentials embedded in a URL's
 * userinfo (scheme://user:PASS@host) and in common password query params.
 *
 * Pre-existing gap: a connection string in a dispatch task or acceptance
 * criterion reached a hosted backend verbatim.
 */
import { describe, it, expect } from "vitest";
import { redactSecrets } from "./untrusted.js";
import { redactDeep } from "./decision-backends.js";

// Assembled at load time so this file carries no contiguous credential token.
const CONN = ["postgres://admin:", "s3cr3tP@ss", "@db.internal:5432/app"].join("");
const CONN_REDACTED = ["postgres://admin:", "[REDACTED]", "@db.internal:5432/app"].join("");

describe("issue #139: URL credential redaction", () => {
  it("redacts URL userinfo passwords, keeping scheme/user/host readable", () => {
    expect(redactSecrets(CONN)).toBe(CONN_REDACTED);
    expect(redactSecrets("https://u:" + "hunter2xyz" + "@example.com/path")).toBe(
      "https://u:[REDACTED]@example.com/path",
    );
    expect(redactSecrets("ssh://alice:" + "hunter2xyz" + "@git.internal:22/repo")).toBe(
      "ssh://alice:[REDACTED]@git.internal:22/repo",
    );
  });

  it("redacts common password query params", () => {
    for (const key of ["password", "passwd", "pwd", "secret", "token", "api_key", "access_token"]) {
      const out = redactSecrets("https://host/endpoint?" + key + "=" + "supersecretvalue123");
      expect(out).not.toContain("supersecretvalue123");
      expect(out).toContain("[REDACTED");
    }
  });

  it("never lets a URL password survive redactDeep", () => {
    const state = { url: CONN, q: "?password=supersecretvalue123" };
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
    const noUserinfo = "postgres://db.internal:5432/app";
    expect(redactSecrets(noUserinfo)).toBe(noUserinfo);
  });
});
