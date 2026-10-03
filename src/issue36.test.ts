import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SSH_ARGS, assertSafeHost, isSafeSshHost, scpPrefix, scpRemote, setSshOptions, sshPrefix } from "./ssh.js";

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(here, f), "utf8")] as const);

describe("issue #36: ssh host strings", () => {
  it("accepts ordinary hosts", () => {
    for (const h of ["dev2", "dev-2.tail1234.ts.net", "100.64.0.7", "root@dev2", "svc_user@10.0.0.2", "fd7a:115c::1"]) {
      expect(isSafeSshHost(h), h).toBe(true);
    }
  });
  it("rejects option-looking, spaced, metacharacter and non-string hosts", () => {
    for (const h of ["-oProxyCommand=evil", "-J host", "a b", "dev2;id", "dev2$(id)", "dev2\nx", "", "@dev2", "dev2@", "Windows Node (DESKTOP)", "`id`", "a|b"]) {
      expect(isSafeSshHost(h), JSON.stringify(h)).toBe(false);
    }
    expect(isSafeSshHost(undefined)).toBe(false);
    expect(isSafeSshHost(42)).toBe(false);
    expect(() => assertSafeHost("-oProxyCommand=evil")).toThrow(/unsafe host/);
  });
});

describe("issue #36: argv shape", () => {
  it("sshPrefix puts '--' between the options and the host", () => {
    const a = sshPrefix("root@dev2");
    expect(a.slice(-2)).toEqual(["--", "root@dev2"]);
    expect(a.slice(0, SSH_ARGS.length)).toEqual([...SSH_ARGS]);
    expect(() => sshPrefix("-oProxyCommand=x")).toThrow();
  });
  it("scp remote operands bracket IPv6 hosts (user@ stays outside) and leave names/IPv4 alone", () => {
    expect(scpRemote("fd7a:115c::1", "/tmp/x")).toBe("[fd7a:115c::1]:/tmp/x");
    expect(scpRemote("svc@fd7a:115c::1", "/tmp/x")).toBe("svc@[fd7a:115c::1]:/tmp/x");
    expect(scpRemote("dev2", "/tmp/x")).toBe("dev2:/tmp/x");
    expect(scpRemote("100.64.0.7", "p")).toBe("100.64.0.7:p");
    expect(scpRemote("svc@dev2", "p")).toBe("svc@dev2:p");
  });
  it("scp: options, '--', then operands; remote operand validated", () => {
    expect(scpPrefix().slice(-1)).toEqual(["--"]);
    expect(scpRemote("svc@dev2", "/tmp/x")).toBe("svc@dev2:/tmp/x");
    expect(() => scpRemote("-oProxyCommand=x", "/tmp/x")).toThrow();
  });
  it("every ssh/scp call site in shipped code goes through the guarded helpers", () => {
    for (const [f, src] of sources) {
      if (f === "ssh.ts") continue;
      // a raw `[...SSH_ARGS, <something>` / `[...sshArgs, <something>` array literal bypasses '--' + validation
      expect(src, f).not.toMatch(/\[\.\.\.(?:SSH_ARGS|sshArgs),\s+(?!\s)(?!"-r"|"--")/);
    }
  });
});

describe("issue #36: host key policy", () => {
  const strict = () => SSH_ARGS.find((a) => a.startsWith("StrictHostKeyChecking="));
  afterEach(() => setSshOptions({}));
  it("defaults to accept-new, can be tightened to yes, and never to 'no'", () => {
    expect(strict()).toBe("StrictHostKeyChecking=accept-new");
    setSshOptions({ strictHostKeyChecking: "yes" });
    expect(strict()).toBe("StrictHostKeyChecking=yes");
    setSshOptions({ strictHostKeyChecking: "no" });
    expect(strict()).toBe("StrictHostKeyChecking=accept-new");
    setSshOptions({ strictHostKeyChecking: "off" });
    expect(strict()).toBe("StrictHostKeyChecking=accept-new");
  });
  it("BatchMode stays on (no password prompts from a non-interactive manager)", () => {
    expect(SSH_ARGS).toContain("BatchMode=yes");
  });
});

describe("issue #36: deploy hardening", () => {
  const deploy = sources.find(([f]) => f === "deploy.ts")![1];
  it("stages in a private mktemp dir and verifies the tarball sha256 before installing", () => {
    expect(deploy).toContain("mktemp -d /tmp/fleet-deploy.");
    expect(deploy.indexOf("tarball checksum mismatch")).toBeGreaterThan(0);
    expect(deploy.indexOf("tarball checksum mismatch")).toBeLessThan(deploy.indexOf("installCmd],\n            { timeout: 120_000 }"));
    expect(deploy).not.toContain("`cd /tmp && openclaw plugins install");
  });
  it("upload, checksum and install all sit inside one try/finally that removes the staging dir", () => {
    const tryAt = deploy.indexOf("let installOut: string;\n        try {");
    const scpAt = deploy.indexOf('execFileP("scp", [...scpPrefix(), tarball');
    const shaAt = deploy.indexOf("tarball checksum mismatch");
    const installAt = deploy.indexOf("installCmd],\n            { timeout: 120_000 }");
    const finallyAt = deploy.indexOf("} finally {", tryAt);
    expect(tryAt).toBeGreaterThan(0);
    for (const at of [scpAt, shaAt, installAt]) {
      expect(at).toBeGreaterThan(tryAt);
      expect(at).toBeLessThan(finallyAt);
    }
    expect(deploy.slice(finallyAt, finallyAt + 200)).toContain("rm -rf -- ${shq(stage)}");
  });
  it("distinguishes an explicit root login from an unset login user", () => {
    expect(deploy).toContain('if (loginUser === "root") {');
    expect(deploy).toContain("WARNING: managing this node over SSH as root");
    expect(deploy).toContain("no nodes[].user set, so SSH uses its default login user (often root)");
  });
  it("the openclaw dev dependency is pinned, not 'latest'", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    expect(pkg.devDependencies.openclaw).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
