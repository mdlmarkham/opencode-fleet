/**
 * Dispatch-time policy (issue #34): which environment variables a caller may
 * inject into a worker, and what a repo-declared `setup` may run.
 *
 * Both are channels by which text chosen by an agent (and so, indirectly, by
 * anything the agent has read) becomes code on a worker. The defaults close the
 * well-known injection vectors without breaking ordinary use; operators can
 * open the setup channel explicitly with `allowSetupCommands`.
 */

/** Names that execute code, redirect configuration, or weaken permissions when set in a child's environment. */
const DENY_EXACT = new Set([
  // process/loader basics (pre-existing)
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "TMPDIR",
  // shell startup / behaviour
  "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS", "IFS", "CDPATH", "GLOBIGNORE",
  // language runtimes: code run at startup
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONPATH",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  // tools that spawn programs
  "EDITOR", "VISUAL", "PAGER", "SSH_ASKPASS", "SSH_AUTH_SOCK", "SUDO_ASKPASS",
  // config redirection: would swap the worker's rules/permissions
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION",
  "PI_CODING_AGENT_DIR",
  // tools that run a program named in the environment
  "LESSOPEN", "LESSCLOSE", "MANPAGER", "BROWSER", "MAKEFLAGS", "MAKEFILES", "GOFLAGS", "GOROOT",
  "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
]);

/** Prefixes denied wholesale. */
const DENY_PREFIXES = ["LD_", "DYLD_", "GIT_CONFIG", "GIT_SSH", "BASH_FUNC_", "SUDO_", "CARGO_TARGET_", "NPM_CONFIG_SCRIPT", "NPM_CONFIG_NODE", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_USERCONFIG"];

/** Individual git variables that execute programs. */
const DENY_GIT = new Set([
  "GIT_EXEC_PATH", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_TEMPLATE_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
  "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY",
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Operator-supplied refinements (plugin config `env`). Built-in denials always win. */
export interface EnvPolicyOptions {
  /** When set, ONLY these names (exact, case-insensitive) may be injected. */
  allowOnly?: string[];
  /** Extra names to refuse, in addition to the built-in list. */
  extraDeny?: string[];
}

export function isEnvNameAllowed(name: string, opts: EnvPolicyOptions = {}): boolean {
  if (!NAME_RE.test(name)) return false;
  const up = name.toUpperCase();
  if (DENY_EXACT.has(up) || DENY_GIT.has(up)) return false;
  if (DENY_PREFIXES.some((p) => up.startsWith(p))) return false;
  if (opts.extraDeny?.some((d) => d.toUpperCase() === up)) return false;
  if (opts.allowOnly && !opts.allowOnly.some((a) => a.toUpperCase() === up)) return false;
  return true;
}

export interface EnvPartition {
  allowed: Record<string, string>;
  rejected: string[];
}

/**
 * Split a requested environment into what will be exported and the names
 * refused (never silently dropped). Null-prototype records so a name like
 * `__proto__` is an ordinary key rather than hitting the inherited setter.
 */
export function partitionEnv(env: Record<string, unknown> | undefined, opts: EnvPolicyOptions = {}): EnvPartition {
  const allowed: Record<string, string> = Object.create(null);
  const rejected: string[] = [];
  for (const k of Object.keys(env ?? {})) {
    const v = (env as Record<string, unknown>)[k];
    if (isEnvNameAllowed(k, opts) && typeof v !== "object") allowed[k] = String(v);
    else rejected.push(k);
  }
  return { allowed, rejected };
}

export type SetupCheck = { ok: true } | { ok: false; error: string };

/**
 * A safe setup is a repo-relative script PATH with optional plain arguments,
 * e.g. `scripts/setup.sh` or `./setup.sh --fast`. The first token must contain a
 * `/` so the shell runs the file in the checkout rather than resolving a bare
 * name through PATH (`sh -c id` would otherwise pass). No shell metacharacters,
 * no `..`, not absolute. Anything else needs `allowCommands`.
 */
const SCRIPT_RE = /^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.\/-]*(?: [A-Za-z0-9_.\/=:@+,-]+)*$/;

export function checkSetup(setup: string, allowCommands = false): SetupCheck {
  const s = setup.trim();
  if (!s) return { ok: true };
  if (allowCommands) return { ok: true };
  const script = s.split(" ")[0];
  if (!SCRIPT_RE.test(s) || !script.includes("/") || script.split("/").includes("..")) {
    return {
      ok: false,
      error:
        "setup must be a repo-relative script path containing a \"/\" with plain arguments (e.g. \"scripts/setup.sh\" or \"./setup.sh\"); " +
        "arbitrary shell commands require the operator to set allowSetupCommands in the plugin config",
    };
  }
  return { ok: true };
}
