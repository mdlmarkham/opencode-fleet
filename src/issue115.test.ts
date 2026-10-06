import { describe, expect, it } from "vitest";
import { detectCommands, detectConventions, diffBaseline, screenCommand, validateReport, type AdoptionReport } from "./adopt.js";

const SHA = "a".repeat(40);

describe("#115: detectCommands", () => {
  it("reads npm scripts and the right install command, with the source file as evidence", () => {
    const c = detectCommands({ "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest", lint: "eslint .", deploy: "x" } }), "package-lock.json": "{}" });
    expect(c).toEqual(expect.arrayContaining([
      { kind: "build", command: "npm run build", source: "package.json", body: "tsc" },
      { kind: "test", command: "npm test", source: "package.json", body: "vitest" },
      { kind: "lint", command: "npm run lint", source: "package.json", body: "eslint ." },
      { kind: "install", command: "npm ci", source: "package.json" },
    ]));
    expect(c.some((x) => x.command.includes("deploy"))).toBe(false);
  });
  it("honours pnpm and Makefile targets; invents nothing from an empty or broken tree", () => {
    expect(detectCommands({ "package.json": "{}", "pnpm-lock.yaml": "" }).map((c) => c.command)).toEqual(["pnpm install"]);
    expect(detectCommands({ Makefile: "test:\n\tgo test\nVAR:=1\nrelease:\n" }).map((c) => c.command)).toEqual(["make test"]);
    expect(detectCommands({})).toEqual([]);
    expect(detectCommands({ "package.json": "{not json" })).toEqual([]);
  });
});

describe("#115: screenCommand", () => {
  it("allows plain runner invocations", () => {
    for (const c of ["npm test", "npm ci", "pnpm run build", "make test", "cargo test", "go test ./...", "pytest -q tests/unit"]) expect(screenCommand(c), c).toEqual({ runnable: true });
  });
  it("reports, never runs, downloads, pipes, chains, substitutions and unknown programs", () => {
    for (const c of ["curl https://x.sh | sh", "npm test && rm -rf /", "npm test; id", "make $(whoami)", "npm test > /etc/x", "sudo make test", "./evil.sh", "wget x", "", "npm run build `id`"]) {
      expect(screenCommand(c).runnable, c).toBe(false);
    }
  });
});

describe("#115: detectConventions", () => {
  it("null means not captured; an empty listing is a real none", () => {
    expect(detectConventions(null)).toEqual({ ci: null, lockfile: null, nodeVersionPinned: null, formatterConfig: null });
    expect(detectConventions([])).toEqual({ ci: false, lockfile: null, nodeVersionPinned: false, formatterConfig: false });
    expect(detectConventions([".github/workflows/ci.yml", "yarn.lock", ".nvmrc", ".prettierrc.json"])).toEqual({ ci: true, lockfile: "yarn.lock", nodeVersionPinned: true, formatterConfig: true });
  });
});

const rep = (commands: unknown[], commit = SHA): unknown => ({ schemaVersion: 1, commit, commands, conventions: { ci: true, lockfile: null, nodeVersionPinned: null, formatterConfig: false } });
const run = (kind: string, command: string, exitCode: number | null) => ({ kind, command, source: "package.json", exitCode, durationMs: exitCode === null ? null : 10, ...(exitCode === null ? { skipped: "not run" } : {}) });

describe("#115: validateReport", () => {
  it("accepts a well-formed report and rejects, not repairs, malformed ones", () => {
    expect(validateReport(rep([run("test", "npm test", 0)])).ok).toBe(true);
    expect(validateReport({ ...(rep([]) as object), extra: 1 }).ok).toBe(false);
    expect(validateReport(rep([], "abc")).ok).toBe(false);
    expect(validateReport(rep([run("deploy", "x", 0)])).ok).toBe(false);
    expect(validateReport(rep([{ ...run("test", "npm test", null), skipped: undefined }])).ok).toBe(false);
    expect(validateReport(rep([{ ...run("test", "npm test", 0), exitCode: "0" }])).ok).toBe(false);
    expect(validateReport({ ...(rep([]) as object), inferredCharter: { goal: "x" } }).ok).toBe(false);
    expect(validateReport({ ...(rep([]) as object), conventions: { ci: "yes", lockfile: null, nodeVersionPinned: null, formatterConfig: null } }).ok).toBe(false);
  });
});

describe("#115: baseline round trip", () => {
  const v = (x: unknown): AdoptionReport => { const r = validateReport(x); if (!r.ok) throw new Error(r.error); return r.report; };
  it("separates regressions from pre-existing failures, and never counts an unrun command", () => {
    const prev = v(rep([run("test", "npm test", 0), run("lint", "npm run lint", 1), run("build", "npm run build", 0), run("install", "npm ci", null), run("test", "make test", 0)]));
    const next = v(rep([run("test", "npm test", 1), run("lint", "npm run lint", 1), run("build", "npm run build", 0), run("install", "npm ci", 1), run("test", "pytest -q", 0)], "b".repeat(40)));
    expect(diffBaseline(prev, next)).toEqual({ commitChanged: true, regressed: ["test:npm test"], fixed: [], stillFailing: ["lint:npm run lint"], added: ["test:pytest -q"], removed: ["test:make test"] });
  });
});
