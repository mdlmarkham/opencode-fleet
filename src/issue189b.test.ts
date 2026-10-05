import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkerIdentity, validateWorkerIdentity, workerIdentityCommand } from "./provision.js";

const ID = { name: "fleet-worker", email: "fleet-worker@dev2.invalid" };

/** A real repo in a temp dir, with HOME and the global/system git config pointed at nothing. */
function repo(): { dir: string; env: NodeJS.ProcessEnv; git: (...a: string[]) => string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "fleet189b-"));
  const dir = join(base, "checkout");
  const env = { ...process.env, HOME: base, XDG_CONFIG_HOME: join(base, "xdg"), GIT_CONFIG_GLOBAL: join(base, "gitconfig-global"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", dir], { env });
  return { dir, env, git, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const run = (cmd: string, env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", cmd], { env, encoding: "utf8" });

describe("#189: distinct worker git identity", () => {
  it("is validated before it reaches a shell", () => {
    expect(validateWorkerIdentity(ID)).toBeNull();
    for (const bad of [
      { name: "", email: ID.email },
      { name: "x; rm -rf /", email: ID.email },
      { name: "$(id)", email: ID.email },
      { name: "a'b", email: ID.email },
      { name: "ok", email: "no-at-sign" },
      { name: "ok", email: "a@b.com; id" },
      { name: "ok", email: "a b@host" },
      { name: 5, email: ID.email },
      null,
    ]) expect(validateWorkerIdentity(bad), JSON.stringify(bad)).not.toBeNull();
    expect(() => workerIdentityCommand("/w", { name: "x; id", email: ID.email })).toThrow();
  });

  it("sets user.name and user.email in the checkout's LOCAL config when it has none (real git)", () => {
    const r = repo();
    try {
      expect(run(workerIdentityCommand(r.dir, ID), r.env).status).toBe(0);
      expect(r.git("config", "--local", "user.name")).toBe("fleet-worker");
      expect(r.git("config", "--local", "user.email")).toBe("fleet-worker@dev2.invalid");
      // A commit made there carries it.
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: r.dir, env: r.env });
      expect(r.git("log", "-1", "--format=%an <%ae>")).toBe("fleet-worker <fleet-worker@dev2.invalid>");
    } finally { r.cleanup(); }
  });

  it("never overwrites an identity the checkout already has, and never touches global config", () => {
    const r = repo();
    try {
      r.git("config", "--local", "user.name", "Existing Person");
      expect(run(workerIdentityCommand(r.dir, ID), r.env).status).toBe(0);
      expect(r.git("config", "--local", "user.name")).toBe("Existing Person");
      expect(r.git("config", "--local", "user.email")).toBe("fleet-worker@dev2.invalid"); // only the missing key is filled
      const globalFile = join(r.env.HOME!, "gitconfig-global");
      let globalText = "";
      try { globalText = readFileSync(globalFile, "utf8"); } catch { /* no global file was created */ }
      expect(globalText).not.toContain("fleet-worker");
    } finally { r.cleanup(); }
  });

  it("is idempotent, and a path with spaces and a quote is handled", () => {
    const r = repo();
    try {
      run(workerIdentityCommand(r.dir, ID), r.env);
      const again = run(workerIdentityCommand(r.dir, { name: "other", email: "other@h.invalid" }), r.env);
      expect(again.status).toBe(0);
      expect(r.git("config", "--local", "user.name")).toBe("fleet-worker");
    } finally { r.cleanup(); }
    const base = mkdtempSync(join(tmpdir(), "fleet189b-q-"));
    const dir = join(base, "it's a repo");
    try {
      execFileSync("git", ["init", "-q", dir], { env: { ...process.env, HOME: base } });
      expect(run(workerIdentityCommand(dir, ID), { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1" }).status).toBe(0);
      expect(execFileSync("git", ["-C", dir, "config", "--local", "user.email"], { env: { ...process.env, HOME: base }, encoding: "utf8" }).trim()).toBe(ID.email);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("the per-node default comes from the operator config; unset means no identity", () => {
    expect(resolveWorkerIdentity(undefined, "dev2")).toBeUndefined();
    expect(resolveWorkerIdentity({}, "dev2")).toEqual({ name: "fleet-worker", email: "fleet-worker@dev2.invalid" });
    expect(resolveWorkerIdentity({ name: "Fleet Bot", email: "bot@example.com" }, "dev2")).toEqual({ name: "Fleet Bot", email: "bot@example.com" });
    // A node display name with odd characters still yields a valid email.
    const odd = resolveWorkerIdentity({}, "dev 2/é")!;
    expect(validateWorkerIdentity(odd)).toBeNull();
  });

  it("goes in before the ownership hand-over in the unpack chain (so the config file ends up worker-owned)", () => {
    const src = readFileSync(join(__dirname, "provision.ts"), "utf8");
    const a = src.indexOf("workerIdentityCommand(req.cwd, req.workerIdentity)");
    const b = src.indexOf("ownershipCommand(req.cwd, req.serviceUser),", a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });
});
