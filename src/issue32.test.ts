import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, symlink, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDir, runPaths, writePrivate, xferPaths, fleetStateDir } from "./paths.js";
import { newRunId, saveLedger, ledgerPath } from "./ledger.js";
import { validateTaskIds } from "./guard.js";

async function scratch<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "fleet32-"));
  try {
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe("issue #32: private state dir", () => {
  it("creates the directory 0700", async () => {
    await scratch(async (base) => {
      const dir = ensureStateDir(join(base, "a", "b"));
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    });
  });
  it("tightens a group/world-accessible existing dir", async () => {
    await scratch(async (base) => {
      const dir = join(base, "loose");
      await mkdir(dir, { mode: 0o777 });
      ensureStateDir(dir);
      expect((await stat(dir)).mode & 0o077).toBe(0);
    });
  });
  it("refuses a symlinked state dir", async () => {
    await scratch(async (base) => {
      const real = join(base, "real");
      await mkdir(real);
      await symlink(real, join(base, "link"));
      expect(() => ensureStateDir(join(base, "link"))).toThrow(/plain directory/);
    });
  });
  it("honors FLEET_STATE_DIR and defaults under the user's home, not the shared tmp", () => {
    expect(fleetStateDir({ FLEET_STATE_DIR: "/x/y" })).toBe("/x/y");
    expect(fleetStateDir({})).not.toContain(tmpdir() + "/fleet-");
    expect(fleetStateDir({})).toContain(".openclaw");
  });
});

describe("issue #32: per-run paths", () => {
  it("builds all run files inside the state dir", async () => {
    await scratch(async (base) => {
      const dir = ensureStateDir(join(base, "s"));
      const p = runPaths("run-abc", dir);
      for (const f of Object.values(p)) expect(f.startsWith(dir + "/")).toBe(true);
      expect(xferPaths("sync-1", dir).dir.startsWith(dir + "/")).toBe(true);
    });
  });
  it("throws on an id that could escape the dir", () => {
    expect(() => runPaths("../x", "/s")).toThrow(/invalid runId/);
    expect(() => xferPaths("a/b", "/s")).toThrow(/invalid transferId/);
  });
  it("generates unguessable ids that satisfy the id rule", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRunId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(() => runPaths(id, "/s")).not.toThrow();
  });
});

describe("issue #32: private atomic writes", () => {
  it("writes 0600 by default, 0700 for scripts, and leaves no temp file", async () => {
    await scratch(async (base) => {
      await writePrivate(join(base, "f.json"), "{}");
      await writePrivate(join(base, "r.sh"), "#!/bin/bash\n", 0o700);
      expect((await stat(join(base, "f.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(base, "r.sh"))).mode & 0o777).toBe(0o700);
      expect((await readdir(base)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });
  it("overwrites atomically", async () => {
    await scratch(async (base) => {
      await writePrivate(join(base, "f"), "one");
      await writePrivate(join(base, "f"), "two");
      expect(await readFile(join(base, "f"), "utf8")).toBe("two");
    });
  });
  it("the ledger is written 0600", async () => {
    await scratch(async (base) => {
      await saveLedger(base, []);
      expect((await stat(ledgerPath(base))).mode & 0o777).toBe(0o600);
    });
  });
});

describe("issue #32: run-addressed messages require a runId", () => {
  it("rejects a missing runId on run ops and an empty-string id anywhere", () => {
    expect(validateTaskIds({ prompt: "__RUN_STATUS__" })).toMatch(/runId required/);
    expect(validateTaskIds({ prompt: "__RUN_START__", runId: "run-1" })).toBeUndefined();
    expect(validateTaskIds({ prompt: "x", transferId: "" })).toMatch(/transferId/);
  });
});
