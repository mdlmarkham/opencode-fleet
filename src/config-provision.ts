/**
 * Config provisioning — ship agent definitions, skills, and global rules to
 * workers so they work consistently with the manager.
 *
 * The manager holds the source-of-truth config (in the plugin repo or a config
 * dir). Workers get it via SSH (manager has access), no worker credentials
 * needed.
 *
 * OpenCode config locations on each node:
 *  - Agents (markdown): ~/.config/opencode/agents/*.md
 *  - Global rules:      ~/.config/opencode/AGENTS.md
 *  - Skills:            ~/.claude/skills/ (Claude Code compat) or OpenCode skills
 *  - opencode.json:     ~/.config/opencode/opencode.json
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { SSH_ARGS, scpPrefix, scpRemote, sshPrefix } from "./ssh.js";
import { mergePermissionBlock, type PermissionConfig } from "./deny-baseline.js";
import { parse as parseYaml } from "yaml";

const execFileP = promisify(execFile);

export interface ConfigProvisionRequest {
  /** Local dir containing agent markdown files to ship (optional). */
  agentsDir?: string;
  /** Local global AGENTS.md to ship (optional). */
  globalRulesFile?: string;
  /** Local skills dir to ship (optional). */
  skillsDir?: string;
  /** Local opencode.json to ship (optional). */
  opencodeConfigFile?: string;
  /**
   * Opt-in (issue #51 slice 2): after shipping, merge the node-side deny-rule
   * baseline into the node's existing ~/.config/opencode/opencode.json.
   * Merge-only (never replaces unrelated keys), idempotent; default false so
   * provisioning behavior is unchanged.
   */
  installDenyBaseline?: boolean;
}

export interface ConfigProvisionResult {
  ok: boolean;
  agents?: string[];
  globalRules?: boolean;
  skills?: string[];
  opencodeConfig?: boolean;
  /** Set when the deny baseline was merged into the node's opencode.json. */
  denyBaselineInstalled?: boolean;
  error?: string;
}

/** Remote shell script: merge the deny baseline into the node's opencode.json. */
function baselineInstallScript(): string {
  // POSIX sh + node -e: reads the existing config (if any), merges, writes
  // back atomically. Fail-safe means REFUSE, not destroy (issue #51 review):
  // an unparseable config is left untouched and reported as an error — we do
  // not overwrite the operator's providers/credentials because of a stray
  // comma. The previous content is also backed up to a .bak first.
  const nodeScript = [
    'const fs=require("fs"),p=process.env.HOME+"/.config/opencode/opencode.json";',
    "let cur=null;",
    'try{cur=JSON.parse(fs.readFileSync(p,"utf8"));}catch(e){cur=null;}',
    "if(fs.existsSync(p)&&cur===null){process.stderr.write(\"FLEET_BASELINE_REFUSED: existing opencode.json is not valid JSON; left untouched\\n\");process.exit(3);}",
    'try{fs.copyFileSync(p,p+".bak");}catch(e){}',
    "const {mergeDenyBaseline}=require(process.argv[1]);",
    'fs.writeFileSync(p+".tmp",JSON.stringify(mergeDenyBaseline(cur),null,2)+"\\n");',
    'fs.renameSync(p+".tmp",p);',
  ].join(" ");
  return "mkdir -p ~/.config/opencode && node -e " + JSON.stringify(nodeScript) +
    ' "$HOME/.config/opencode/fleet-deny-baseline.cjs"';
}

