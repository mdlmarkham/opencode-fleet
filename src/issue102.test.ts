import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shadowFileSink,
  setShadowLogOptions,
  buildShadowDecider,
  resetShadowConfigWarning,
  SHADOW_LOG_KEEP,
} from "./s1-shadow.js";

const dirs: string[] = [];
async function mkRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "shadow102-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  setShadowLogOptions({});
  resetShadowConfigWarning();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("issue #102: the shadow log appends, rotates, and warns", () => {
  it("appends each entry as its own line (no read-modify-write, no lost lines)", async () => {
    const root = await mkRoot();
    const sink = shadowFileSink(root);
    await Promise.all(Array.from({ length: 25 }, (_, i) => sink({ n: i })));
    const text = await readFile(join(root, ".opencode-fleet", "s1-shadow.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(25);
    // every line is a complete JSON object (nothing interleaved/truncated)
    const ns = lines.map((l) => (JSON.parse(l) as { n: number }).n).sort((a, b) => a - b);
    expect(ns).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("rotates at the size cap and keeps K generations", async () => {
    const root = await mkRoot();
    setShadowLogOptions({ maxBytes: 200, keep: 2 });
    const sink = shadowFileSink(root);
    const path = join(root, ".opencode-fleet", "s1-shadow.jsonl");
    // write enough to force several rotations
    for (let i = 0; i < 40; i++) {
      await sink({ n: i, pad: "x".repeat(50) });
    }
    // live file is under the cap after rotation
    const live = (await stat(path)).size;
    expect(live).toBeLessThanOrEqual(200 + 120); // one record slack
    // .1 and .2 exist; .3 does not (keep=2)
    await expect(stat(`${path}.1`)).resolves.toBeTruthy();
    await expect(stat(`${path}.2`)).resolves.toBeTruthy();
    await expect(stat(`${path}.3`)).rejects.toBeTruthy();
    // the newest record is in the live file
    const tail = await readFile(path, "utf8");
    expect(tail).toContain('"n":39');
  });

  it("warns ONCE per process when an s1 config is present but invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetShadowConfigWarning();
      // invalid: mode must be off|shadow|enforce
      expect(buildShadowDecider({ mode: "on" }, { sink: () => Promise.resolve() })).toBeUndefined();
      expect(buildShadowDecider({ mode: "on" }, { sink: () => Promise.resolve() })).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/invalid/i);

      // an ABSENT config uses the SAFE DEFAULTS (local-kev, shadow) - it is NOT
      // invalid, so it must not warn. (It also yields a real decider, by design.)
      resetShadowConfigWarning();
      warn.mockClear();
      buildShadowDecider(undefined, { sink: () => Promise.resolve() });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a valid config or an explicit mode off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetShadowConfigWarning();
      expect(buildShadowDecider({ mode: "off" }, { sink: () => Promise.resolve() })).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
