/**
 * Issue #260 item 2: the read-only `fleet_prs` stack / stale-base check.
 *
 * Contract proven here, in three layers (no network, no real gh, no real remote):
 *   1. PURE `analyzeStacks` — open PRs + remote heads + default branch in,
 *      flags out: `stackedOn` (base is another open PR's head; a chain of 3+
 *      resolves each link), `baseMergedNotRetargeted` + the note (base gone),
 *      and the two unflagged shapes (base == default, base == an existing
 *      remote branch), with correct counts, sorted by number.
 *   2. THE EXEC LAYER against a fake `gh` and fake `git` on PATH (the #137
 *      fake-binary pattern): fixture PRs parsed and reported end to end;
 *      `gh` exiting 3 → ok:false with the stderr surfaced; malformed gh JSON
 *      → ok:false; a failing `git ls-remote` → ok:false. Commands run with
 *      cwd=repo; nothing writes.
 *   3. WIRING PINS (readFileSync, the issue260b/issue191 style): `fleet_prs`
 *      in openclaw.plugin.json `contracts.tools`, the SKILL.md table row, and
 *      the `registerPrsTools` call wired in the gateway source.
 *
 * Fails on dbd7e94b (no prs.ts, no fleet_prs anywhere) and passes after.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeStacks, parseGhPrList, parseRemoteHeads, type PrRow } from "./tools/prs.js";
import { gatewaySrc } from "./testkit/src.js";
import { loadEntry, loadPlugin } from "./testkit/plugin.js";

const entry = await loadEntry();

// ---------------------------------------------------------------------------
// 1. Pure analyzeStacks fixtures (no network)
// ---------------------------------------------------------------------------

const pr = (number: number, headRefName: string, baseRefName: string, title = `PR ${number}`): PrRow => ({
  number,
  title,
  headRefName,
  baseRefName,
  url: `https://github.com/o/r/pull/${number}`,
});
// Input deliberately unsorted: the OUTPUT must be sorted by number (the tool contract).
const shuffled = [pr(3, "fix/c", "fleet/b"), pr(1, "feat/a", "main"), pr(2, "fleet/b", "main")];

describe("#260 item 2: analyzeStacks (pure)", () => {
  it("A stacked on B: PR 3's base is PR 2's head; counts; output sorted", () => {
    const r = analyzeStacks(shuffled, ["main", "survivor"], "main");
    expect(r.counts).toEqual({ open: 3, stacked: 1, staleBase: 0 });
    expect(r.prs[2]).toMatchObject({ number: 3, base: "fleet/b", stackedOn: 2, title: "PR 3", url: "https://github.com/o/r/pull/3" });
    expect(r.prs[2].baseMergedNotRetargeted).toBeUndefined();
    expect(r.prs.map((x) => x.number)).toEqual([1, 2, 3]); // sorted by number
  });
  it("base gone (not default, not on origin, not another open head) → flag + the exact note", () => {
    const r = analyzeStacks([pr(7, "fix/d", "dead-branch")], ["main"], "main");
    expect(r.counts).toEqual({ open: 1, stacked: 0, staleBase: 1 });
    expect(r.prs[0]).toMatchObject({
      number: 7,
      base: "dead-branch",
      baseMergedNotRetargeted: true,
      note: "base merged, PR not retargeted (base branch dead-branch no longer exists)",
    });
    expect(r.prs[0].stackedOn).toBeUndefined();
  });
  it("base == default branch → unflagged", () => {
    const r = analyzeStacks([pr(9, "fix/e", "main")], [], "main");
    expect(r.counts).toEqual({ open: 1, stacked: 0, staleBase: 0 });
    expect(r.prs[0].baseMergedNotRetargeted).toBeUndefined();
    expect(r.prs[0].stackedOn).toBeUndefined();
  });
  it("base == an existing remote branch → unflagged", () => {
    const r = analyzeStacks([pr(9, "fix/e", "release/1.0")], ["main", "release/1.0"], "main");
    expect(r.counts).toEqual({ open: 1, stacked: 0, staleBase: 0 });
    expect(r.prs[0].baseMergedNotRetargeted).toBeUndefined();
  });
  it("a 3-PR chain resolves each link (3→2, 2→1; 1 sits on main)", () => {
    const r = analyzeStacks([pr(1, "chain/a", "main"), pr(2, "chain/b", "chain/a"), pr(3, "chain/c", "chain/b")], ["main"], "main");
    expect(r.counts).toEqual({ open: 3, stacked: 2, staleBase: 0 });
    expect(r.prs.map((x) => x.stackedOn)).toEqual([undefined, 1, 2]); // parent is the IMMEDIATE PR below
  });
  it("two open PRs share one head: a PR stacked on it points at the LOWER-numbered one", () => {
    const r = analyzeStacks([pr(5, "shared", "main"), pr(4, "shared", "main"), pr(6, "on-shared", "shared")], ["main"], "main");
    expect(r.counts).toEqual({ open: 3, stacked: 1, staleBase: 0 });
    expect(r.prs[2].stackedOn).toBe(4); // deterministic: lowest-numbered open PR whose head is "shared"
  });
  it("an empty repo state: zero counts, empty list, no throw", () => {
    expect(analyzeStacks([], [], "main")).toEqual({ counts: { open: 0, stacked: 0, staleBase: 0 }, prs: [] });
  });
  it("parseRemoteHeads: refs/heads/ stripped, the symref preamble and non-head refs ignored", () => {
    const out = parseRemoteHeads("abc\trefs/heads/x\nref: refs/heads/main\tHEAD\ndef\trefs/heads/feature/y\nzzz\trefs/tags/v1\n");
    expect(out).toEqual(["x", "feature/y"]);
  });
  it("parseGhPrList: a good array parses; a non-array or broken JSON is a named failure", () => {
    const good = parseGhPrList(JSON.stringify([pr(1, "h", "b")]));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.prs).toEqual([pr(1, "h", "b")]);
    expect(parseGhPrList("[]").ok).toBe(true);
    const notArray = parseGhPrList('{"number":1}');
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain("not an array");
    const broken = parseGhPrList("{nope");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("malformed JSON");
    // a row without a usable number is dropped, not fatal
    const partial = parseGhPrList('[{"title":"no number"},{"number":4,"title":"t","headRefName":"h","baseRefName":"b","url":"u"}]');
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.prs.map((x) => x.number)).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------
// 2. The exec layer: a fake `gh` and fake `git` on PATH (the #137 pattern)
// ---------------------------------------------------------------------------

const GH_PRS = [
  { number: 2, title: "Fix parser", headRefName: "fleet/fix", baseRefName: "fleet/feat", url: "https://github.com/o/r/pull/2" },
  { number: 1, title: "Add feature", headRefName: "fleet/feat", baseRefName: "main", url: "https://github.com/o/r/pull/1" },
  { number: 5, title: "Stale", headRefName: "fleet/stale", baseRefName: "merged-branch", url: "https://github.com/o/r/pull/5" },
];

describe("#260 item 2: the exec layer over fake gh / fake git on PATH", () => {
  let repoDir = "";
  let prevPath = "";
  const savedEnv: Array<[string, string | undefined]> = [];
  const setEnv = (k: string, v: string | undefined) => {
    savedEnv.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  /**
   * Fake `gh` + `git` first on PATH. Only the exact read-only calls are answered:
   * `gh pr list --state open --json ...` (exit code, stdout, stderr from env) and
   * `git ls-remote` --heads / --symref. Any other argv fails loudly: the tool must
   * never write. `git -C <repo> ...` is part of the argv.
   */
  function fakeGhGit(opts: { ghExit?: number; ghOut?: string; ghStderr?: string; symrefFails?: boolean } = {}): void {
    repoDir = mkdtempSync(join(tmpdir(), "fleet260c-repo-"));
    const bin = mkdtempSync(join(tmpdir(), "fleet260c-bin-"));
    const gh = [
      "#!/bin/sh",
      'case "$1 $2 $3 $4" in',
      '  "pr list --state open"*)',
      '    [ -n "$FAKE_GH_STDERR" ] && printf \'%s\\n\' "$FAKE_GH_STDERR" >&2',
      '    [ -n "$FAKE_GH_OUT" ] && printf \'%s\\n\' "$FAKE_GH_OUT"',
      '    exit "${FAKE_GH_EXIT:-0}" ;;',
      "esac",
      'echo "unexpected gh argv: $*" >&2',
      "exit 66",
    ].join("\n");
    const git = opts.symrefFails
      ? [
          "#!/bin/sh",
          'case "$*" in',
          '  *--symref*) echo "fatal: could not read remote repository" >&2; exit 128 ;;',
          "esac",
          "# heads still works",
          'case "$*" in',
          "  *--heads*) printf '111\\trefs/heads/main\\n222\\trefs/heads/fleet/feat\\n333\\trefs/heads/fleet/fix\\n'; exit 0 ;;",
          "esac",
          'echo "unexpected git argv: $*" >&2',
          "exit 66",
        ].join("\n")
      : [
          "#!/bin/sh",
          'case "$*" in',
          "  *--symref*) printf 'ref: refs/heads/main\\tHEAD\\n'; exit 0 ;;",
          '  *--heads*) printf \'111\\trefs/heads/main\\n222\\trefs/heads/fleet/feat\\n333\\trefs/heads/fleet/fix\\n\'; exit 0 ;;',
          "esac",
          'echo "unexpected git argv: $*" >&2',
          "exit 66",
        ].join("\n");
    writeFileSync(join(bin, "gh"), gh + "\n", { mode: 0o755 });
    writeFileSync(join(bin, "git"), git + "\n", { mode: 0o755 });
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "git"), 0o755);
    prevPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${prevPath}`;
    setEnv("FAKE_GH_OUT", opts.ghOut ?? JSON.stringify(GH_PRS));
    setEnv("FAKE_GH_EXIT", String(opts.ghExit ?? 0));
    setEnv("FAKE_GH_STDERR", opts.ghStderr);
  }

  afterEach(() => {
    if (prevPath) process.env.PATH = prevPath;
    prevPath = "";
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    savedEnv.length = 0;
    if (repoDir) { rmSync(repoDir, { recursive: true, force: true }); repoDir = ""; }
  });

  it.skipIf(!entry)("fixture PRs parsed, stacked and flagged end to end; cwd=repo; read-only", async () => {
    fakeGhGit();
    const p = loadPlugin(entry!, {});
    try {
      const r = (await p.call("fleet_prs", { repo: repoDir })) as Record<string, unknown>;
      expect(JSON.stringify(r)).not.toContain('"ok":false');
      expect(r).toMatchObject({
        ok: true,
        repo: repoDir,
        defaultBranch: "main",
        counts: { open: 3, stacked: 1, staleBase: 1 },
      });
      expect(r.prs).toEqual([
        { number: 1, title: "Add feature", head: "fleet/feat", base: "main", url: "https://github.com/o/r/pull/1" },
        { number: 2, title: "Fix parser", head: "fleet/fix", base: "fleet/feat", url: "https://github.com/o/r/pull/2", stackedOn: 1 },
        {
          number: 5,
          title: "Stale",
          head: "fleet/stale",
          base: "merged-branch",
          url: "https://github.com/o/r/pull/5",
          baseMergedNotRetargeted: true,
          note: "base merged, PR not retargeted (base branch merged-branch no longer exists)",
        },
      ]);
    } finally { p.dispose(); }
  });

  it.skipIf(!entry)("a relative repo path is refused without touching gh or git", async () => {
    fakeGhGit();
    const p = loadPlugin(entry!, {});
    try {
      const r = (await p.call("fleet_prs", { repo: "relative/path" })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
    } finally { p.dispose(); }
  });

  it.skipIf(!entry)("gh exiting 3 → ok:false with the stderr head surfaced, never a throw", async () => {
    fakeGhGit({ ghExit: 3, ghOut: "", ghStderr: "gh: Not logged in via gh auth" });
    const p = loadPlugin(entry!, {});
    try {
      const r = (await p.call("fleet_prs", { repo: repoDir })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/gh pr list[\s\S]*Not logged in/) });
    } finally { p.dispose(); }
  });

  it.skipIf(!entry)("malformed gh JSON → ok:false naming the failure, never a throw", async () => {
    fakeGhGit({ ghOut: "<not json>" });
    const p = loadPlugin(entry!, {});
    try {
      const r = (await p.call("fleet_prs", { repo: repoDir })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/malformed JSON/) });
    } finally { p.dispose(); }
  });

  it.skipIf(!entry)("a failing git ls-remote (default branch) → ok:false naming the command and stderr", async () => {
    fakeGhGit({ symrefFails: true });
    const p = loadPlugin(entry!, {});
    try {
      const r = (await p.call("fleet_prs", { repo: repoDir })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ls-remote[\s\S]*could not read remote/) });
    } finally { p.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// 3. Wiring pins (the shared lines, issue260b/issue191 style)
// ---------------------------------------------------------------------------

describe("#260 item 2: wiring pins", () => {
  it("openclaw.plugin.json contracts.tools contains fleet_prs", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts: { tools: string[] };
    };
    expect(manifest.contracts.tools).toContain("fleet_prs");
  });
  it("SKILL.md has a fleet_prs row in the tools table", () => {
    const skill = readFileSync(new URL("../skills/opencode-fleet/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/^\|.*`fleet_prs`.*\|$/m);
  });
  it("registerPrsTools is wired next to the other register*Tools calls", () => {
    const src = gatewaySrc();
    expect(src).toContain('name: "fleet_prs"');
    expect(src).toContain('registerPrsTools(api, cfg)');
  });
  it("fleet_prs registers with the tight schema (repo only) and a description within budget", async () => {
    if (!entry) return;
    const p = loadPlugin(entry, {});
    try {
      const t = p.tools.get("fleet_prs");
      expect(t).toBeDefined();
      expect(t!.description!.length).toBeLessThanOrEqual(450);
      const params = t!.parameters as { additionalProperties: false; properties: Record<string, unknown>; required?: string[] };
      expect(params.additionalProperties).toBe(false);
      expect(Object.keys(params.properties).sort()).toEqual(["repo"]);
      expect(params.required).toEqual(["repo"]);
    } finally { p.dispose(); }
  });
});