/** Emit the baseline data as a copyable CJS module (no imports, pure data). */
export async function buildBaselineModule(): Promise<string> {
  const { BASELINE_DENY } = await import("./deny-baseline.js");
  // Deny maps are frozen plain objects, so JSON.stringify carries them as-is.
  const cats = Object.entries(BASELINE_DENY)
    .map(([cat, denies]) => {
      const pairs = Object.entries(denies)
        .map(([p, a]) => JSON.stringify(p) + ": " + JSON.stringify(a))
        .join(", ");
      return JSON.stringify(cat) + ": {" + pairs + "}";
    })
    .join(", ");
  const MERGE_FN = [
    "module.exports.mergeDenyBaseline = function mergeDenyBaseline(existing) {",
    '  var isRec = function (v) { return v !== null && typeof v === "object" && !Array.isArray(v); };',
    "  var src = isRec(existing) ? existing : {};",
    "  var srcPerm = isRec(src.permission) ? src.permission : {};",
    "  var base = module.exports.baselineDeny;",
    "  var permission = {};",
    "  var out = Object.assign({}, src, { permission: permission });",
    "  for (var cat in srcPerm) {",
    '    if (!Object.prototype.hasOwnProperty.call(srcPerm, cat)) continue;',
    "    var val = srcPerm[cat];",
    "    if (isRec(val)) permission[cat] = Object.assign({}, val);",
    "    else permission[cat] = val;",
    "  }",
    "  var keys = Object.keys(base);",
    "  for (var i = 0; i < keys.length; i++) {",
    "    var cat2 = keys[i];",
    "    var denies = base[cat2];",
    "    var ex = srcPerm[cat2];",
    '    if (typeof ex === "string") {',
    '      if (ex === "deny") { permission[cat2] = "deny"; continue; }',
    '      if (ex === "allow" || ex === "ask") {',
    '        var m = { "*": ex };',
    "        for (var p in denies) m[p] = denies[p];",
    "        permission[cat2] = m;",
    "        continue;",
    "      }",
    "      permission[cat2] = Object.assign({}, denies);",
    "      continue;",
    "    }",
    "    if (isRec(ex)) {",
    "      var m2 = {};",
    '      var set = function (o, k, v) { if (k !== "__proto__") o[k] = v; };',
    "      var bKeys = Object.keys(denies);",
    "      var j;",
    "      for (var k2 in ex) {",
    "        if (!Object.prototype.hasOwnProperty.call(ex, k2)) continue;",
    "        if (bKeys.indexOf(k2) !== -1) continue;",
    "        var v2 = ex[k2];",
    "        if (isRec(v2)) set(m2, k2, Object.assign({}, v2));",
    "        else set(m2, k2, v2);",
    "      }",
    "      for (j = 0; j < bKeys.length; j++) set(m2, bKeys[j], denies[bKeys[j]]);",
    "      permission[cat2] = m2;",
    "      continue;",
    "    }",
    "    permission[cat2] = Object.assign({}, denies);",
    "  }",
    "  return out;",
    "};",
    "",
  ].join("\n");
  return "module.exports.baselineDeny = { " + cats + " };\n" + MERGE_FN;
}

