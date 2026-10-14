# Where opencode and Pi load skills, agents and rules — live survey from dev3 (issue #111)

Survey of what the two engines this plugin dispatches to actually read from disk on a real node.
Everything here was executed on **dev3** (Linux 7.0.14-16-pve, node v24.21.0, user `svcuser`)
on 2026-10-11, with the versions under test:

- **opencode 1.18.25** (`opencode --version`)
- **pi 0.73.1** (`pi --version`, package `@mariozechner/pi-coding-agent` at
  `/usr/lib/node_modules/@mariozechner/pi-coding-agent`)

dev3 runs opencode **1.18.25**, one minor older than dev2's 1.18.26 — which is a feature: the
same evidence doubles as version-drift data for the `--auto` threshold (#170 item 4, #51).

Methods: the scripted capture (`scripts/opencode-capture.mjs`, verified with
`dist/opencode-verify-cli.js` — **11 confirmed, 0 missing, 0 unverifiable, exit 0**; frozen as
`src/testkit/oc-capture-dev3.json`), plus targeted manual probes on this node. Probe files lived
in `/tmp` or throwaway clones and were deleted after each check; nothing was left in shared home
dirs (see [Provisioning side effects](#provisioning-side-effects)). The capture ran as `svcuser`
(the task's `sudo -n -u svcuser` wrapper is unavailable on dev3 — svcuser is not in the sudoers
file — so the probes are the service user's own, which is the identity the plugin dispatches as
anyway; no root-run evidence is claimed).

## The table (engine × {skills, agents, rules})

| Engine | Skills | Agents | Rules |
|---|---|---|---|
| **opencode 1.18.25** | **Project:** `.opencode/skill/<n>/SKILL.md` and `.opencode/skills/<n>/SKILL.md` (confirmed: capture `debugSkill` lists a `fleetprobe` skill at `/tmp/oc-capture-*/.opencode/skill/fleetprobe/SKILL.md`). **Global:** `~/.config/opencode/skill(s)/<n>/SKILL.md` (confirmed via `HOME`-redirected run: a skill under `$HOME/.config/opencode/skill/zzgskill/SKILL.md` was discovered). **External, auto-loaded:** `~/.claude/skills/<n>/SKILL.md` and `~/.agents/skills/<n>/SKILL.md` (both confirmed on this version: creating each produced a hit in `opencode debug skill`; `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` / `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` skip them). Extra dirs via config `skills.paths[]` + `skills.urls[]`. **Format:** YAML frontmatter with required `name` (lowercase-hyphen, ≤64 chars, matching the folder) and `description` (skills without one are filtered out); optional `license`, `compatibility`, `metadata`. **Semantics:** names+descriptions are discovered at startup; the loader scans `**/SKILL.md`. | **Project:** `.opencode/agent/<n>.md` or `.opencode/agents/<n>.md` (confirmed: `opencode agent list` in the capture's throwaway project lists `fleetprobe (subagent)` at top level; plural dir also confirmed). **Global:** `~/.config/opencode/agent(s)/<n>.md` (confirmed via `HOME`-redirected run: `zzglobalprobe (subagent)` listed). **Inline:** `agent: { <name>: {...} }` in `opencode.json`. **Format:** YAML frontmatter (`description`, `mode: primary\|subagent\|all`, optional `model`, `permission`, `temperature`, …) + markdown body = the agent's prompt; allowed frontmatter keys pinned in the built-in skill (`name, model, variant, description, mode, hidden, color, steps, options, permission, disable, temperature, top_p`), unknown keys silently routed into `options`. Built-ins: `build`, `plan`, `general`, `explore` (+ hidden `compaction`, `title`, `summary`). | **Project:** `AGENTS.md` at the cwd and walked up to the worktree root; also any files listed in `opencode.json` `instructions: [...]`. **Global:** `~/.config/opencode/AGENTS.md` (read empirically: both project and global marker strings appeared in a live `opencode run`'s system prompt; **project wins a direct conflict** — with `PROJECT-OVERRIDE: green` in the project file vs `red` global, opencode answered "green — /tmp/rules-proj/AGENTS.md (project-level instructions override the user-level ~/.config/opencode/AGENTS.md)"). **Precedence generally:** configs from all scopes are deep-merged, "project overrides global" (built-in skill text). No `debug rules` subcommand on 1.18.25; `opencode debug` has no rules tool — the empirical marker-string probe is the evidence. |
| **pi 0.73.1** | **Global:** `~/.pi/agent/skills/` (root `.md` files also discovered as individual skills there) and `~/.agents/skills/` (root `.md` ignored; only dirs with `SKILL.md`). **Project:** `.pi/skills/` and `.agents/skills/` in cwd and ancestors up to the repo root (confirmed: a skill at `/tmp/pi-proj/.pi/skills/project-skill/SKILL.md` was listed by a live `pi` run alongside the global one). **Packages:** `skills/` dirs or `pi.skills` in `package.json`; **Settings:** `skills` array in `settings.json` (this is also how Claude Code dirs are adopted: `"skills": ["~/.claude/skills"]`); **CLI:** `--skill <path>` (repeatable, additive even with `--no-skills`). **Format:** Agent Skills standard (agentskills.io): frontmatter `name` (required, ≤64 chars, lowercase a-z/0-9/hyphens, must match parent dir) + `description` (required, ≤1024 chars — a skill with no description is NOT loaded), optional `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`; violations warn but load, except the missing description. **Semantics:** progressive disclosure — descriptions always in the system prompt (XML `<available_skills>`), full SKILL.md loaded on demand via `read`; **the skills section is only added when a read-capable tool is enabled** (`--no-tools` genuinely hides skills: "NO" to a probe-skill-string check, while `--tools read` and even `--no-builtin-tools --tools read` show YES); `--no-skills` disables discovery (explicit `--skill` still loads). | **No agent files.** pi has no `agent list`, no agent directory, no `--agent` flag: `pi --help` shows none of these; the plugin's `--agent` dispatch param therefore applies to opencode runs only. Sub-agents exist only as extensions (e.g. the `subagent/` example extension); `--append-system-prompt` and `--system-prompt` replace/extend the prompt instead. | **Project:** `AGENTS.md` (or `CLAUDE.md`) in cwd **and every parent up to `/`**; per-dir precedence AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD. **Global:** `~/.pi/agent/AGENTS.md` (a live run quoted both global and project markers; on a direct conflict, pi: "I follow 'use green' from the project-local /tmp/pi-rules-proj/AGENTS.md, since instructions closer to the working directory override the global user-level file"). All context files are appended under `# Project Context` in load order (global first, then ancestors root→cwd) — later (closer) files can override. Optional project `.pi/SYSTEM.md` / global `~/.pi/agent/SYSTEM.md` **replace** the default prompt; `.pi/APPEND_SYSTEM.md` / `~/.pi/agent/APPEND_SYSTEM.md` append to it. Disable with `--no-context-files`. |

"Rules" = markdown instruction/context files injected into the system prompt. Neither engine
supports programmatic rule objects; both are plain markdown read at startup.

## Evidence (commands + output, this node)

### Scripted capture (fixtures the #111 core checks)

```
$ node scripts/opencode-capture.mjs > /tmp/oc-capture.json          # on dev3, as svcuser
$ npm run build && node dist/opencode-verify-cli.js /tmp/oc-capture.json
opencode live verification (opencode 1.18.25): 11 confirmed, 0 missing, 0 unverifiable. REQUIRED CHECKS PASS
```

All 11 checks `confirmed`, incl. the #111-core trio: `agents.project-local`,
`skills.project-local`, `paths.global` (`~/.config/opencode` present; the `agent`/`agents`,
`skill`/`skills` and `~/.claude/skills` subdirs did not exist on dev3 before this survey, so
dev3's opencode had never been provisioned with them). Capture date `2026-10-11T05:30:59.378Z`,
frozen unchanged as `src/testkit/oc-capture-dev3.json` (49,632 bytes). The event shapes the audit
parser reads also confirmed on 1.18.25: `tool_use` carrying `part.tool` + `part.state.input.command`
with `state.metadata.exit: 0` for the probe `echo fleet-oc-probe`, and `step_finish` with
`tokens: {total, input, output, reasoning, cache{read,write}}` + `cost`.

### Skill format (opencode) — frontmatter requirement probed live

The capture's `debugSkill` probe created `.opencode/skill/fleetprobe/SKILL.md` with:

```markdown
---
name: fleetprobe
description: fleet capture probe skill
---
probe
```

and `opencode debug skill` (json) returned it between the built-in skills:

```json
{
  "name": "fleetprobe",
  "description": "fleet capture probe skill",
  "location": "/tmp/oc-capture-DSHFGB/.opencode/skill/fleetprobe/SKILL.md",
  "content": "probe\n"
}
```

So on 1.18.25: minimal frontmatter is `name` + `description`; the folder is `<skill-name>/SKILL.md`
(`debug skill` is the discovery command; there is no `debug rules`). The built-in
`customize-opencode` skill (returned by the same command, `"location": "<built-in>"`) documents
the loader: scans `**/SKILL.md` under project `.opencode/skill(s)/<name>/SKILL.md`, global
`~/.config/opencode/skill(s)/<name>/SKILL.md`, and external `~/.claude/skills/<name>/SKILL.md` +
`~/.agents/skills/<name>/SKILL.md`; `name` required (lowercase-hyphen, ≤64, matches folder),
`description` effectively required or the skill is never surfaced.

### Precedence (rules) — opencode, marker-string probes

Project `AGENTS.md` and global `~/.config/opencode/AGENTS.md` with distinct markers, then one
non-tool `opencode run --format json`:

```
- `GLOBAL-RULE-MARKER-ABC: global rules apply` (from /home/svcuser/.config/opencode/AGENTS.md)
- `PROJECT-RULE-MARKER-XYZ: project rules apply` (from /tmp/rules-proj/AGENTS.md)
```

Both load; conflict resolution asked directly ("two conflicting PROJECT-OVERRIDE instructions…"):

```
1. `PROJECT-OVERRIDE: use red` — from `/home/svcuser/.config/opencode/AGENTS.md` (global)
2. `PROJECT-OVERRIDE: use blue` — from `/tmp/rules-proj/AGENTS.md` (project)
Project rules typically take precedence over global ones.
```

and pinned with a forced choice (`PROJECT-OVERRIDE: green` project vs `red` global):

```
green — /tmp/rules-proj/AGENTS.md (project-level instructions override the user-level
~/.config/opencode/AGENTS.md)
```

Model-dependent wording, but the file paths and both values are verbatim; project-beats-global
also matches the deep-merge order in the built-in skill ("Configs from each scope are
deep-merged. Project overrides global."). (3 cheap model calls total.)

### Claude-compat (`~/.claude/skills/`) — opencode 1.18.25 reads it

Created `~/.claude/skills/claudeprobe/SKILL.md` and `~/.agents/skills/agentsprobe/SKILL.md`, then:

```
$ opencode debug skill | grep '"name"'
    "name": "customize-opencode",
    "name": "claudeprobe",
    "name": "agentsprobe",
$ opencode debug skill | grep '"location"'
    "location": "<built-in>",
    "location": "/home/svcuser/.claude/skills/claudeprobe/SKILL.md",
    "location": "/home/svcuser/.agents/skills/agentsprobe/SKILL.md",
```

Both external dirs were read **without any config entry** on 1.18.25. Env kill-switches exist
(`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, from the built-in
skill's escape-hatch list). Note the asymmetry: opencode reads `~/.claude/skills/` implicitly, but
**pi does not** — pi's implicit set is `~/.pi/agent/skills/` + `~/.agents/skills/`, and Claude
dirs must be added to `settings.json` manually. Consequence for provisioning: a skill shipped to
`~/.claude/skills/` reaches opencode on both engines' nodes, but reaches pi only if the operator
adds the dir to pi's settings.

### Isolated-clone check (opencode) — discovery from a run cwd that is a fresh clone

A throwaway git repo cloned to `/tmp/iso-clone` (as `fleet_dispatch isolation: "clone"` does),
project-local skill placed in the clone:

```
$ cd /tmp/iso-clone && opencode debug skill | grep -E '"name"|"location"'
    "name": "customize-opencode",
    "location": "<built-in>",
    "name": "cloneskill",
    "location": "/tmp/iso-clone/.opencode/skill/cloneskill/SKILL.md",
```

Discovery works purely from cwd — no git context needed (the fresh clone has its own `.git`,
which is what the plugin's clone isolation produces). `rm -rf /tmp/iso-clone` confirmed the
skill disappeared with the clone (list back to built-in only); no stray files outside it.

### Pi — surface, semantics, and the read-tool condition

`pi --help` (0.73.1), skill/rules-relevant flags verbatim:

```
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
```

No `--agent`, no `agent list`, no rules subcommand: **agent files are not supported** by pi;
`--system-prompt` / `--append-system-prompt` + extensions are the substitute.

Discovery probed live (model `glm-5.3-flash:cloud` via the node's local `aperture` provider):

```
$ mkdir -p ~/.pi/agent/skills/probe-skill   # + /tmp/pi-proj/.pi/skills/project-skill/SKILL.md
$ pi -p "List the skills you can see in your system context…"
**probe-skill** — … (`/home/svcuser/.pi/agent/skills/probe-skill/SKILL.md`)
$ cd /tmp/pi-proj && pi -p "List the skills…"
- **project-skill** — … — `/tmp/pi-proj/.pi/skills/project-skill/SKILL.md`
- **probe-skill** — … — `/home/svcuser/.pi/agent/skills/probe-skill/SKILL.md`
```

Global and project discovery confirmed empirically; on `--no-skills` the same run answers NONE.

Semantics, `pi --model … -p "Skills are announced in your system prompt. Quote the sentence…"`:

```
> "The following skills provide specialized instructions for specific tasks."
```

— which is `formatSkillsForPrompt`'s header in pi's `core/skills.js`: descriptions always in the
system prompt (as `<available_skills>` XML per agentskills.io), full SKILL.md loaded on demand
(progressive disclosure; docs warn models don't always self-load — `/skill:name` forces it).
Count/size limits: none visible in help or docs; validation warns on bad names/length but only a
missing `description` blocks loading; name collisions warn and keep the first skill found.

**Surprise — skills gated on tool selection, probed empirically** ("is the string `probe-skill`
anywhere in your system prompt? YES/NO", `--offline` to keep runs cheap):

| pi invocation (0.73.1) | skills visible? |
|---|---|
| (default) | YES |
| `--tools read` / `--tools read,grep` / `--tools read,edit,write,bash` | YES |
| `--no-builtin-tools` (extension/custom tools) | NO |
| `--no-builtin-tools --tools read` | YES |
| `--tools bash` | NO |
| `--tools edit` | NO |
| `--no-tools` | NO |
| `--no-skills` | NO |

Matches pi's own prompt builder (`core/system-prompt.js` 0.73.1): the skills section is appended
**"only if read tool is available"** (`customPromptHasRead` / `hasRead`), i.e. tool selection on
the pi command decides whether skills are announced at all. Two consequences for the plugin: a
`--tools` allowlist that omits `read` (the plugin's offline/read-only Pi flags) also silently
disables every skill; and a YES/NO "skills visible" probe on pi is only valid once the read tool
is enabled. Note also `--no-tools` reported NONE in early probes without `--offline` and with it —
consistent, it is the read-gating.

### Pi rules precedence — probed live

`~/.pi/agent/AGENTS.md` (global) vs `/tmp/pi-rules-proj/AGENTS.md` (project), then a no-tool run:

```
- `/home/svcuser/.pi/agent/AGENTS.md`: `PI-GLOBAL-RULE-ABC: global rules apply`
- `/tmp/pi-rules-proj/AGENTS.md`: `PI-PROJECT-RULE-XYZ: project rules apply`
- `/tmp/pi-rules-proj/AGENTS.md`: `PI-OVERRIDE: use blue`
```

Forced choice (`green` project vs `red` global):

```
I follow "use green" from the project-local /tmp/pi-rules-proj/AGENTS.md, since instructions
closer to the working directory override the global user-level file
(/home/svcuser/.pi/agent/AGENTS.md).
```

Same rule as opencode (project wins); both engines are consistent, which the dispatch layer can
rely on.

### The `--auto` threshold data point (#170 item 4) — version drift on dev3

```
$ opencode --version
1.18.25
$ opencode run --help | grep -- --auto
      --auto         auto-approve permissions that are not explicitly denied (dangerous!)
```

dev3's **1.18.25 does list `--auto`** in `run --help` (the capture's runHelp probe stderr carries
the same line; the verifier marks `run.auto` CONFIRMED, required). The plugin's threshold is
`srt AUTO_SUPPORT_MIN_VERSION = "1.18.0"` (`src/deny-baseline.ts`) with the help-text signal as
the primary gate, so the floor is already conservative enough — 1.18.25 satisfies BOTH signals
(flag in help, version ≥ 1.18.0); no change needed, and the "one minor older than the
AUTO_SUPPORT_MIN_VERSION of 1.18.26" concern in the TASK does not apply to the shipped constant
(1.18.26 was dev2's verified version, not the threshold). acp's surface is also confirmed on this
version: `acp --help` has **no** `--auto` (the autoApprove guard's assumption holds).

## Provisioning side effects (#111's question)

- Files created by probes under shared home dirs (`~/.pi/agent/skills/…`, `~/.claude/skills/…`,
  `~/.agents/skills/…`, `~/.config/opencode/AGENTS.md`) were **all created as `svcuser` and then
  removed** (`ls -la` rechecked after each cleanup; empty dirs rmdir'd too). Every file under
  `~/.pi` and `~/.config/opencode` is `svcuser svcuser`.
- Pre-existing root-owned items in svcuser's home (`~/.openclaw/extensions/opencode-fleet.new`,
  `~/fleet/base-333.bundle`, `~/ts-work/ts-sidecar/*`, and `~/.pi/agent/sessions/--root--/` from
  an Oct 3 run whose session cwd is `/root`) predate this task and were left untouched — but they
  are exactly #111's "root-owned files from a root-run script" smell: pi (or some earlier run as
  root) wrote into svcuser's home. Candidate follow-up: inventory + chown, and make provision
  scripts refuse to write home-dir files they do not own.
- The capture itself wrote only into its own mkdtemp dir (`/tmp/oc-capture-*`, removed by the
  script) and `/tmp/opencode` (opencode's own tmp dir). Nothing in the fleet checkout was touched
  by probes.

## Surprises / candidate follow-up issues

1. **Pi hides its skill list when `read` is not among the enabled tools** (`--no-tools`, or a
   `--tools` allowlist without `read`). The plugin passes `--tools` on Pi dispatches; any
   allowlist that drops `read` silently disables skills. Follow-up: assert `read` in any
   `--tools` allowlist the plugin builds for Pi (or at least warn).
2. **opencode auto-loads `~/.claude/skills/` and `~/.agents/skills/`** on 1.18.25 with no config;
   a node whose operator uses Claude Code picks up those skills as a side effect — good for
   compat, surprising for isolation (`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` exists if a run needs
   purity). Consider documenting or setting it in isolated runs.
3. **Root-owned home-dir files from earlier root-run scripts** (see above) — inventory/chown
   follow-up, not from this task's probes.
4. opencode has **no `debug rules`** subcommand (only skill/paths/config); rule evidence had to
   come from marker-string model runs. Not a gap for the plugin (it does not parse rules), but if
   #170 wants mechanical rule checks, only opencode's `instructions: []` config and AGENTS.md
   walking are observable today.