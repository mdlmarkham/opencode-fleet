/**
 * Deterministic core of `fleet_project_adopt` (issue #115): what can be decided about an existing repo
 * WITHOUT a model and without running anything, so every claim in an adoption report is checkable.
 *
 *  - detectCommands: install/build/test/lint candidates read from known manifest files, each with the
 *    file it came from (evidence), never invented.
 *  - screenCommand: a command is runnable only when it has a plain shape (a known runner + plain
 *    arguments). `curl ... | sh`, command chains, redirections and substitutions are REPORTED, not run.
 *  - detectConventions: CI present, lockfiles, version pins; each `true | false | null` where null means
 *    "could not tell", never "none".
 *  - validateReport: strict; unknown keys and wrong types are rejected, not repaired.
 *  - diffBaseline: re-run adopt later and diff against the recorded baseline.
 *
 * Repo text is untrusted data throughout: nothing here executes it or follows instructions in it.
 */

export type CommandKind = "install" | "build" | "test" | "lint";
export interface CommandCandidate {
  kind: CommandKind;
  command: string;
  /** The file the command was read from (evidence). */
  source: string;
  /** What the runner would actually execute (a package.json script, a Makefile recipe), when known. */
  body?: string;
}

const RUNNERS: Record<string, CommandKind> = { install: "install", ci: "install", build: "build", compile: "build", test: "test", lint: "lint" };

/** Read candidates from package.json scripts, Makefile targets, and well-known toolchain files. */
export function detectCommands(files: Record<string, string | undefined>): CommandCandidate[] {
  const out: CommandCandidate[] = [];
  const pkgText = files["package.json"];
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown>; packageManager?: unknown };
      const pm = typeof pkg.packageManager === "string" && /^(pnpm|yarn)@/.test(pkg.packageManager) ? pkg.packageManager.split("@")[0]! : files["pnpm-lock.yaml"] !== undefined ? "pnpm" : files["yarn.lock"] !== undefined ? "yarn" : "npm";
      if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const name of Object.keys(pkg.scripts)) {
          const kind = RUNNERS[name];
          if (kind && kind !== "install" && typeof pkg.scripts[name] === "string") out.push({ kind, command: name === "test" ? `${pm} test` : `${pm} run ${name}`, source: "package.json", body: pkg.scripts[name] as string });
        }
      }
      out.push({ kind: "install", command: pm === "npm" ? (files["package-lock.json"] !== undefined ? "npm ci" : "npm install") : `${pm} install`, source: "package.json" });
    } catch { /* unparseable: reported by the caller as unknown, not guessed */ }
  }
  const make = files["Makefile"];
  if (make !== undefined) {
    for (const m of make.matchAll(/^([A-Za-z][\w-]*):(?!=)[^\n]*((?:\n\t[^\n]*)*)/gm)) {
      const kind = RUNNERS[m[1]!];
      if (kind && kind !== "install") out.push({ kind, command: `make ${m[1]}`, source: "Makefile", body: m[2]!.trim() });
    }
  }
  if (files["Cargo.toml"] !== undefined) out.push({ kind: "build", command: "cargo build", source: "Cargo.toml" }, { kind: "test", command: "cargo test", source: "Cargo.toml" });
  if (files["go.mod"] !== undefined) out.push({ kind: "build", command: "go build ./...", source: "go.mod" }, { kind: "test", command: "go test ./...", source: "go.mod" });
  if (files["pyproject.toml"] !== undefined || files["pytest.ini"] !== undefined || files["tox.ini"] !== undefined) {
    out.push({ kind: "test", command: "pytest -q", source: files["pytest.ini"] !== undefined ? "pytest.ini" : files["pyproject.toml"] !== undefined ? "pyproject.toml" : "tox.ini" });
  }
  return out;
}

export type Screen = { runnable: true } | { runnable: false; reason: string };