/** Push the baseline module to the node, then merge it into its opencode.json. */
async function installDenyBaselineOnNode(
  nodeHost: string,
  remotePath: string,
): Promise<void> {
  const mod = await buildBaselineModule();
  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-baseline-"));
  const localMod = join(tmpDir, "fleet-deny-baseline.cjs");
  try {
    await writeFile(localMod, mod, "utf8");
    await execFileP("scp", [...scpPrefix(), localMod, scpRemote(nodeHost, remotePath)], {
      timeout: 30_000,
    });
    await execFileP(
      "ssh",
      [...sshPrefix(nodeHost, SSH_ARGS), baselineInstallScript()],
      { timeout: 60_000 },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Issue #258: re-assert the deny baseline LAST in the agent-markdown layer —
// the other permission-bearing config layer the node writes.
// ---------------------------------------------------------------------------

/**
 * Issue #258: extract the `permission:` block from an agent markdown file's
 * frontmatter (the node-written layer config-provision ships). Returns null
 * when the file has no frontmatter or no permission block. Pure.
 */
export function extractAgentPermissions(md: string): PermissionConfig | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  try {
        const doc = parseYaml(m[1]) as Record<string, unknown> | null;
    const perm = doc && typeof doc === "object" && !Array.isArray(doc) ? doc["permission"] : undefined;
    return perm && typeof perm === "object" && !Array.isArray(perm) ? (perm as PermissionConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Issue #258: serialize a permission block back into a frontmatter-style YAML
 * fragment (2-space indent, double-quoted keys/values) that a YAML parser
 * reads back as exactly `block`. Pattern keys are quoted so globs like `*`
 * and `**` parse as strings, never aliases.
 */
function permissionBlockToYaml(block: PermissionConfig, indent: string): string {
  const q = (s: string): string => JSON.stringify(s);
  const lines: string[] = [];
  for (const [cat, entry] of Object.entries(block)) {
    if (typeof entry === "string") {
      lines.push(`${indent}${q(cat)}: ${q(entry)}`);
      continue;
    }
    lines.push(`${indent}${q(cat)}:`);
    for (const [p, a] of Object.entries(entry)) lines.push(`${indent}  ${q(p)}: ${q(a)}`);
  }
  return lines.join("\n");
}

/**
 * Issue #258: rewrite one agent markdown file so its frontmatter permission
 * block (when any) ends with the deny-baseline patterns LAST — the same
 * order-safe semantics as mergePermissionBlock, which is used on the parsed
 * block. Non-permission frontmatter keys are preserved (round-tripped through
 * the same YAML parser, so the emitted fragment parses back to them).
 * Pure: returns a new string; the input is untouched.
 */
export function rewriteAgentMarkdown(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n(\r?\n?---)/.exec(md);
  if (!m) return md;
  try {
        const doc = parseYaml(m[1]);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return md;
    const rest = doc as Record<string, unknown>;
    const perm = rest["permission"];
    if (!perm || typeof perm !== "object" || Array.isArray(perm)) return md;
    const reasserted = mergePermissionBlock(perm);
    // Re-serialize ONLY the permission block (order-safe) and preserve every
    // other key by rendering the doc with permission removed, then appending
    // the re-asserted block last.
    const other = { ...rest };
    delete other["permission"];
    const head: string[] = [];
    for (const [k, v] of Object.entries(other)) head.push(yamlScalarOrMap(k, v));
    const yamlText = [...head.map((l) => l.replace(/\n+$/, "")), "permission:", permissionBlockToYaml(reasserted, "  ").split("\n").map((l) => "  " + l).join("\n")].filter(Boolean).join("\n");
    return `---\n${yamlText}\n---` + md.slice(m[0].length);
  } catch {
    return md; // unparseable frontmatter: ship verbatim (fail-safe, as today)
  }
}

/** YAML-serialize a scalar, or a one-level map/array of scalars, for frontmatter. */
function yamlScalarOrMap(key: string, value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `${JSON.stringify(key)}: ${value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value)}`;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? `  - ${JSON.stringify(String(v))}` : "")).filter(Boolean).join("\n");
    return items ? `${JSON.stringify(key)}:\n${items}` : `${JSON.stringify(key)}: []`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k2, v2]) => {
        if (v2 === null || typeof v2 === "string" || typeof v2 === "number" || typeof v2 === "boolean") {
          return `  ${JSON.stringify(k2)}: ${v2 === null ? "null" : typeof v2 === "string" ? JSON.stringify(v2) : String(v2)}`;
        }
        return ""; // nested structures are not agent frontmatter as shipped; dropped keys would corrupt semantics, so bail below
      })
      .filter(Boolean);
    if (entries.length === Object.entries(value as Record<string, unknown>).length) {
      return entries.length ? `${JSON.stringify(key)}:\n${entries.join("\n")}` : `${JSON.stringify(key)}: {}`;
    }
  }
  // Unsupported shape: no safe textual rendering — fall back to verbatim file.
  throw new Error("unsupported frontmatter shape");
}

/**
 * Ship config files to a node via scp + ssh. Returns what was provisioned.
 */
