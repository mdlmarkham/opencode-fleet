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
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

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
}

export interface ConfigProvisionResult {
  ok: boolean;
  agents?: string[];
  globalRules?: boolean;
  skills?: string[];
  opencodeConfig?: boolean;
  error?: string;
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
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", nodeHost, `mkdir -p ~/.config/opencode/agents ~/.claude/skills`],
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
        await execFileP("scp", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", local, `${nodeHost}:${remote}`], {
          timeout: 30_000,
        });
        result.agents.push(f);
      }
    }

    // Ship global rules.
    if (req.globalRulesFile) {
      await execFileP(
        "scp",
        ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", req.globalRulesFile, `${nodeHost}:~/.config/opencode/AGENTS.md`],
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
            ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-r", local, `${nodeHost}:~/.claude/skills/`],
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
        ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", req.opencodeConfigFile, `${nodeHost}:~/.config/opencode/opencode.json`],
        { timeout: 30_000 },
      );
      result.opencodeConfig = true;
    }

    return result;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Read the manager's local config dirs to discover what's available to ship.
 */
export async function discoverLocalConfig(
  baseDir: string,
): Promise<{ agentsDir?: string; globalRulesFile?: string; skillsDir?: string; opencodeConfigFile?: string }> {
  const out: { agentsDir?: string; globalRulesFile?: string; skillsDir?: string; opencodeConfigFile?: string } = {};
  const agentsDir = join(baseDir, "agents");
  const skillsDir = join(baseDir, "skills");
  const globalRules = join(baseDir, "AGENTS.md");
  const opencodeConfig = join(baseDir, "opencode.json");

  try {
    const a = await stat(agentsDir);
    if (a.isDirectory()) out.agentsDir = agentsDir;
  } catch {}
  try {
    const s = await stat(skillsDir);
    if (s.isDirectory()) out.skillsDir = skillsDir;
  } catch {}
  try {
    const g = await stat(globalRules);
    if (g.isFile()) out.globalRulesFile = globalRules;
  } catch {}
  try {
    const o = await stat(opencodeConfig);
    if (o.isFile()) out.opencodeConfigFile = opencodeConfig;
  } catch {}
  return out;
}