const SAFE_RUN = /^(?:(?:npm|pnpm|yarn) (?:ci|install|test|run [A-Za-z0-9:_-]+)|make [A-Za-z0-9_-]+|cargo (?:build|test|clippy)|go (?:build|test|vet) \.\/\.\.\.|pytest(?: -[A-Za-z]+)*(?: [A-Za-z0-9_./-]+)*|tox)$/;
const DANGEROUS = /\|\s*(?:sh|bash|zsh)\b|\b(?:curl|wget)\b|[;&|`<>]|\$\(|\brm\s+-|\bsudo\b|\beval\b/;

const BODY_DANGEROUS = /\|\s*(?:sh|bash|zsh)\b|\b(?:curl|wget)\b|\bsudo\b|\beval\b|\brm\s+-[A-Za-z]*r/;

/** May this command be executed in the survey clone? The script body it would run is screened too. Anything else is reported as a finding instead. */
export function screenCommand(command: string, body?: string): Screen {
  if (body !== undefined && BODY_DANGEROUS.test(body)) return { runnable: false, reason: "its script downloads, pipes to a shell, escalates or deletes recursively; reported, not executed" };
  const c = command.trim();
  if (c === "" || c.length > 200) return { runnable: false, reason: "empty or too long" };
  if (DANGEROUS.test(c)) return { runnable: false, reason: "contains a download, pipe, chain, redirection or privileged call; reported, not executed" };
  if (!SAFE_RUN.test(c)) return { runnable: false, reason: "not a recognised plain runner invocation; reported, not executed" };
  return { runnable: true };
}

export interface Conventions {
  ci: boolean | null;
  lockfile: string | null;
  nodeVersionPinned: boolean | null;
  formatterConfig: boolean | null;
}

/** `null` means the file listing was not captured; an empty listing is a real "none". */
export function detectConventions(paths: string[] | null): Conventions {
  if (paths === null) return { ci: null, lockfile: null, nodeVersionPinned: null, formatterConfig: null };
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p));
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock"].find((l) => paths.includes(l));
  return {
    ci: has(/^\.github\/workflows\/.+\.ya?ml$/) || paths.includes(".gitlab-ci.yml") || has(/^\.circleci\//),
    lockfile: lock ?? null,
    nodeVersionPinned: has(/^\.(nvmrc|node-version|tool-versions)$/),
    formatterConfig: has(/^(\.prettierrc.*|\.editorconfig|rustfmt\.toml|\.clang-format|ruff\.toml|\.flake8)$/),
  };
}

/** What a command run produced; `exitCode` null = it was not run (see `skipped`). */
export interface CommandResult {
  kind: CommandKind;
  command: string;
  source: string;
  exitCode: number | null;
  durationMs: number | null;
  skipped?: string;
  outputTail?: string;
}

export interface AdoptionReport {
  schemaVersion: 1;
  /** The commit everything below was measured at. */
  commit: string;
  commands: CommandResult[];
  conventions: Conventions;
  /** Inferred, never confirmed. */
  inferredCharter?: { goal?: string; note: "inferred, needs confirmation" };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KINDS: readonly string[] = ["install", "build", "test", "lint"];

export type ValidReport = { ok: true; report: AdoptionReport } | { ok: false; error: string };

/** Strict validation: unknown keys and wrong types are rejected, never repaired. */
export function validateReport(raw: unknown): ValidReport {
  if (!isRec(raw)) return { ok: false, error: "report must be an object" };
  const allowed = new Set(["schemaVersion", "commit", "commands", "conventions", "inferredCharter"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) return { ok: false, error: `unknown key "${k}"` };
  if (raw.schemaVersion !== 1) return { ok: false, error: "schemaVersion must be 1" };
  if (typeof raw.commit !== "string" || !/^[0-9a-f]{40}$/.test(raw.commit)) return { ok: false, error: "commit must be the full 40-hex sha the survey ran at" };
  if (!Array.isArray(raw.commands) || raw.commands.length > 50) return { ok: false, error: "commands must be an array of at most 50" };
  const commands: CommandResult[] = [];
  for (const [i, c] of raw.commands.entries()) {
    if (!isRec(c) || !KINDS.includes(String(c.kind)) || typeof c.command !== "string" || typeof c.source !== "string") return { ok: false, error: `commands[${i}] needs kind, command, source` };
    for (const k of Object.keys(c)) if (!["kind", "command", "source", "exitCode", "durationMs", "skipped", "outputTail"].includes(k)) return { ok: false, error: `commands[${i}]: unknown key "${k}"` };
    if (c.exitCode !== null && (typeof c.exitCode !== "number" || !Number.isInteger(c.exitCode))) return { ok: false, error: `commands[${i}].exitCode must be an integer or null (null = not run)` };
    if (c.durationMs !== null && (typeof c.durationMs !== "number" || c.durationMs < 0)) return { ok: false, error: `commands[${i}].durationMs must be >= 0 or null` };
    if (c.exitCode === null && typeof c.skipped !== "string") return { ok: false, error: `commands[${i}]: a command that was not run must say why (skipped)` };
    commands.push({ kind: c.kind as CommandKind, command: c.command.slice(0, 200), source: c.source.slice(0, 200), exitCode: c.exitCode as number | null, durationMs: c.durationMs as number | null, ...(typeof c.skipped === "string" ? { skipped: c.skipped.slice(0, 200) } : {}), ...(typeof c.outputTail === "string" ? { outputTail: c.outputTail.slice(-1500) } : {}) });
  }
  const cv = raw.conventions;
  if (!isRec(cv)) return { ok: false, error: "conventions must be an object" };
  for (const k of ["ci", "nodeVersionPinned", "formatterConfig"]) if (cv[k] !== null && typeof cv[k] !== "boolean") return { ok: false, error: `conventions.${k} must be true, false or null` };
  if (cv.lockfile !== null && typeof cv.lockfile !== "string") return { ok: false, error: "conventions.lockfile must be a string or null" };
  let inferredCharter: AdoptionReport["inferredCharter"];
  if (raw.inferredCharter !== undefined) {
    const ic = raw.inferredCharter;
    if (!isRec(ic) || ic.note !== "inferred, needs confirmation") return { ok: false, error: 'inferredCharter must carry note "inferred, needs confirmation"' };
    inferredCharter = { note: "inferred, needs confirmation", ...(typeof ic.goal === "string" ? { goal: ic.goal.slice(0, 500) } : {}) };
  }
  return { ok: true, report: { schemaVersion: 1, commit: raw.commit, commands, conventions: cv as unknown as Conventions, ...(inferredCharter ? { inferredCharter } : {}) } };
}

export interface BaselineDiff {
  commitChanged: boolean;
  /** Passing then, failing now: the regressions a later change may be blamed for. */
  regressed: string[];
  fixed: string[];
  /** Failing in both: pre-existing, not to be blamed on new work. */
  stillFailing: string[];
  added: string[];
  removed: string[];
}

const passed = (c: CommandResult): boolean | null => (c.exitCode === null ? null : c.exitCode === 0);

/** Diff two reports by command; a command that was not run in either is never counted as passing or failing. */
export function diffBaseline(prev: AdoptionReport, next: AdoptionReport): BaselineDiff {
  const key = (c: CommandResult): string => `${c.kind}:${c.command}`;
  const a = new Map(prev.commands.map((c) => [key(c), c]));
  const b = new Map(next.commands.map((c) => [key(c), c]));
  const d: BaselineDiff = { commitChanged: prev.commit !== next.commit, regressed: [], fixed: [], stillFailing: [], added: [], removed: [] };
  for (const [k, n] of b) {
    const o = a.get(k);
    if (!o) { d.added.push(k); continue; }
    const [po, pn] = [passed(o), passed(n)];
    if (po === true && pn === false) d.regressed.push(k);
    else if (po === false && pn === true) d.fixed.push(k);
    else if (po === false && pn === false) d.stillFailing.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) d.removed.push(k);
  return d;
}