export async function provisionConfigToNode(
  nodeHost: string,
  req: ConfigProvisionRequest,
): Promise<ConfigProvisionResult> {
  const result: ConfigProvisionResult = { ok: true };
  try {
    // Ensure remote config dirs exist.
    await execFileP(
      "ssh",
      [...sshPrefix(nodeHost, SSH_ARGS), `mkdir -p ~/.config/opencode/agents ~/.claude/skills`],
      { timeout: 30_000 },
    );

    // Ship agent markdown files.
    if (req.agentsDir) {
      const files = await readdir(req.agentsDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      result.agents = [];
      for (const f of mdFiles) {
        const local = join(req.agentsDir, f);
        const remote = `~/.config/opencode/agents/${f}`;
        // Issue #258: when the deny-baseline install is opted into, the
        // shipped agent markdown's permission block ALSO ends with the
        // baseline denies LAST (same helper lineage as the opencode.json
        // merge). With the opt-in off the file ships byte-identical to before.
        let shipLocal = local;
        let tmpRewritten: string | undefined;
        if (req.installDenyBaseline === true) {
          try {
            const original = await readFile(local, "utf8");
            const rewritten = rewriteAgentMarkdown(original);
            if (rewritten !== original) {
              tmpRewritten = join(await mkdtemp(join(tmpdir(), "fleet-agent-")), f);
              await writeFile(tmpRewritten, rewritten, "utf8");
              shipLocal = tmpRewritten;
            }
          } catch {
            // Unreadable/unrewritable: ship verbatim (the pre-#258 behavior).
          }
        }
        try {
          await execFileP("scp", [...scpPrefix(), shipLocal, scpRemote(nodeHost, remote)], {
            timeout: 30_000,
          });
          result.agents.push(f);
        } finally {
          if (tmpRewritten) await rm(dirname(tmpRewritten), { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Ship global rules.
    if (req.globalRulesFile) {
      await execFileP(
        "scp",
        [...scpPrefix(), req.globalRulesFile, scpRemote(nodeHost, "~/.config/opencode/AGENTS.md")],
        { timeout: 30_000 },
      );
      result.globalRules = true;
    }

    // Ship skills.
    if (req.skillsDir) {
      const skills = await readdir(req.skillsDir);
      result.skills = [];
      for (const skill of skills) {
        const local = join(req.skillsDir, skill);
        const s = await stat(local);
        if (s.isDirectory()) {
          // Ship the whole skill dir.
          await execFileP(
            "scp",
            [...SSH_ARGS, "-r", "--", local, scpRemote(nodeHost, "~/.claude/skills/")],
            { timeout: 60_000 },
          );
          result.skills.push(skill);
        }
      }
    }

    // Ship opencode.json.
    if (req.opencodeConfigFile) {
      await execFileP(
        "scp",
        [...scpPrefix(), req.opencodeConfigFile, scpRemote(nodeHost, "~/.config/opencode/opencode.json")],
        { timeout: 30_000 },
      );
      result.opencodeConfig = true;
    }

    // Issue #51 slice 2: OPT-IN deny-baseline install. Merge-only against the
    // node's existing config: unrelated keys are preserved and re-running is
    // idempotent. Default (flag absent) leaves this whole block out — the
    // provisioning result is byte-identical to before.
    if (req.installDenyBaseline === true) {
      await installDenyBaselineOnNode(nodeHost, "~/.config/opencode/fleet-deny-baseline.cjs");
      result.denyBaselineInstalled = true;
    }

    return result;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Read the manager's local config dirs to discover what's available to ship.
 * Reports the search paths consulted and what was found/missed so a silent
 * no-op is impossible (issue #3).
 */
export async function discoverLocalConfig(
  baseDir: string,
): Promise<{
  agentsDir?: string;
  globalRulesFile?: string;
  skillsDir?: string;
  opencodeConfigFile?: string;
  report: { baseDir: string; searched: Record<string, string>; found: Record<string, boolean>; missing: string[] };
}> {
  const out: {
    agentsDir?: string;
    globalRulesFile?: string;
    skillsDir?: string;
    opencodeConfigFile?: string;
    report: { baseDir: string; searched: Record<string, string>; found: Record<string, boolean>; missing: string[] };
  } = {
    report: { baseDir, searched: {}, found: {}, missing: [] },
  };
  const agentsDir = join(baseDir, "agents");
  const skillsDir = join(baseDir, "skills");
  const globalRules = join(baseDir, "AGENTS.md");
  const opencodeConfig = join(baseDir, "opencode.json");
  out.report.searched = { agentsDir, skillsDir, globalRulesFile: globalRules, opencodeConfigFile: opencodeConfig };

  const check = (path: string, key: string, kind: "dir" | "file") => {
    try {
      const st = statSync(path);
      const hit = kind === "dir" ? st.isDirectory() : st.isFile();
      out.report.found[key] = hit;
      if (hit) (out as Record<string, unknown>)[key === "agents" ? "agentsDir" : key] = path;
      else out.report.missing.push(key);
      return hit;
    } catch {
      out.report.found[key] = false;
      out.report.missing.push(key);
      return false;
    }
  };
  if (check(agentsDir, "agentsDir", "dir")) out.agentsDir = agentsDir;
  if (check(skillsDir, "skillsDir", "dir")) out.skillsDir = skillsDir;
  if (check(globalRules, "globalRulesFile", "file")) out.globalRulesFile = globalRules;
  if (check(opencodeConfig, "opencodeConfigFile", "file")) out.opencodeConfigFile = opencodeConfig;
  return out;
}
