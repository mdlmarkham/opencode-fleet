import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AWAIT_MISSING_NOTE } from "./await.js";
import { DEPLOY_NOTES } from "./deploy.js";
import { fakeSsh, loadEntry, loadPlugin, nodeReply, type Loaded } from "./testkit/plugin.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("#191: stale tool lists and the reload path", () => {
  it("the fleet_await hint tells a session without the tool what to do", () => {
    expect(AWAIT_MISSING_NOTE).toContain("no fleet_await");
    expect(AWAIT_MISSING_NOTE).toContain("new session");
    expect(AWAIT_MISSING_NOTE).toContain("fleet_run_status");
  });

  it("the ack-timeout recovery text carries the same fallback", () => {
    expect(readFileSync(join(here, "recovery.ts"), "utf8")).toContain("session predates a plugin update");
  });

  it("deploy notes say restart-not-reload and that old sessions keep their tool list", () => {
    const all = DEPLOY_NOTES.join(" ");
    expect(all).toContain("RESTART");
    expect(all).toContain("plugins reload");
    expect(all).toContain("outside an agent turn");
    expect(all).toContain("start a new session");
  });

  it("a successful deploy returns the notes; a failed one does not", () => {
    const src = readFileSync(join(here, "deploy.ts"), "utf8");
    expect(src).toContain("...(ok ? { notes: DEPLOY_NOTES } : { error:");
  });
});

const loaded = await loadEntry();
it.skipIf(!process.env.CI)("CI: the plugin entry loads, so the dispatch note test really ran", () => { expect(loaded).toBeDefined(); });

describe.skipIf(!loaded)("#191: runtime notes degrade for a stale session", () => {
  let p: Loaded | undefined;
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = fakeSsh("FLEET_CWD=ok"); });
  afterEach(() => { p?.dispose(); p = undefined; restore?.(); });
  it("the detached-launch note that points at fleet_await also says what to do without it", async () => {
    p = loadPlugin(loaded!, {
      nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }],
      config: { nodes: { dev2: { roles: ["worker"], ssh: false } } },
      invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }),
    });
    const r = await p.call("fleet_dispatch", { node: "dev2", cwd: "/w", prompt: "do it" });
    expect(r.dev2.note).toContain("fleet_await");
    expect(r.dev2.note).toContain(AWAIT_MISSING_NOTE);
  });
});
