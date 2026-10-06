import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/core";





import { setSshOptions } from "./ssh.js";



import { handleOpencodeRun } from "./node/handler.js";
import { setNodeEnvConfig } from "./guard.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";




import { parseBudgetConfig } from "./budget.js";

// Issue #87, slice 3: S1 dispatch wiring. TYPE-ONLY imports here — the S1
// client/hook modules are loaded (dynamically) only when the caller opts in,
// so the default dispatch path imports nothing from S1 and never calls it.
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerIterateTools } from "./tools/iterate.js";
import { registerRunsTools } from "./tools/runs.js";
import { registerMissionTools } from "./tools/mission.js";
import { registerProjectTools } from "./tools/project.js";
import { registerReviewTools } from "./tools/review.js";
import { registerNodesTools } from "./tools/nodes.js";
import { registerProvisionTools } from "./tools/provision.js";
import { registerRecipesTools } from "./tools/recipes.js";
import type { FleetConfig } from "./tools/shared.js";

/**
 * opencode-fleet — orchestrate OpenCode across multiple remote OpenClaw nodes.
 *
 * Two-sided plugin:
 *  - Gateway side: registers the `opencode.run` node invoke policy (permission
 *    boundary) + the fleet tools (fleet_dispatch/status/abort/diff).
 *  - Node side:   declares `opencode.run` as a node host command that executes
 *    OpenCode on the node's shell.
 *
 * Credentials stay on the node — the Gateway relays only the task prompt and
 * workspace path.
 */


/**
 * The `expect` verification-gate parameter, shared by fleet_dispatch / fleet_iterate / fleet_watch (it was
 * three near-identical multi-hundred-character copies). Descriptions say what to pass and the one thing
 * most likely to be misused; rationale lives in the README and docs.
 */

