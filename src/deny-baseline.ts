/**
 * Node-side DENY-RULE BASELINE for unattended fleet workers — issue #51, slice 1.
 *
 * SLICE 1 SCOPE (this file only):
 *   1. `BASELINE_DENY`        — the deny floor as DATA in opencode's permission
 *                             schema shape, ready to be merged into a node's
 *                             opencode config (`permission` block).
 *   2. `mergeDenyBaseline()`  — pure merge of the baseline INTO a node config
 *                             (union of deny lists; never overwrites unrelated
 *                             keys; never drops a user rule that does not
 *                             conflict with a baseline denial).
 *   3. `baselinePresent()`    — pure structural check the slice-2 wiring will
 *                             report through fleet_capabilities.
 *   4. `detectAutoSupport()`  — pure predicate: does this node's opencode
 *                             support `opencode run --auto`?
 *
 * SLICE 2 (NOT here): wiring. Nothing in this slice touches dispatch, the node
 * handler, autoApprove, or any tool schema — no live path imports this module
 * yet, so default fleet behavior is byte-identical to before this file existed.
 *
 * WHY (unattended workers): a detached `opencode run` has no human to answer
 * "ask" prompts. `autoApprove` (issue #30 finding D) auto-approves every
 * NON-denied permission — its safety rests entirely on explicit DENY rules in
 * the node's opencode config. This baseline is that deny FLOOR: reviewable,
 * merge-only, and it can never be weaker than the operator's own rules.
 *
 * PRINCIPLES:
 *  - DENY-ONLY. Every entry the baseline contributes is exactly "deny"; the
 *    merge can only ADD refusals (or tighten a pattern the baseline denies,
 *    including an adversarial user ALLOW on that exact pattern, to deny). It
 *    can never flip any user rule from deny to allow/ask.
 *  - DATA, not code: a frozen const shaped like the `permission` block of
 *    opencode.json — action values ("allow"|"ask"|"deny") and per-category
 *    glob pattern maps — so an operator can inspect, diff, or paste it into a
 *    node config verbatim.
 *  - PURE: no I/O, no imports, no clock, no environment. `mergeDenyBaseline`
 *    returns a NEW object and never mutates its input; it is idempotent
 *    (merging twice deep-equals merging once).
 *  - A FLOOR, not a sandbox: the patterns are the canonical DIRECT spellings.
 *    Oblique variants (`cd /; rm -rf *`, `rm -rf "$HOME"`, `/usr/bin/curl`,
 *    heredocs/base64 pipelines) are deliberately not enumerated; defense in
 *    depth stays with the other layers (per-run isolation, sync publish
 *    policy, non-root service users, credential-free workers). The baseline
 *    raises the floor; it is not a permission sandbox.
 *
 * THE FOUR REQUIRED CATEGORIES (issue #51):
 *
 *  1. `external_directory` — denied WHOLESALE as data (`{"*": "deny",
 *     "**": "deny"}`). opencode's external-directory permission covers access
 *     to directories OUTSIDE the session's workspace root; paths inside the
 *     run cwd are not external-directory accesses. Denying the category in
 *     data therefore implements exactly "deny external_directory outside the
 *     run cwd" without encoding any runtime cwd.
 *
 *  2. Destructive shell patterns (`bash`):
 *       - `rm -rf` of NON-descendants of the cwd: absolute paths, parent
 *         traversal (`..`), the home tilde and `$HOME`, and
 *         `--no-preserve-root`, each plus the `sudo` spelling.
 *       - `git push` in its usual spellings. Workers publish through the
 *         manager (`fleet_sync`), never directly (issue #33 redirects direct
 *         pushes too; this makes the refusal hold at the node as well).
 *       - Download-to-shell: `curl ... | sh` / `wget ... | sh` (the `*sh*`
 *         tail also covers `| bash`, `|zsh`, `|sudo sh`, trailing-args).
 *       - Shell-wrapped download: `sh -c curl` / `sh -c wget` — the leading
 *         `*` also covers `bash -c ...` and `sudo sh -c ...`.
 *
 *  3. Reads of CREDENTIAL PATHS (`read`): `~/.ssh`, `~/.config/gh`, `~/.aws`,
 *     `~/.config/gcloud`, and the anywhere forms of `.netrc` / `.npmrc`
 *     (both carry bearer tokens wherever they sit; a project-local `.npmrc`
 *     is precisely the private-registry-token case). Three globs per home
 *     dir (dir, dir/*, dir/**) keep the deny robust across glob flavors.
 *     NOTE: a shell `cat` bypasses the `read` permission, so the direct shell
 *     spellings of reading these exact paths are also denied in `bash`.
 *
 *  4. Network EGRESS commands NOT needed for a coding task (`bash`): the raw
 *     download tools (curl, wget), interactive egress (ssh, scp, sftp, telnet,
 *     ftp), socket relays (nc/ncat/netcat, socat), and bash's /dev/tcp and
 *     /dev/udp redirect channels. The engine's `webfetch` tool is denied
 *     wholesale for the same reason. Deliberately NOT denied: package
 *     managers (npm/pip/cargo/...), which a coding task needs, and git's own
 *     network operations (fetch/pull/clone) — workers are provisioned
 *     credential-free and must be able to install dependencies and fetch
 *     history.
 *
 * CONFLICT SEMANTICS (the adversarial case in the tests): if the node config
 * allows/asks for something the baseline denies, the baseline WINS that exact
 * pattern (it becomes "deny", with no duplicate key introduced). A scalar
 * allow/ask becomes its true scope as a catch-all pattern and is tightened
 * wherever a baseline deny lands on the same catch-all (this is what makes
 * `external_directory: "allow"` fall to the baseline). A scalar "deny" for a
 * whole category already subsumes the baseline and is kept as-is. User rules
 * at patterns the baseline does not mention are preserved verbatim, as are
 * permission categories and top-level config keys the baseline does not
 * mention. Overlapping-but-distinct patterns (e.g. a user `~/shared/**: allow`
 * against the baseline catch-all deny) are BOTH kept; resolving overlaps is
 * opencode's matcher's business — this module only guarantees the deny data
 * is present and that deny-only never becomes allow/ask.
 */

