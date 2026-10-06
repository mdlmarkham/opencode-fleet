import { afterEach, describe, expect, it } from "vitest";
import { latestRunFor, loadLedger, onNode, resolveAbortRunId, type LedgerEntry } from "./ledger.js";
import { fakeSshMultiline, loadEntry, loadPlugin, nodeReply } from "./testkit/plugin.js";

const entry = (o: Partial<LedgerEntry> & { runId: string }): LedgerEntry =>
  ({ node: "dev2", cwd: "/w/p", prompt: "p", startedAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z", state: "completed", verified: true, ...o }) as LedgerEntry;

// #257: right after a node restart the node list can lack its displayName, so a lookup by [nodeId] alone must
// still find a run recorded under the display name — otherwise fleet_sync reports a verified run as unverified.
describe("#257: run lookup survives a missing displayName", () => {
  const runs = [entry({ runId: "a", nodeId: "n-1", sessionId: "s1" }), entry({ runId: "other", node: "dev3", nodeId: "n-2" })];

  it("matches by display name, by node id, and rejects another node's run", () => {
    expect(latestRunFor(runs, ["dev2"], "/w/p")?.runId).toBe("a");
    expect(latestRunFor(runs, ["n-1"], "/w/p")?.runId).toBe("a");
    expect(latestRunFor(runs, ["n-2"], "/w/p")?.runId).toBe("other");
    expect(latestRunFor(runs, ["n-9"], "/w/p")).toBeUndefined();
  });
  it("a legacy entry without nodeId still matches by name only", () => {
    const legacy = [entry({ runId: "old" })];
    expect(latestRunFor(legacy, ["dev2"], "/w/p")?.runId).toBe("old");
    expect(latestRunFor(legacy, ["n-1"], "/w/p")).toBeUndefined();
    expect(onNode({ node: "dev2" }, ["dev2"])).toBe(true);
  });
  it("abort-by-session resolves the same way", () => {
    expect(resolveAbortRunId(runs, "s1", ["n-1"])).toBe("a");
    expect(resolveAbortRunId(runs, "s1", ["dev3"])).toBeUndefined();
  });
});

describe("#257: dispatch records the node id", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  it("the ledger entry carries node (display) and nodeId", async () => {
    const loaded = await loadEntry();
    if (!loaded) return;
    restore = fakeSshMultiline(["FLEET_CWD=ok", "GITCLONE=yes", "BWRAP=no"]);
    const t = loadPlugin(loaded, { nodes: [{ nodeId: "n-dev2", displayName: "dev2", connected: true, invocableCommands: ["opencode.run"] }], config: { nodes: { dev2: { roles: ["worker"], ssh: false } } }, invoke: () => nodeReply({ ok: true, detached: true, runId: "r", pid: 1 }) });
    try {
      await t.call("fleet_dispatch", { cwd: "/w/p", node: "dev2", prompt: "x" });
      const led = await loadLedger(t.rootDir);
      expect(led[0]).toMatchObject({ node: "dev2", nodeId: "n-dev2" });
    } finally { t.dispose(); }
  });
});