export default definePluginEntry({
  id: "opencode-fleet",
  name: "OpenCode Fleet",
  description:
    "Orchestrate OpenCode across multiple remote OpenClaw nodes (dev2, dev3, ...). Dispatch coding tasks, check fleet status, abort runaway sessions, and pull diffs — over the authenticated node channel.",
  configSchema: buildJsonPluginConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      defaultTransport: {
        type: "string",
        enum: ["http", "acp"],
        default: "http",
        description: "Default OpenCode transport (http or acp).",
      },
      nodePrefixes: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "Node display-name prefixes considered fleet members (fallback when `nodes` is not configured). Empty by default.",
      },
      defaultTimeoutMs: {
        type: "number",
        default: 1800000,
        description: "Default wall-clock timeout for a fleet_dispatch run, ms (30 minutes). The idle watchdog (maxIdleMs, default 120000) is the primary hung-run guard; this is the backstop. A run ended by either limit reports which one in `endedBy`.",
      },
      allowedRoots: {
        type: "array",
        items: { type: "string" },
        description: "Workspace roots the node will operate in (issue #103 group c): absolute paths, e.g. [\"/srv/work\", \"/home/u\"]. Config twin of the node's FLEET_ALLOWED_ROOTS env var; an explicit FLEET_ALLOWED_ROOTS env value still overrides this. Default: the shared fleet root plus the service user's home.",
      },
      stateDir: {
        type: "string",
        description: "Node-side private state directory (issue #103 group c), absolute path. Config twin of the node's FLEET_STATE_DIR env var; an explicit FLEET_STATE_DIR env value still overrides this. Default: ~/.openclaw/fleet/state under the service user's home.",
      },
      workerGitIdentity: {
        type: "object",
        additionalProperties: false,
        description: "Opt-in: fleet_provision sets this git identity in each provisioned checkout's LOCAL config (only when the checkout has none), so worker-authored commits are distinguishable from a person's in review. Defaults name `fleet-worker`, email `fleet-worker@<node>.invalid`. SSH-provisioned nodes only; a channel-provisioned node is not changed.",
        properties: {
          name: { type: "string", description: "Git author/committer name." },
          email: { type: "string", description: "Git author/committer email." },
        },
      },
      dispatch: {
        type: "object",
        additionalProperties: false,
        description: "Dispatch target policy.",
        properties: {
          piMinVersion: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$", description: "Refuse a harness=pi dispatch to a node whose `pi --version` is older than this (fail closed when it cannot be read)." },
          defaultTarget: { type: "string", enum: ["all"], description: "Restore the old behaviour: a fleet_dispatch that names no node runs on EVERY fleet node. Off by default: an unnamed target is refused with the node list; fan-out is explicit (nodes: \"all\") and pick:\"any\" chooses one node with a free slot." },
        },
      },
      allowAutoApprove: {
        type: "boolean",
        default: true,
        description: "Allow fleet_dispatch autoApprove (opencode --auto). Set false to forbid it fleet-wide.",
      },
      isolation: {
        type: "string",
        enum: ["none", "clone"],
        default: "none",
        description: "Default per-run isolation for fleet_dispatch. `clone` gives every run its own git clone on branch fleet/<runId> (own .git, hooks disabled), so concurrent runs cannot clobber each other. Needs a protocol-4 node (an older node is refused, never silently run un-isolated). Node support for a level is probed — a node without git cloning cannot honour `clone`.",
      },
      capacity: {
        type: "object",
        additionalProperties: false,
        description: "Concurrency slots. Slots are counted from the gateway's run ledger; see fleet_capacity.",
        properties: {
          maxConcurrentPerNode: { type: "integer", minimum: 1, maximum: 64, description: "Default max concurrent runs per node. Unset means unlimited." },
          minFreeDiskGb: { type: "integer", minimum: 1, maximum: 10000, description: "Isolated (clone) runs copy the object store: a node with less free disk than this refuses another, with a retryable no-disk result. Unset means no check." },
          staleAfterMs: { type: "integer", minimum: 60000, default: 21600000, description: "A run still `running` in the ledger after this long without an update stops holding a slot and is reported as suspected stale." },
        },
      },
      projection: {
        type: "object",
        additionalProperties: false,
        description: "One-way GitHub projection of missions (issue #132): the repo, and the NAME of the environment variable holding the token. The token stays in OpenClaw's secrets; it is never stored in config.",
        properties: {
          repo: { type: "string", description: "owner/name of the repository whose issues receive mission progress." },
          tokenEnv: { type: "string", description: "Name of the environment variable that holds the GitHub token on the manager (default GITHUB_TOKEN)." },
        },
      },
      budget: {
        type: "object",
        additionalProperties: false,
        description: "Spend caps: daily totals counted per UTC day from ledger usage (recorded from each finished run's audit manifest), plus per-dispatch caps. A dispatch that would exceed a cap is refused with a retryable `budget-exhausted` result (same family as no-capacity). No limits by default.",
        properties: {
          dailyCostUsd: { type: "number", minimum: 0, description: "Max total USD/day across the whole fleet (UTC day of run start)." },
          dailyTokens: { type: "number", minimum: 0, description: "Max total tokens/day across the whole fleet (UTC day of run start)." },
          perDispatchCostUsd: { type: "number", minimum: 0, description: "Default per-run cost cap, USD. A dispatch param of the same name overrides it." },
          perDispatchTokens: { type: "number", minimum: 0, description: "Default per-run token cap. A dispatch param of the same name overrides it." },
        },
      },
      project: {
        type: "object",
        additionalProperties: false,
        description: "Design gate for spec dispatches. A deterministic check (no model call) of the spec before dispatch: missing acceptance/verify/scope, a spec too large for one task, overlap with in-flight runs on the same checkout. `advise` (default) attaches the verdict as `design` when it is not a plain accept; `enforce` also refuses dispatch while an unacknowledged blocking objection remains; `off` skips it. A prompt-only dispatch is never gated.",
        properties: {
          gate: { type: "string", enum: ["off", "advise", "enforce"], default: "advise" },
          screenOutput: { type: "string", enum: ["off", "shadow", "fence", "withhold"], default: "shadow", description: "Instruction-pattern screening of worker output before the agent reads it: shadow logs flagged output, fence quotes it as data, withhold replaces it." },
          maxScopePatterns: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "A spec with more scope patterns is `decompose`." },
          maxAcceptanceItems: { type: "integer", minimum: 1, maximum: 50, default: 15, description: "A spec with more acceptance items is `decompose`." },
          roots: { type: "array", items: { type: "string" }, description: "Directories on the gateway host under which fleet_project_show may read a checkout's .fleet/ record. Default: the gateway's working directory and root dir." },
          rules: { type: "array", items: { type: "object" }, description: "Operator project rules, same shape as .fleet/rules.yml entries but `block` is allowed. A repo can add rules and tighten severity, never weaken or redefine these." },
          requireCharterFields: { type: "array", items: { type: "string", enum: ["goal", "users", "constraints", "nonGoals", "successCriteria", "riskiestAssumptions"] }, description: "Charter fields every project record must have; a repo cannot drop them." },
          allowRepoBlocking: { type: "boolean", default: false, description: "Let a repo's `block-candidate` rules actually block. Default false: they only advise." },
        },
      },
      s1: {
        type: "object",
        additionalProperties: false,
        description: "S1 decision layer. Defaults: backend local-kev, mode shadow (decisions are logged, never acted on). A hosted or non-loopback backend sends data off this machine only when its allowEgress is true, with secrets redacted. A failure or an off layer always leaves the static rules in force.",
        properties: {
          backend: { type: "string", enum: ["local-kev", "zen-jev", "typesafe-jev"], default: "local-kev" },
          mode: { type: "string", enum: ["off", "shadow", "enforce"], default: "shadow" },
          timeoutMs: { type: "number", default: 10000, description: "Per-call timeout, 100-120000 ms." },
          thresholds: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 }, description: "Per-question block thresholds (block when probabilityTrue >= threshold), from the #78 calibration report." },
          calibration: {
            type: "object",
            additionalProperties: false,
            description: "The model/version the thresholds were measured with. A different model reported at runtime downgrades enforce to shadow until re-calibrated.",
            properties: { model: { type: "string" }, date: { type: "string" } },
            required: ["model"],
          },
          backends: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", description: "Base URL of the S1 endpoint (local-kev defaults to http://127.0.0.1:8009)." },
                model: { type: "string" },
                apiKey: { type: "string", description: "Bearer token for hosted backends. Never logged." },
                allowEgress: { type: "boolean", default: false, description: "Opt in to sending (redacted) data to this backend when it is not loopback." },
              },
            },
          },
        },
      },
      env: {
        type: "object",
        additionalProperties: false,
        description: "Refine the dispatch env policy. Built-in denials (BASH_ENV, NODE_OPTIONS, LD_*, ...) always apply.",
        properties: {
          allowOnly: { type: "array", items: { type: "string" }, description: "If set, only these variable names may be injected." },
          extraDeny: { type: "array", items: { type: "string" }, description: "Additional variable names to refuse." },
        },
      },
      sync: {
        type: "object",
        additionalProperties: false,
        description: "fleet_sync publish policy: protected branches are never pushed directly (work is redirected to fleet/<name>) unless listed in allowDirectPush.",
        properties: {
          protectedBranches: { type: "array", items: { type: "string" }, default: ["main", "master"] },
          allowDirectPush: { type: "array", items: { type: "string" }, default: [] },
          blockOnScopeViolation: { type: "boolean", default: false, description: "Refuse fleet_sync for a run that changed files outside its declared spec.scope, or whose scope was never checked. Override per call with allowScopeViolations." },
          requireReview: { type: "boolean", default: false, description: "Refuse fleet_sync unless a fleet_review PASS is recorded for the exact head sha passed as `head`. A PASS for an older sha does not count." },
          requireReviewSource: { type: "string", enum: ["spawned"], description: "With requireReview: only a PASS collected from an independent reviewer run (fleet_review prepare + collect) counts; a PASS the caller merely recorded does not." },
          requireVerified: { type: "boolean", default: false, description: "Refuse fleet_sync for work with no verification result (a run that did not use expect/spec.verify). A run whose gate FAILED is always refused unless allowUnverified is passed." },
          allowSensitivePaths: { type: "boolean", default: false, description: "Allow worker changes to CI/CODEOWNERS paths." },
          sensitivePaths: { type: "array", items: { type: "string" }, default: [], description: "Extra path globs treated as sensitive (e.g. ci/**), added to the built-in list." },
        },
      },
      ssh: {
        type: "object",
        additionalProperties: false,
        description: "SSH client policy for manager-to-node commands.",
        properties: {
          strictHostKeyChecking: {
            type: "string",
            enum: ["accept-new", "yes"],
            default: "accept-new",
            description: "accept-new trusts a host key on first contact (TOFU) and refuses changes; yes requires the key to already be in known_hosts (pin keys when you provision nodes).",
          },
        },
      },
      allowSetupCommands: {
        type: "boolean",
        default: false,
        description: "Allow fleet_provision setup to be an arbitrary shell command. Default: repo-relative script path only.",
      },
      apertureUrl: {
        type: "string",
        description: "Model catalog URL (OpenAI-style /v1/models). No default: fleet_models and live model resolution are unavailable until set.",
      },
      fleetRoot: {
        type: "string",
        description: "Shared workspace root on nodes, used as the default provisioning cwd. Default: /home/<serviceUser>/fleet when every target node names the same service user.",
      },
      piDefaultModel: {
        type: "string",
        description: "Pi model ref (provider/id) used when harness=pi and the dispatch names no piModel. No built-in default.",
      },
    },
  }),

  // ------------------------------------------------------------------
  // Node host command: `opencode.run`
  // Runs OpenCode on the node's shell. Installed on each fleet node.
  // ------------------------------------------------------------------
  nodeHostCommands: [
    {
      command: "opencode.run",
      cap: "opencode",
      dangerous: true,
      handle: handleOpencodeRun,
    },
  ],

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as FleetConfig;
    setSshOptions(cfg.ssh);
    // Issue #103 group c: capture the node-relevant knobs (allowedRoots/stateDir)
    // so the node-side defaults (guardCwd roots, the private state dir) honor the
    // plugin config; an explicit FLEET_ALLOWED_ROOTS/FLEET_STATE_DIR env value on
    // the node still overrides it.
    setNodeEnvConfig({ ...(cfg.allowedRoots?.length ? { allowedRoots: cfg.allowedRoots } : {}), ...(cfg.stateDir ? { stateDir: cfg.stateDir } : {}) });

    // Issue #39 (budget slice): validate the optional budget block once at load so a
    // malformed config is a precise, immediate error, never a silently ignored limit.
    const budgetLoad = parseBudgetConfig(cfg.budget);
    if (!budgetLoad.ok) throw new Error(`invalid plugin config: ${budgetLoad.error}`);

    // ------------------------------------------------------------------
    // Node invoke policy: `opencode.run` (gateway-side permission boundary)
    // ------------------------------------------------------------------
    const protocolCache = newProtocolCache();
    api.registerNodeInvokePolicy({
      commands: ["opencode.run"],
      dangerous: true,
      classifyRisk: () => ({ level: "high", family: "opencode-run" }),
      handle: (ctx) => handleOpencodeRunPolicy(ctx as unknown as PolicyCtx, protocolCache, undefined, { allowExpectCommands: cfg.allowSetupCommands === true }),
    });

    // ------------------------------------------------------------------
    // Tools
    // ------------------------------------------------------------------

    const { dispatchTool } = registerDispatchTools(api, cfg);
    registerIterateTools(api, cfg);
    const { runStatusExecute } = registerRunsTools(api, cfg);
    registerMissionTools(api, cfg, { dispatchTool, runStatusExecute });
    registerProjectTools(api, cfg);
    registerReviewTools(api, cfg);
    registerNodesTools(api, cfg);
    registerProvisionTools(api, cfg);
    registerRecipesTools(api, cfg);
  },
});