// ---------------------------------------------------------------------------
// Schema shape (mirrors the permission block of opencode.json)
// ---------------------------------------------------------------------------

export type PermissionAction = "allow" | "ask" | "deny";

/** A permission category's entry: a single action, or glob pattern -> action. */
export type PermissionEntry = PermissionAction | Readonly<Record<string, PermissionAction>>;
export type PermissionConfig = Record<string, PermissionEntry>;

/**
 * A node's opencode config (the JSON the node loads). Only the `permission`
 * block is relevant here; all other keys are preserved untouched by the merge.
 */
export interface OpenCodeNodeConfig {
  permission?: PermissionConfig;
  [key: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Assignment of this key would set a prototype, not an own property. */
const PROTO_KEY = "__proto__";

// ---------------------------------------------------------------------------
// BASELINE_DENY — the deny floor, as pure data
// ---------------------------------------------------------------------------

/** Build a frozen deny-only pattern map. Every value is exactly "deny". */
const denyMap = (...patterns: string[]): Readonly<Record<string, PermissionAction>> => {
  const m = Object.create(null) as Record<string, PermissionAction>;
  for (const p of patterns) m[p] = "deny";
  return Object.freeze({ ...m });
};

export const BASELINE_DENY: Readonly<{
  external_directory: Readonly<Record<string, PermissionAction>>;
  bash: Readonly<Record<string, PermissionAction>>;
  read: Readonly<Record<string, PermissionAction>>;
  webfetch: Readonly<Record<string, PermissionAction>>;
}> = Object.freeze({
  /**
   * 1. Deny external-directory access wholesale. Anything outside the run cwd
   *    is "external" to opencode; the cwd itself never is, so in-cwd work is
   *    unaffected. (Data cannot name the runtime cwd, and need not.)
   */
  external_directory: denyMap("*", "**"),

  bash: denyMap(
    // 2a. `rm -rf` of NON-descendants: absolute paths, parent traversal, home
    //     tilde, $HOME, --no-preserve-root; plus the `sudo` spellings.
    "rm -rf /*", "rm -fr /*",
    "rm -rf ..*", "rm -fr ..*",
    "rm -rf ~*", "rm -fr ~*",
    "rm -rf $HOME*", "rm -fr $HOME*",
    "rm -rf --no-preserve-root*", "rm -fr --no-preserve-root*",
    "sudo rm -rf /*", "sudo rm -fr /*",
    "sudo rm -rf ..*", "sudo rm -fr ..*",
    "sudo rm -rf ~*", "sudo rm -fr ~*",
    // 2b. `git push` — workers publish via the manager (fleet_sync), never
    //     directly. (Flag-position and force variants collapse into these.)
    "git push*", "git -C*push*", "sudo git push*",
    // 2c. Download-to-shell: `curl|sh` and `wget|sh` (pipe-adjacent shell;
    //     *sh* covers bash/zsh/dash/ksh/fish/sudo-sh and `| sh -s -- foo`).
    "curl*|*sh*", "wget*|*sh*",
    // 2d. Shell-wrapped downloads: `sh -c curl`; leading * covers
    //     `bash -c ...` and `sudo sh -c ...` ("bash" contains "sh -c").
    "*sh -c*curl*", "*sh -c*wget*",
    // 4c. bash's raw TCP/UDP egress channel via /dev/tcp, /dev/udp
    //     (`exec 3<>/dev/tcp/host/port`, `... >&/dev/tcp/...`).
    "*>*dev/tcp*", "*>*dev/udp*",
    // 3b. Direct shell spellings of READING the credential paths of category
    //     3 (a shell cat bypasses the `read` permission). Complements, not
    //     replaces, the `read` categories below.
    "cat *~/.ssh*", "cat *~/.aws*", "cat *~/.config/gh*", "cat *~/.config/gcloud*",
    "cat *netrc*", "cat *npmrc*",
    // 4a. Network egress commands not needed for a coding task: raw download
    //     tools, node-to-node egress (ssh/scp/sftp), and socket relays.
    //     NOT denied on purpose: package managers (npm/pip/cargo/...) and
    //     git fetch/pull/clone — a coding task needs those.
    "curl*", "wget*",
    "ssh *", "scp *", "sftp *",
    "nc *", "ncat *", "netcat *",
    "socat *", "telnet *", "ftp *",
  ),

  read: denyMap(
    // 3a. Credential paths: the SSH agent's keys and known hosts, the gh CLI
    //     login token, AWS credentials, gcloud credentials, and the two
    //     token-bearing dotfiles (.netrc, .npmrc) in their home location AND
    //     anywhere else (**/. for project-local .npmrc/.netrc).
    "~/.ssh", "~/.ssh/*", "~/.ssh/**",
    "~/.config/gh", "~/.config/gh/*", "~/.config/gh/**",
    "~/.aws", "~/.aws/*", "~/.aws/**",
    "~/.config/gcloud", "~/.config/gcloud/*", "~/.config/gcloud/**",
    "~/.netrc", "**/.netrc",
    "~/.npmrc", "**/.npmrc",
  ),

  /**
   * 4b. The engine's own fetch tool is denied wholesale: a detached worker
   *     fetching arbitrary URLs is egress, and anything a setup/dependency
   *     step needs flows through package managers (not denied) or the
   *     provisioning channel.
   */
  webfetch: denyMap("*"),
});

// ---------------------------------------------------------------------------
// mergeDenyBaseline — union of deny lists into a node config
// ---------------------------------------------------------------------------

/** Write a pattern/action pair into a map, skipping prototype-magic keys. */
function safeSet(m: Record<string, PermissionAction>, key: string, value: PermissionAction): void {
  if (key === PROTO_KEY) return;
  m[key] = value;
}

/**
 * Merge ONE permission category with the baseline's deny map.
 *  - existing "deny"            → kept (subsumes every baseline pattern).
 *  - existing "allow"/"ask"     → re-expressed at its true scope (a catch-all
 *    pattern) and tightened wherever a baseline deny lands on the same
 *    pattern — the BASELINE WINS the denied patterns (see header).
 *  - existing pattern map       → user entries preserved verbatim (cloned;
 *    prototype-magic keys skipped), then every baseline pattern set to "deny"
 *    an exact-pattern conflict (e.g. user `{"git push*": "allow"}`) resolves
 *    to deny, with no duplicate key.
 *  - anything else (absent or malformed) → the baseline itself (deny-only,
 *    fail-safe).
 */
function mergeCategory(existing: unknown, baselineDenies: Readonly<Record<string, PermissionAction>>): PermissionEntry {
  if (typeof existing === "string") {
    if (existing === "deny") return "deny";
    if (existing === "allow" || existing === "ask") {
      const m: Record<string, PermissionAction> = Object.create(null);
      safeSet(m, "*", existing);
      for (const [p, d] of Object.entries(baselineDenies)) safeSet(m, p, d);
      return Object.assign({}, m); // plain-prototype copy for JSON round-trips
    }
    return { ...baselineDenies }; // malformed action → baseline
  }
  if (isRecord(existing)) {
    const m: Record<string, PermissionAction> = Object.create(null);
    for (const [k, v] of Object.entries(existing)) {
      if (k === PROTO_KEY) continue; // a JSON-parsed config cannot legitimately carry this
      if (typeof v === "string" && (v === "allow" || v === "ask" || v === "deny")) safeSet(m, k, v);
      else (m as unknown as Record<string, unknown>)[k] = isRecord(v) ? { ...v } : v; // user value kept verbatim (cloned); never dropped
    }
    for (const [p, d] of Object.entries(baselineDenies)) safeSet(m, p, d);
    return Object.assign({}, m);
  }
  return { ...baselineDenies };
}

/**
 * Return the node config with the deny baseline MERGED IN. PURE: a new object
 * is returned and `existing` is never mutated. IDEMPOTENT:
 * mergeDenyBaseline(mergeDenyBaseline(c)) deep-equals mergeDenyBaseline(c).
 *
 * Guarantees:
 *  - every baseline pattern ends up "deny" under its category — including
 *    for an existing, CONFLICTING allow/ask on that exact pattern;
 *  - a whole-category scalar "deny" is kept (it subsumes the baseline);
 *  - user rules at other patterns, other permission categories, and every
 *    unrelated top-level key are preserved verbatim (shallow-cloned so the
 *    returned config is independently mutable);
 *  - a malformed `permission` block (or malformed config) contributes nothing
 *    and is replaced by the deny-only baseline — fail-safe, never weaker.
 *  - no duplicates: object keys are unique by construction, and merging never
 *    re-adds a pattern that is already there (it is a union).
 */
export function mergeDenyBaseline(existing?: unknown): OpenCodeNodeConfig {
  const src = isRecord(existing) ? existing : {};
  const srcPermission = isRecord(src["permission"]) ? src["permission"] : {};

  const permission: Record<string, PermissionEntry> = {};
  const out: OpenCodeNodeConfig = { ...src, permission };

  // User categories the baseline does not mention: copied verbatim (maps
  // shallow-cloned so the returned config is independently mutable).
  for (const [cat, val] of Object.entries(srcPermission)) {
    if (cat === PROTO_KEY) continue;
    if (isRecord(val)) permission[cat] = { ...val } as PermissionEntry;
    else permission[cat] = val as PermissionEntry;
  }

  // Baseline categories: merge (union of deny lists).
  for (const [cat, denies] of Object.entries(BASELINE_DENY)) {
    permission[cat] = mergeCategory(srcPermission[cat], denies);
  }

  return out;
}

// ---------------------------------------------------------------------------
// baselinePresent — structural detection of the baseline (for fleet_capabilities)
// ---------------------------------------------------------------------------

/**
 * True when `nodeConfig.permission` contains the ENTIRE baseline: for every
 * baseline category, either a scalar "deny" (subsumes the category) or a
 * pattern map in which EVERY baseline pattern evaluates to exactly "deny".
 * Anything else — absent category, ask/allow, a missing pattern, malformed
 * data, or a non-object config — is false. Pure.
 */
export function baselinePresent(nodeConfig: unknown): boolean {
  if (!isRecord(nodeConfig)) return false;
  const perm = nodeConfig["permission"];
  if (!isRecord(perm)) return false;
  for (const [cat, denies] of Object.entries(BASELINE_DENY)) {
    const entry = perm[cat];
    if (entry === "deny") continue; // scalar deny covers the category
    if (!isRecord(entry)) return false; // absent / ask / allow / malformed
    for (const pattern of Object.keys(denies)) {
      if (entry[pattern] !== "deny") return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// detectAutoSupport — does this node's opencode support `opencode run --auto`?
// ---------------------------------------------------------------------------

/**
 * The minimum opencode version assumed to support `opencode run --auto`.
 * Anchored to the only live-verified support evidence in the fleet (issue #30:
 * dev2 at opencode 1.18.26 runs `opencode run --auto`); anything below must
 * rely on the --help signal instead. Conservative on purpose — tune this const
 * if older builds are later verified; there is no way to know when the flag
 * landed without that evidence.
 */
export const AUTO_SUPPORT_MIN_VERSION = "1.18.0";

/** A probe of what a node reports about its opencode build. No I/O here. */
export interface AutoSupportProbe {
  /** stdout of `opencode --version` (any banner shape is tolerated). */
  version?: unknown;
  /** stdout/text of `opencode run --help`. */
  helpText?: unknown;
}

/** The version threshold, parsed ("1.18.0"). */
const MIN_VERSION_TUPLE: readonly [number, number, number] = [1, 18, 0];

/**
 * Parse the first dotted numeric version run in a string:
 *   "1.18.26" → [1,18,26]; "opencode 1.18.26 (2026-05-10)" → [1,18,26];
 *   "v0.4.2" → [0,4,2]; "1.2.3-rc.1" → [1,2,3]. Unparseable/absent → null.
 */
function parseVersionTuple(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  return [Number(m[1]), Number(m[2]), patch];
}

/** Word-bounded `--auto`: matches the flag listing, NOT `--auto-approve`,
 *  `--autonomous`, `--automatic`, or `xx--auto`. */
const AUTO_FLAG_RE = /(?<![\w-])--auto(?![\w-])/;

/**
 * Pure predicate: does this node's opencode support appending `--auto` to
 * `opencode run`? TRUE when the help text plainly lists a word-bounded
 * `--auto` flag, OR the version string is >= AUTO_SUPPORT_MIN_VERSION.
 * FALSE for anything absent, too old, unparseable, or garbage — including a
 * probe that is not even an object. No I/O, no network, no commands.
 *
 * Conservative by design: a false negative (an old node reported unsupported)
 * degrades to today's default unattended posture; a false positive would
 * append an unparseable flag to the binary and kill the run.
 */
export function detectAutoSupport(probe: AutoSupportProbe): boolean {
  if (!isRecord(probe)) return false;
  const help = probe["helpText"];
  if (typeof help === "string" && AUTO_FLAG_RE.test(help)) return true;
  const v = parseVersionTuple(probe["version"]);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== MIN_VERSION_TUPLE[i]) return v[i] > MIN_VERSION_TUPLE[i];
  }
  return true;
}