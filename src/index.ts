import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildJsonPluginConfigSchema, jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { shq } from "./shell.js";
import { buildOpenCodeCommand, parseOpenCodeOutput, parsePiOutput, validateHarnessTransport, validatePiOptions, type OpenCodeTask } from "./opencode.js";
import {
  probeAckRecovery,
  abortStateWrite,
  ACK_ABSENT_NOTE,
  ACK_PROBE_TIMEOUT_MS,
  type AckRecoveryOutcome,
} from "./recovery.js";
import { SSH_ARGS, setSshOptions, sshPrefix } from "./ssh.js";
import { createHash } from "node:crypto";
import { quoteUntrusted, sanitizeQuestion } from "./untrusted.js";
import { checkSetup, partitionEnv } from "./policy.js";
import { handleOpencodeRun, type FleetOpenCodeTask } from "./node/handler.js";
import { handleOpencodeRunPolicy, newProtocolCache, type PolicyCtx } from "./gateway-policy.js";
import { isSentinelPrompt } from "./protocol.js";
import { OPCODE_PS_COMMAND, abortRunById, parseActivity, runStatePath, type NodeActivityEntry } from "./node/runtime.js";
import { isCanonicalBase64 } from "./xfer.js";
import { runPaths, xferPaths, ensureStateDir, writePrivate } from "./paths.js";
// Issue #87, slice 3: S1 dispatch wiring. TYPE-ONLY imports here — the S1
// client/hook modules are loaded (dynamically) only when the caller opts in,
// so the default dispatch path imports nothing from S1 and never calls it.
import type { TriageResult } from "./s1-hooks.js";
import type { S1RouteDecision, S1RouteHarnessResult } from "./s1-wire.js";



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

interface FleetConfig {
  defaultTransport?: "http" | "acp";
  nodePrefixes?: string[];
  defaultTimeoutMs?: number;
  apertureUrl?: string;
  /** Shared workspace root on nodes (default: /home/<serviceUser>/fleet when all targets share one service user). */
  fleetRoot?: string;
  /** Pi model ref (provider/id) used when harness=pi and the dispatch names none. No built-in default. */
  piDefaultModel?: string;
  /** Operator switch: let agents pass `autoApprove` on dispatch (default true). */
  allowAutoApprove?: boolean;
  /** Operator switch: let fleet_provision `setup` be an arbitrary shell command, not just a repo script (default false). */
  allowSetupCommands?: boolean;
  /** Default per-run isolation for fleet_dispatch (issue #41): none (default) or clone. */
  isolation?: "none" | "clone";
  /** S1 decision layer (issue #79): backend, mode (default shadow), thresholds, egress opt-in. Validated by parseS1Config. */
  s1?: unknown;
  /** fleet_sync publish policy (issue #33). */
  sync?: { protectedBranches?: string[]; allowDirectPush?: string[]; allowSensitivePaths?: boolean; sensitivePaths?: string[]; requireVerified?: boolean };
  /** Dispatch env refinements: allowOnly makes injection allowlist-only; extraDeny adds refused names. */
  env?: { allowOnly?: string[]; extraDeny?: string[] };
  /** SSH client policy for manager-to-node commands. */
  ssh?: { strictHostKeyChecking?: "accept-new" | "yes" };
}

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
        default: 300000,
        description: "Default timeout for OpenCode runs, ms.",
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
        description: "Default per-run isolation for fleet_dispatch (issue #41). `clone` gives every run its own git clone on branch fleet/<runId> (own .git, hooks disabled), so concurrent runs cannot clobber each other. Needs a protocol-4 node (an older node is refused, never silently run un-isolated).",
      },
      s1: {
        type: "object",
        additionalProperties: false,
        description: "S1 decision layer (issue #79). Defaults: backend local-kev, mode shadow (decisions are logged, never acted on). A hosted or non-loopback backend sends data off this machine only when its allowEgress is true, with secrets redacted. A failure or an off layer always leaves the static rules in force.",
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

    api.registerTool({
      name: "fleet_dispatch",
      label: "Fleet Dispatch",
      description:
        "Dispatch an OpenCode coding task to one or more remote OpenClaw nodes (dev2, dev3, ...). Returns per-node results. Use for multi-file coding work on remote dev hosts. Optionally filter nodes by capability constraints (GPU, disk, RAM, tools, models) so work routes to nodes that can actually handle it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: { type: "string", description: "The coding task / goal for OpenCode. Optional when `spec` is given (issue #65): a spec-rendered prompt replaces it and this field is ignored." },
          spec: {
            type: "object",
            additionalProperties: false,
            description: "Structured task spec (issue #65 slice 1) — the dispatch unit with an explicit goal, acceptance criteria and verify gate. When given, the engine prompt is RENDERED from goal + acceptance (goal on the first line, then an 'Acceptance criteria:' bullet list; the flat `prompt` is ignored) and spec.verify maps onto the SAME post-run verification gate as the flat `expect` param (same parser, same node evaluator, same ledger shape). A prompt-only call behaves exactly as before.",
            properties: {
              goal: { type: "string", description: "The task goal — the first line of the rendered engine prompt." },
              acceptance: { type: "array", items: { type: "string" }, description: "Acceptance criteria, rendered as a bullet list under 'Acceptance criteria:'. At most 50 items of 1000 characters." },
              scope: {
                type: "object",
                additionalProperties: false,
                description: "Advisory file scope (issue #65 slice 2). Rendered into the prompt, and on a detached run the node lists the files that changed against the start commit and reports any outside the scope as scopeViolations in fleet_run_status. Not enforced. Also the overlap key for scheduling concurrent tasks.",
                properties: {
                  files: { type: "array", items: { type: "string" }, description: "Repo-relative paths or globs (`*`, `**`, `?`); `dir/` means everything below dir. No absolute paths or `..`. At most 100." },
                },
                required: ["files"],
              },
              verify: {
                type: "object",
                additionalProperties: false,
                properties: {
        //  paths are treated as relative to the run cwd.
                  command: { type: "string", description: "Verification command run in the run cwd after the worker exits; must exit 0 — same semantics as expect.command. Bounded to 120s." },
                },
                description: "Post-run verification gate — mapped onto the existing `expect` gate (issue #62/#40). Absent => no gate, nothing extra is emitted.",
              },
            },
          },
          cwd: { type: "string", description: "Working directory on the target node(s)." },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          node: { type: "string", description: "Singular alias for nodes: [node]. Convenience for single-node dispatch." },
          transport: { type: "string", enum: ["http", "acp"], description: "OpenCode transport." },
          harness: { type: "string", enum: ["opencode", "pi"], description: "Worker engine harness." },
          route: {
            type: "object",
            additionalProperties: false,
            description: "OPT-IN S1 engine routing (issue #87, default OFF): when present, the candidate engine names are ranked by the S1 routeEngine hook for this task text and the dispatch uses the pick as its `harness` — applied only when the pick is a valid harness (opencode|pi). S1 unavailable, no decision, or a non-harness pick keeps the caller's `harness` (today's behaviour). Omitted => no S1 call, dispatch unchanged byte for byte.",
            properties: {
              candidates: { type: "array", items: { type: "string" }, description: "Candidate engine names, e.g. ['opencode','pi'], in criteria/tie-break order." },
            },
          },
          piModel: { type: "string", description: "Pi model override (harness=pi); `provider/id` ref, e.g. myprovider/some-model. Falls back to the operator's piDefaultModel config." },
          piTools: { type: "array", items: { type: "string" }, description: "Pi tool allowlist (harness=pi), e.g. ['read','grep','ls'] for a read-only reviewer; [] disables all tools. Omitted = Pi defaults (read, bash, edit, write...). Fails closed: a node whose Pi lacks --tools refuses the run." },
          piOffline: { type: "boolean", description: "Run Pi with --offline (no automatic network activity). Fails closed if the node's Pi lacks the flag." },
          model: { type: "string", description: "Optional model override (must exist on node)." },
          agent: { type: "string", description: "Optional OpenCode agent (build/plan)." },
          autoApprove: { type: "boolean", description: "Opt-in: append --auto to `opencode run` to auto-approve all non-denied permissions for this run. Default false — this widens the trust posture." },
          autoTriage: { type: "boolean", description: "OPT-IN S1 triage (issue #87, default false): when a run hand-raises a question, also ask the S1 triageHandRaise hook and surface a recommendation on the result as s1.triage ({action, reason}). Advisory only — it never auto-answers or changes the run; unavailable decisions escalate. Default false => no S1 call, no added fields." },
          timeoutMs: { type: "number", description: "Per-node timeout, ms." },
          maxIdleMs: { type: "number", description: "Kill the run if no output for this long, ms (stuck-loop guard). Default 120000." },
          maxDurationMs: { type: "number", description: "Kill the run if total runtime exceeds this, ms (stuck-loop guard). Default 600000." },
          async: { type: "boolean", description: "Run detached: returns a run handle immediately (runId + pid); the worker survives relay timeouts and its completion is recorded. Poll with fleet_watch or fleet_run_status. Default true." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for the worker process (per-dispatch environment). Names that execute code or redirect configuration (PATH, HOME, BASH_ENV, NODE_OPTIONS, LD_*, GIT_SSH*, OPENCODE_CONFIG*, ...) are REFUSED: the dispatch fails and names them. Operators can narrow this further (config env.allowOnly / env.extraDeny)." },
          isolation: { type: "string", enum: ["none", "clone"], description: "Per-run isolation (issue #41). `clone`: the node makes a private git clone of `cwd` (committed state only) at <parent>/.fleet-runs/<runId>/repo on branch fleet/<runId>, runs the worker there, and returns runCwd and branch; pass runCwd to fleet_sync. Detached runs only. A node that predates isolation is refused rather than run in the shared checkout. Default from config `isolation`, else none." },
          expect: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: { type: "array", items: { type: "string" }, description: "Artifact paths that must exist after the run (relative to the run cwd and inside it: absolute paths and `..` are refused), e.g. ['dist/index.js', 'docs/api.md']." },
              command: { type: "string", description: "Verification command run via `bash -c` in the run cwd after the worker exits; must exit 0. Bounded to 120s (process group killed). It runs outside the engine's permission system, so it must be a repo-relative script path with plain arguments (e.g. `./scripts/check.sh --fast`) unless the operator set allowSetupCommands; an arbitrary shell command such as `npm test && echo ok` is refused." },
            },
            description: "Optional post-run verification gate (issue #62). After the worker exits, the node checks that every listed file exists and — when given — that the command exits 0, recording verified/verifyDetails on the run result. verified is separate from ok (which stays the process exit status): use it so a run that exits 0 but produced nothing is not trusted as success. Poll it with fleet_run_status.",
          },
          ref: { type: "object", additionalProperties: false, properties: { branch: { type: "string", description: "Branch to check out before running." }, commit: { type: "string", description: "Commit SHA to check out before running." } }, description: "Git ref to check out before running. Refused if the checkout has uncommitted changes." },
          requires: {
            type: "object",
            additionalProperties: false,
            description: "Capability constraints. Only nodes satisfying ALL constraints receive the task.",
            properties: {
              gpu: { type: "boolean", description: "Require a GPU (true) or a specific GPU substring." },
              minDiskGb: { type: "number", description: "Minimum free disk in GB." },
              minMemGb: { type: "number", description: "Minimum RAM in GB." },
              tools: { type: "array", items: { type: "string" }, description: "Required installed tools (e.g. docker, node)." },
              models: { type: "array", items: { type: "string" }, description: "Required available models." },
            },
          },
        },
        required: ["cwd"],
      },
      execute: async (toolCallId, rawParams, signal) => {
        const raw = rawParams as {
          prompt?: string;
          cwd: string;
          nodes?: string[];
          node?: string;
          transport?: "http" | "acp";
          harness?: "opencode" | "pi";
          route?: { candidates: string[] };
          piModel?: string;
          piTools?: string[];
          piOffline?: boolean;
          model?: string;
          agent?: string;
          autoApprove?: boolean;
          autoTriage?: boolean;
          timeoutMs?: number;
          maxIdleMs?: number;
          maxDurationMs?: number;
          async?: boolean;
          isolation?: "none" | "clone";
          env?: Record<string, string>;
          expect?: { files?: string[]; command?: string };
          spec?: { goal: string; acceptance?: string[]; verify?: { files?: string[]; command?: string }; scope?: { files: string[] } };
          ref?: { branch?: string; commit?: string };
          requires?: {
            gpu?: boolean;
            minDiskGb?: number;
            minMemGb?: number;
            tools?: string[];
            models?: string[];
          };
        };
        // Issue #65 slice 1: a structured task spec (goal / acceptance / verify) is
        // the dispatch unit. When given, `prompt` is optional and IGNORED — the
        // engine prompt is RENDERED from goal + acceptance (renderSpec), and the
        // spec rides the ledger entry. When only `prompt` is given, this whole
        // block reduces to today's behavior: raw.prompt passes through verbatim
        // (renderSpec({ goal: prompt }) === prompt) and every emitted string is
        // byte-identical. Neither prompt nor spec => refuse; a dispatch without a
        // task is exactly the empty-session failure mode #22 closed.
        const { parseTaskSpec, renderSpec } = await import("./spec.js");
        const specCheck = parseTaskSpec(raw.spec);
        if (!specCheck.ok) {
          return jsonResult({ ok: false, error: specCheck.error });
        }
        if (!specCheck.spec && typeof raw.prompt !== "string") {
          return jsonResult({ ok: false, error: "no task given: pass `prompt`, or a structured `spec` with at least a goal (issue #65)" });
        }
        const p = { ...raw, prompt: specCheck.spec ? renderSpec(specCheck.spec) : (raw.prompt as string) };
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const nodeFilter = p.node ? [p.node] : p.nodes;
        let targets = nodeFilter?.length
          ? fleet.filter((n) => nodeFilter!.includes(n.displayName ?? n.nodeId) || nodeFilter!.includes(n.nodeId))
          : fleet;

        // Apply capability constraints if provided.
        if (p.requires) {
          const { detectNodeCapabilities, satisfiesConstraints } = await import("./capabilities.js");
          const filtered: typeof targets = [];
          const skipped: string[] = [];
          for (const node of targets) {
            const host = node.remoteIp ?? node.displayName ?? node.nodeId;
            const caps = await detectNodeCapabilities(host, node.displayName ?? node.nodeId);
            const check = satisfiesConstraints(caps, p.requires);
            if (check.ok) filtered.push(node);
            else skipped.push(`${node.displayName ?? node.nodeId} (${check.reason})`);
          }
          targets = filtered;
          if (skipped.length) {
            return jsonResult({
              skipped: skipped,
              note: "Nodes skipped for not meeting capability constraints.",
            });
          }
        }

        if (!targets.length) {
          return jsonResult(
            `No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`,
          );
        }

        const transport = p.transport ?? cfg.defaultTransport ?? "http";
        // Issue #48: refuse an unsupported engine/transport pair before any node
        // is invoked (the node handler re-checks with the same helper).
        // Issue #43: a task prompt that equals a control sentinel would be read as
        // a control message by nodes that predate the explicit protocol op.
        if (isSentinelPrompt(p.prompt?.trim())) {
          return jsonResult({ ok: false, error: `prompt ${JSON.stringify(p.prompt.trim())} is reserved for node control messages; write a real task description` });
        }
        // Issue #87, slice 4: SHADOW-ONLY live S1 evidence on dispatch. Fires ONLY
        // when the operator configured an `s1` config block (mode shadow|enforce —
        // enforce still records-only in this slice). One fire-and-forget shadow
        // decision per dispatch with a task (questionId dispatch.route, the task
        // text in state); the bounded record goes to <rootDir>/.opencode-fleet/
        // s1-shadow.jsonl and is never read back by any dispatch decision — this
        // path imports no combineWithStatic and CAN'T enforce anything. With NO
        // `s1` config the block (and the module import) never runs: the dispatch
        // stays byte-identical to today, and the record never touches the result,
        // the ledger or any added field.
        if (cfg.s1 != null) {
          const shadowRoot = api.rootDir ?? process.cwd();
          void import("./s1-shadow.js")
            .then((shadow) => shadow.recordDispatchShadow(cfg.s1, { task: p.prompt, cwd: p.cwd }, shadowRoot))
            .catch(() => { /* the shadow path can never break dispatch */ });
        }
        // Issue #87, slice 3: OPT-IN S1 engine routing. Default OFF: with no
        // `route` param nothing runs here — no S1 call, no field added, and
        // the dispatch is byte-identical to routing being absent. When set,
        // the candidate list is ranked by the S1 routeEngine hook for this
        // task text; a pick that is a valid harness (opencode|pi) REPLACES
        // the dispatch harness. Every fallback (S1 unavailable, no pick, pick
        // that is not a valid harness) keeps the caller's `harness` unchanged.
        let routed: S1RouteHarnessResult = { harness: p.harness, changed: false };
        let s1RouteDecision: S1RouteDecision | undefined;
        if (p.route !== undefined) {
          const { parseRouteOptIn, s1RouteHarness } = await import("./s1-wire.js");
          const routeCheck = parseRouteOptIn(p.route);
          if (!routeCheck.ok) return jsonResult({ ok: false, error: `invalid route: ${routeCheck.error}` });
          routed = await s1RouteHarness({ harness: p.harness, route: routeCheck.route, specText: p.prompt ?? "" });
          s1RouteDecision = routed.decision;
        }
        const harnessCheck = validateHarnessTransport({ harness: routed.harness, transport });
        if (!harnessCheck.ok) return jsonResult({ ok: false, harness: harnessCheck.harness, error: harnessCheck.error });
        // No built-in Pi model: a dispatch must name one, or the operator must configure a default.
        // Whitespace-only counts as missing, so a blank per-call value falls back to the configured default.
        const clean = (v?: string) => v?.trim() || undefined;
        const piModel = routed.harness === "pi" ? (clean(p.piModel) ?? clean(cfg.piDefaultModel)) : clean(p.piModel);
        if (routed.harness === "pi" && !piModel) {
          return jsonResult({ ok: false, harness: "pi", error: "harness=pi needs a model: pass piModel (provider/id) or set piDefaultModel in the plugin config" });
        }
        // Issue #34: refuse (never silently drop) env names that execute code or
        // redirect config, and honor the operator's autoApprove ceiling.
        const envPartition = partitionEnv(p.env, cfg.env);
        if (envPartition.rejected.length) {
          return jsonResult({ ok: false, error: `env not allowed: ${envPartition.rejected.join(", ")}` });
        }
        if (p.autoApprove === true && cfg.allowAutoApprove === false) {
          return jsonResult({ ok: false, error: "autoApprove is disabled by the operator (allowAutoApprove=false)" });
        }
        // Issue #62: validate the optional verification gate up front so a
        // malformed spec is a clear refusal, never a silently-dropped gate.
        const { parseExpectSpec, withVerified, relayTimeoutWithGate } = await import("./verify.js");
        // Issue #65: with a structured spec the gate comes from spec.verify,
        // mapped onto the SAME machinery: same parser here, same node-side
        // evaluator (evaluateExpect / the launcher gate script), same ledger
        // shape. No verify (and no expect) => expect stays undefined and
        // nothing extra is emitted anywhere. When spec is given it is the
        // dispatch unit, so its verify supersedes a flat `expect`.
        const expectSpec = specCheck.spec
          ? parseExpectSpec(specCheck.spec.verify)
          : parseExpectSpec(p.expect);
        if (!expectSpec.ok) {
          return jsonResult({ ok: false, error: `invalid expect: ${expectSpec.error}` });
        }
        // `expect.command` runs on the node OUTSIDE the engine's permission system,
        // so it gets the same rule as provision `setup`: a repo-relative script
        // path unless the operator allows arbitrary commands (issue #34).
        if (expectSpec.expect?.command) {
          const cmdCheck = checkSetup(expectSpec.expect.command, cfg.allowSetupCommands === true);
          if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.command: ${cmdCheck.error}` });
        }
        const { upsertRun, newRunId, probeRun, loadLedger, outcomeEntry } = await import("./ledger.js");
        const rootDir = api.rootDir ?? process.cwd();

        // Issue #8: unfiltered dispatch must not fail on non-OpenCode nodes.
        const skippedNodes: string[] = [];
        const opencodeTargets = targets.filter((n) => {
          const invocable = (n as { invocableCommands?: string[] }).invocableCommands ?? [];
          if (!invocable.includes("opencode.run")) {
            skippedNodes.push(`${n.displayName ?? n.nodeId} (not an opencode node)`);
            return false;
          }
          return true;
        });
        const results: Record<string, unknown> = {};
        if (skippedNodes.length) results.skipped = skippedNodes;
        // Issue #87, slice 3: surface the opt-in routing decision — only when
        // `route` was requested; the default path adds no field at all.
        if (s1RouteDecision) results.s1 = { route: s1RouteDecision };
        // Issue #26: validate the cwd AS THE WORKER PRINCIPAL before dispatch.
        // A /root path is unreachable by a non-root service user, so the run
        // cannot start — refuse with an actionable error instead of sending it
        // and discovering the failure later (or, pre-#22, reporting success).
        const { cwdCheckCommand, evaluateCwdCheck, looksWorkerInaccessible, defaultFleetCwd, resolveFleetRoot } = await import("./cwd.js");
        const { SSH_ARGS } = await import("./ssh.js");
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify: promisifyCb } = await import("node:util");
        const execFileProbe = promisifyCb(execFileCb);
        const sshProbe = async (hostArg: string, command: string, timeoutMs = 30_000): Promise<string> => {
          try {
            const { stdout } = await execFileProbe("ssh", [...sshPrefix(hostArg, SSH_ARGS), command], { timeout: timeoutMs });
            return stdout;
          } catch (e) {
            return (e as { stdout?: string }).stdout ?? "";
          }
        };
        for (const node of opencodeTargets) {
          const runId = newRunId();
          // Issue #26: refuse an unusable cwd BEFORE recording a run or
          // dispatching. Check as the worker principal; a fast path-only check
          // catches the common /root case without an SSH round trip.
          const nodeKey = node.displayName ?? node.nodeId;
          const svcUser = (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
            ?? (node as { member?: { user?: string } }).member?.user;
          const loginUser = (node as { member?: { user?: string } }).member?.user;
          const sshHost = loginUser ? `${loginUser}@${nodeKey}` : nodeKey;
          let exampleRoot: string | undefined;
          try { exampleRoot = resolveFleetRoot(cfg, [svcUser]); } catch { /* a bad fleetRoot is reported by provisioning */ }
          if (looksWorkerInaccessible(p.cwd, svcUser)) {
            results[nodeKey] = {
              ok: false,
              error:
                `refusing to dispatch: cwd ${p.cwd} is unusable — it is not traversable by the worker principal` +
                `${svcUser ? ` (${svcUser})` : ""} (a /root path is mode 0700 and cannot be entered by a non-root service user). ` +
                `Provision/dispatch under a workspace both principals share${exampleRoot ? `, e.g. ${defaultFleetCwd("your-repo", exampleRoot)}` : ""}.`,
            };
            continue;
          }
          const cwdOut = await sshProbe(sshHost, cwdCheckCommand(p.cwd, svcUser));
          const cwdCheck = evaluateCwdCheck(cwdOut, p.cwd, svcUser);
          if (!cwdCheck.ok) {
            results[nodeKey] = { ok: false, error: cwdCheck.error };
            continue;
          }
          const isolationMode = p.isolation ?? cfg.isolation ?? "none";
          if (isolationMode === "clone" && (transport !== "http" || p.async === false)) {
            results[nodeKey] = { ok: false, error: "isolation \"clone\" needs a detached run (transport http, async not false): the clone is made by the node when the run starts" };
            continue;
          }
          if (routed.harness !== "pi" && (p.piTools !== undefined || p.piOffline !== undefined)) {
            results[nodeKey] = { ok: false, error: "piTools/piOffline apply to harness=pi only; refusing so the restriction is not silently ignored" };
            continue;
          }
          const piOptsErr = validatePiOptions(p);
          if (piOptsErr) {
            results[nodeKey] = { ok: false, error: piOptsErr };
            continue;
          }
          const task: OpenCodeTask = {
            prompt: p.prompt,
            cwd: p.cwd,
            transport,
            harness: routed.harness,
            piModel,
            ...(p.piTools !== undefined ? { piTools: p.piTools } : {}),
            ...(p.piOffline !== undefined ? { piOffline: p.piOffline } : {}),
            model: p.model,
            agent: p.agent,
            autoApprove: p.autoApprove === true,
            timeoutMs: p.timeoutMs ?? cfg.defaultTimeoutMs,
            maxIdleMs: p.maxIdleMs,
            maxDurationMs: p.maxDurationMs,
            env: p.env,
            expect: expectSpec.expect,
            ...(specCheck.spec?.scope ? { scope: specCheck.spec.scope } : {}),
            ref: p.ref,
            async: p.async !== false,
            ...(isolationMode === "clone" ? { isolation: "clone" as const } : {}),
          };
          // Ledger: record BEFORE the invoke so an agent/worker crash mid-run
          // still leaves a discoverable record (interruption handling).
          const ledgerEntry = {
            runId,
            node: node.displayName ?? node.nodeId,
            cwd: p.cwd,
            prompt: p.prompt,
            model: p.model,
            transport,
            harness: routed.harness,
            piModel,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "running" as const,
            // Issue #65: record the run's spec on the ledger. Absent (key not
            // materialized) for prompt-only dispatches — the entry is
            // byte-identical to today's when no spec was given.
            ...(specCheck.spec ? { spec: specCheck.spec } : {}),
          };
          await upsertRun(rootDir, ledgerEntry);
          // Issue #6: default to DETACHED execution. The node returns a run
          // handle immediately; the child survives relay timeouts/cancels and
          // records its own completion. fleet_watch/fleet_run_status poll it.
          const detached = task.async !== false && transport === "http";
          let inv: unknown;
          if (detached) {
            // Issue #22 bug 2: `prompt` becomes the transport sentinel, so the
            // real task text MUST ride in a separate field (`realPrompt`) or it
            // is lost before the command is built — which is exactly how
            // fleet_dispatch ran empty sessions and still reported success.
            const launchParams = { ...task, prompt: "__RUN_START__", realPrompt: p.prompt, runId };
            inv = await api.runtime.nodes
              .invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: launchParams,
                timeoutMs: 30_000,
                signal,
              })
              .catch((err: Error) => ({
                invokeTimedOut: true as const,
                message: err.message,
              }));
          } else {
            inv = await api.runtime.nodes
              .invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: task,
                timeoutMs: task.timeoutMs === undefined ? undefined : relayTimeoutWithGate(task.timeoutMs, expectSpec.expect !== undefined),
                signal,
              })
              .catch((err: Error) => ({
                invokeTimedOut: true as const,
                message: err.message,
              }));
          }

          // Detached launch (issues #9, #21): NEVER block the manager on the
          // ack. But also never MINT a success: if the invoke timed out or the
          // node returned {ok:false}, we have no receipt for a launch that
          // happened, and must say so — not assert "the run handle is valid
          // regardless". A false-success here hides the real relay diagnostic.
          if (detached) {
            const launchPayload = payloadOf(inv) as {
              ok?: boolean;
              detached?: boolean;
              runId?: string;
              pid?: number;
              runCwd?: string;
              branch?: string;
              sourceDirty?: boolean;
              error?: string;
            };
            const invokeTimedOut = (inv as { invokeTimedOut?: boolean }).invokeTimedOut === true;
            const nodeRejected = launchPayload.ok === false;
            const ackOk = launchPayload.detached === true;

            // Hard failure: the node explicitly reported the launch failed, or
            // the relay never returned AND we got no positive ack. Either way
            // no run state exists, so returning an optimistic handle would be
            // a fabricated receipt.
            if (nodeRejected || (invokeTimedOut && !ackOk)) {
              const errMsg = launchPayload.error
                ?? (inv as { message?: string }).message
                ?? "detached launch not acknowledged";
              // Issue #29: an invoke-timeout does NOT prove the launch failed.
              // The node can spawn the detached child and write its state file
              // AFTER the relay gave up (seen repeatedly on dev2). Declaring
              // failure here makes an unattended caller re-dispatch and
              // duplicate work — the exact babysitter failure mode. PROBE the
              // node for evidence the run exists before deciding.
              // Issue #30 finding E: probe with a FRESH timeout-only signal and
              // an allow-list decision (recovery.ts). A probe that THREW or
              // TIMED OUT is INCONCLUSIVE — never "safe to re-dispatch". A node
              // that explicitly rejected the launch is a definitive negative, so
              // no probe is attempted and it IS safe to re-dispatch.
              const recovery: AckRecoveryOutcome = nodeRejected
                ? { kind: "absent", verdict: "absent", probed: false, note: ACK_ABSENT_NOTE }
                : await probeAckRecovery((probeSignal) =>
                    api.runtime.nodes.invoke({
                      nodeId: node.nodeId,
                      command: "opencode.run",
                      params: { prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId },
                      timeoutMs: ACK_PROBE_TIMEOUT_MS,
                      signal: probeSignal,
                    }),
                  );
              if (recovery.kind === "confirmed") {
                // Persist the discovered pid so later liveness/cancel checks are
                // engine-independent (issue #30 findings H/I).
                await upsertRun(rootDir, {
                  ...ledgerEntry,
                  pid: recovery.pid,
                  updatedAt: new Date().toISOString(),
                  state: "running",
                });
                results[node.displayName ?? node.nodeId] = {
                  runId,
                  detached: true,
                  pid: recovery.pid,
                  ok: true,
                  ackPending: false,
                  recoveredFromTimeout: true,
                  probe: recovery.verdict,
                  note: recovery.note,
                };
                continue;
              }
              results[node.displayName ?? node.nodeId] = {
                runId,
                detached: true,
                ok: false,
                ackPending: !ackOk,
                ...(invokeTimedOut ? { invokeTimedOut: true } : {}),
                probe: recovery.verdict,
                error: nodeRejected ? `launch failed: ${errMsg}` : `launch ack not received: ${errMsg}`,
                note: recovery.note,
              };
              continue;
            }

            // Positive ack: the node wrote the pid into the run-state file.
            if (ackOk) {
              // Persist the pid (issue #30 findings H/I) so liveness probes and
              // cancellation are engine-independent (works for Pi too).
              await upsertRun(rootDir, {
                ...ledgerEntry,
                pid: launchPayload.pid,
                ...(launchPayload.runCwd ? { runCwd: launchPayload.runCwd, branch: launchPayload.branch } : {}),
                updatedAt: new Date().toISOString(),
                state: "running",
              });
              results[node.displayName ?? node.nodeId] = {
                runId,
                detached: true,
                pid: launchPayload.pid,
                ...(launchPayload.runCwd
                  ? {
                      runCwd: launchPayload.runCwd,
                      branch: launchPayload.branch,
                      ...(launchPayload.sourceDirty ? { isolationNote: "the source checkout has uncommitted changes; only committed state was cloned" } : {}),
                    }
                  : isolationMode === "clone"
                    ? { isolationNote: "isolation was requested but the node did not return a run clone" }
                    : {}),
                ackPending: false,
                note: "Worker launched detached and survives relay timeouts. Poll with fleet_run_status(runId) or fleet_watch; fleet_resume finds it after interruptions.",
              };
              continue;
            }

            // Ambiguous: no error and no ack (unexpected shape). Report
            // honestly rather than inventing a valid handle.
            results[node.displayName ?? node.nodeId] = {
              runId,
              detached: true,
              ackPending: true,
              note:
                "Launch ack not received — the run may not have started. Verify with fleet_run_status(runId) before relying on this handle.",
            };
            continue;
          }

          // Issue #5/#11: an invoke timeout is NOT proof the run failed — but
          // neither is it proof the run is alive. Probe liveness and report
          // the actual state instead of the ambiguous "MAY still be live".
          const timedOut = (inv as { invokeTimedOut?: boolean }).invokeTimedOut === true;
          let dispatchResult: unknown;
          // Set when the silent-death reconcile below already recorded the run as failed;
          // the outcome upsert must not overwrite that.
          let reconciledDead = false;
          if (timedOut) {
            let probe: Record<string, unknown> = { probed: false };
            try {
              const stInv = await api.runtime.nodes.invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: { prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId },
                timeoutMs: 20_000,
                signal,
              });
              probe = payloadOf(stInv);
            } catch {
              probe = { probed: false, error: "liveness probe failed" };
            }
            const alive = probe.alive === true;
            const hasCompletion = Boolean(probe.finishedAt || probe.state === "finished" || probe.state === "aborted");
            const dead = !alive && !hasCompletion;
            // Reconcile the ledger: a dead run with no completion record is
            // marked failed, not left as timed-out/running (issue #11).
            if (dead) {
              // Keep the original entry (startedAt, engine, pid): this is a state
              // change of the same run, not a new one.
              await upsertRun(rootDir, {
                ...ledgerEntry,
                updatedAt: new Date().toISOString(),
                state: "failed",
                summary: "run died without completion record (silent death)",
              });
              reconciledDead = true;
            }
            dispatchResult = {
              ok: false,
              dispatchTimedOut: true,
              runState: dead ? "dead" : alive ? "running" : "unknown",
              note: dead
                ? `Run died without a completion record (no live process, no completion file). Marked failed in the ledger. Safe to re-dispatch.`
                : alive
                  ? `Run is LIVE on the node (pid ${probe.pid}). Poll with fleet_run_status(runId) or fleet_watch.`
                  : `Run state unknown after relay timeout. Check fleet_run_status(runId) before re-dispatching.`,
              error: (inv as { message?: string }).message,
            };
          } else {
            dispatchResult = inv;
          }

          // Post-dispatch working-tree state so the manager knows what state
          // the node is in (issue #4). Also serves as the live-run probe for
          // issue #5: fresh uncommitted changes mean the worker did something.
          let treeState: unknown;
          try {
            const stInv = await api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params: { prompt: "__STATUS__", cwd: p.cwd, transport: "http" },
              timeoutMs: 20000,
              signal,
            });
            const stPayload = (stInv as { payload?: unknown }).payload;
            treeState =
              typeof stPayload === "string" ? JSON.parse(stPayload) : stPayload;
          } catch {
            treeState = { ok: false, note: "status check failed" };
          }
          // Update the ledger with the outcome, extracting sessionId where
          // present so runs can be reattached after interruption.
          const payload = (dispatchResult as { payload?: unknown }).payload;
          const parsedResult =
            typeof payload === "string"
              ? (JSON.parse(payload) as { ok?: boolean; summary?: string; sessionId?: string; handRaised?: boolean; question?: string; verified?: boolean; verifyDetails?: unknown })
              : ((payload as { ok?: boolean; summary?: string; sessionId?: string; handRaised?: boolean; question?: string; verified?: boolean; verifyDetails?: unknown } | undefined) ?? {});
          // Same run, new state (see outcomeEntry): keeps startedAt/engine/pid and a
          // silent-death failure recorded above. outcomeEntry consults
          // parsed.verified too: a FAILED gate must not be laundered into a
          // ledger state "completed" — verifyDetails ride along in the ledger
          // so the failure survives node state cleanup (issue #40 review).
          await upsertRun(rootDir, outcomeEntry(ledgerEntry, { timedOut, reconciledDead, parsed: parsedResult }));

          // Issue #62: hoist the verify-gate outcome so a synchronous
          // dispatch result is not read as success while unverified.
          // Issue #40 review (finding: shape divergence): withVerified pins the
          // SAME shape for every outcome — absent expect => verified:null +
          // verifyDetails:null, identical to the detached / fleet_run_status
          // shape; no key omission on the no-gate path.
          // Issue #87, slice 3: OPT-IN S1 triage of a hand-raised question.
          // Default OFF: no `autoTriage` => no S1 call and no field added (the
          // per-node result stays byte-identical). With autoTriage the result
          // gains ONLY an s1.triage RECOMMENDATION — the run itself is never
          // answered or changed, and an unavailable decision escalates.
          let s1Triage: TriageResult | undefined;
          if (p.autoTriage === true && parsedResult.handRaised === true) {
            const { s1TriageIfRequested, triageContextFromRun } = await import("./s1-wire.js");
            s1Triage = await s1TriageIfRequested({
              autoTriage: true,
              question: parsedResult.question,
              context: triageContextFromRun({
                summary: parsedResult.summary,
                verifyDetails: parsedResult.verifyDetails,
                treeState,
              }),
            });
          }
          results[node.displayName ?? node.nodeId] = withVerified(
            {
              runId,
              result: dispatchResult,
              treeState,
              ...(s1Triage ? { s1: { triage: s1Triage } } : {}),
              ...(typeof parsedResult.verified === "boolean" && parsedResult.verified === false
                ? {
                    verifiedNote:
                      "VERIFICATION GATE FAILED (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails). Treat this run as unverified — do not report it as successful work.",
                  }
                : {}),
              ...(timedOut ? { dispatchTimedOut: true, mayStillBeRunning: true } : {}),
            },
            parsedResult,
          );
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_resume",
      label: "Fleet Resume",
      description:
        "Discover fleet work that may be in-flight after an interruption (agent session died, gateway restart, or worker died). Lists ledger runs that are not completed, probes each node for live processes and uncommitted changes, and classifies each run as live / finished-uncommitted / dead. Returns adoption guidance: attach (fleet_diff/fleet_sync) or discard. Call this at the start of any fleet interaction after an interruption.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", description: "Optional: inspect one run instead of all incomplete runs." },
          discard: { type: "boolean", description: "Discard mode: abort any live process on the node for the matched run(s) and mark them discarded. Default false (report only)." },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { runId?: string; discard?: boolean };
        const { loadLedger, upsertRun, probeRun } = await import("./ledger.js");
        const rootDir = api.rootDir ?? process.cwd();
        const runs = await loadLedger(rootDir);
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const hostFor = (name: string) =>
          nodes.find((n) => (n.displayName ?? n.nodeId) === name)?.remoteIp ?? name;

        const incomplete = runs.filter(
          (r) => (p.runId ? r.runId === p.runId : r.state === "running" || r.state === "timed-out"),
        );
        if (!incomplete.length) {
          return jsonResult({ incomplete: 0, note: "No in-flight fleet runs in the ledger." });
        }

        const findings: Array<Record<string, unknown>> = [];
        for (const run of incomplete) {
          const host = hostFor(run.node);
          const probe = await probeRun(host, run.cwd, { harness: run.harness, pid: run.pid });
          let status: string;
          if (probe.procRunning) status = "live";
          else if ((probe.uncommitted ?? -1) > 0) status = "finished-uncommitted";
          else status = "dead";

          const guidance =
            status === "live"
              ? "Run is LIVE on the node. Wait or reattach with fleet_diff/fleet_watch; do not re-dispatch."
              : status === "finished-uncommitted"
                ? `Worker finished (or died) with ${probe.uncommitted} uncommitted change(s). Adopt: run fleet_sync to commit+push them, or discard.`
                : "No live process and no changes — run died before doing work. Safe to re-dispatch or discard.";

          findings.push({
            runId: run.runId,
            node: run.node,
            cwd: run.cwd,
            prompt: run.prompt.slice(0, 120),
            startedAt: run.startedAt,
            ledgerState: run.state,
            procsRunning: probe.procRunning,
            procs: probe.procs,
            uncommittedChanges: probe.uncommitted,
            status,
            guidance,
          });

          if (p.discard) {
            // Issue #30 finding H: terminate by the RECORDED run (engine-
            // independent) and only mark it discarded once termination is
            // confirmed. A Pi worker is not killed by the old opencode pkill.
            let abortResult: Record<string, unknown> = { ok: false, error: "abort not attempted" };
            try {
              abortResult = payloadOf(
                await api.runtime.nodes.invoke({
                  nodeId: (nodes.find((n) => (n.displayName ?? n.nodeId) === run.node)?.nodeId) ?? run.node,
                  command: "opencode.run",
                  params: { prompt: "__ABORT__", cwd: run.cwd, transport: "http", runId: run.runId },
                  timeoutMs: 20000,
                  signal,
                }),
              );
            } catch (e) {
              abortResult = { ok: false, error: (e as Error).message };
            }
            findings[findings.length - 1].abort = abortResult;
            if (abortResult.ok === true) {
              await upsertRun(rootDir, { ...run, state: "discarded", updatedAt: new Date().toISOString() });
            }
          }
        }

        return jsonResult({
          incomplete: incomplete.length,
          discarded: p.discard === true,
          runs: findings,
        });
      },
    });

    api.registerTool({
      name: "fleet_run_report",
      label: "Fleet Run Report",
      description:
        "The audit manifest of a FINISHED fleet run (issue #42): files changed against the start commit, git diff --stat, commands the engine ran (when it reports them), exit code, duration, token/cost usage, verification result, scope, and event-log size, plus the dispatch spec from the ledger. Read it to see what an unattended run actually did (e.g. exit 0 with no files changed). Secrets are redacted. Fields that could not be captured are null/commandsRecorded:false, never an implied empty list.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          runId: { type: "string", description: "The fleet run id." },
        },
        required: ["node", "runId"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; runId: string };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const st = payloadOf(
          await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: { prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: p.runId, report: true },
            timeoutMs: 30_000,
            signal,
          }),
        );
        const { redactAudit } = await import("./audit.js");
        const { loadLedger } = await import("./ledger.js");
        const entry = (await loadLedger(api.rootDir ?? process.cwd())).find((r) => r.runId === p.runId);
        const run = entry
          ? { state: entry.state, harness: entry.harness, prompt: entry.prompt, spec: entry.spec, summary: entry.summary, verified: entry.verified ?? null }
          : undefined;
        if (!st.ok && st.error) return jsonResult(redactAudit({ ok: false, runId: p.runId, status: st.status ?? "missing-state", error: String(st.error), ...(run ? { run } : {}) }));
        if (!st.finishedAt) {
          return jsonResult(redactAudit({ ok: false, runId: p.runId, status: st.alive ? "running" : "no-completion-record", note: "the audit manifest is written once the run has finished; poll fleet_run_status", ...(run ? { run } : {}) }));
        }
        if (!st.manifest) {
          return jsonResult(redactAudit({ ok: true, runId: p.runId, manifest: null, note: "the node did not return a manifest (it predates the audit trail); upgrade opencode-fleet on the node", ...(run ? { run } : {}) }));
        }
        return jsonResult(redactAudit({ ok: true, runId: p.runId, manifest: st.manifest, ...(run ? { run } : {}) }));
      },
    });

    api.registerTool({
      name: "fleet_run_status",
      label: "Fleet Run Status",
      description:
        "Poll a detached fleet run: liveness, state (running/finished/aborted), exit code, and final output when complete. Reconciles the run ledger on terminal state. Use with the runId returned by an async fleet_dispatch; also detects the issue-#6 inconsistent state (ledger says running, no live process, no completion record).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          runId: { type: "string", description: "The fleet run id from the async dispatch result." },
          includeOutput: { type: "boolean", description: "Include the worker's final output when the run is finished (default true)." },
        },
        required: ["node", "runId"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; runId: string; includeOutput?: boolean };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const invoke = async (params: Record<string, unknown>, timeoutMs?: number) =>
          api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params,
            timeoutMs: timeoutMs ?? 20_000,
            signal,
          });

        const st = payloadOf(await invoke({ prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: p.runId }));
        if (!st.ok && st.error) {
          // Issue #6 inconsistency probe: no run state at all. Issue #21:
          // distinguish never-started from cleaned rather than one ambiguous
          // message, so an operator can tell a failed launch from a tidied run.
          const rawStatus = String(st.status ?? "missing-state");
          const status = rawStatus === "never-started" || rawStatus === "cleaned" ? rawStatus : "missing-state";
          return jsonResult({
            runId: p.runId,
            node: p.node,
            status,
            note: String(st.error),
            ...(status === "never-started"
              ? { guidance: "Launch was never acknowledged — the run did not start. Re-dispatch if work is expected." }
              : status === "cleaned"
                ? { guidance: "Run artifacts exist but state was cleaned; the run did start. See fleet_cleanup/logs." }
                : {}),
          });
        }
        const alive = st.alive === true;
        const finished = st.state === "finished" || st.state === "aborted" || typeof st.exitCode === "number";

        // Reconcile ledger when terminal.
        const { loadLedger, upsertRun } = await import("./ledger.js");
        const rootDir = api.rootDir ?? process.cwd();
        const ledger = await loadLedger(rootDir);
        const entry = ledger.find((r) => r.runId === p.runId);
        if (entry && (finished || entry.state === "running") && (st.finishedAt || !alive)) {
          // Worker process gone without a completion marker = silent death
          // (the exact issue #6 signature). Record it explicitly.
          // Issue #62 review (finding: ledger laundering): the gate outcome
          // rides with the run record — a clean exit whose gate FAILED must
          // reconcile to "failed-verification", never "completed". Process-
          // level failures keep "failed" (the gate only reclassifies the
          // would-be-completed branch); verified/verifyDetails are persisted
          // so the failure survives node state cleanup.
          const reconcileVerified = typeof st.verified === "boolean" ? st.verified : null;
          const state =
            !st.finishedAt
              ? "failed"
              : st.exitCode === 0 && reconcileVerified === false
                ? "failed-verification"
                : st.exitCode === 0
                  ? "completed"
                  : "failed";
          await upsertRun(rootDir, {
            ...(entry ?? { runId: p.runId, node: p.node, cwd: "", prompt: "", startedAt: new Date().toISOString() }),
            runId: p.runId,
            node: entry?.node ?? p.node,
            cwd: entry?.cwd ?? "",
            prompt: entry?.prompt ?? "",
            startedAt: entry?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state,
            ...(typeof st.exitCode === "number" ? { exitCode: st.exitCode } : {}),
            ...(reconcileVerified !== null ? { verified: reconcileVerified } : {}),
            ...(st.verifyDetails != null ? { verifyDetails: st.verifyDetails } : {}),
            summary:
              state === "failed" && !st.finishedAt
                ? "worker process died without completion record (silent death)"
                : state === "failed-verification"
                  ? "verification gate failed (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails)"
                  : undefined,
          });
        }

        let output: unknown;
        if (st.finishedAt && p.includeOutput !== false) {
          const res = payloadOf(await invoke({ prompt: "__RUN_RESULT__", cwd: "/", transport: "http", runId: p.runId }, 30_000));
          output = res.result;
        }

        return jsonResult({
          runId: p.runId,
          node: p.node,
          pid: st.pid,
          alive,
          state: st.state ?? (alive ? "running" : "unknown"),
          startedAt: st.startedAt,
          finishedAt: st.finishedAt,
          exitCode: st.exitCode,
          // Issue #62: the verification gate outcome (null = no gate was
          // configured). Do NOT fold it into ok/exitCode — it is a separate
          // signal, but a failed gate means the run must not be trusted.
          verified: typeof st.verified === "boolean" ? st.verified : null,
          verifyDetails: st.verifyDetails ?? null,
          // Issue #65 slice 2: advisory scope check. null = a scope was declared but
          // the node did not report (older node, still running, or git failed).
          ...(entry?.spec?.scope
            ? {
                scopeViolations: Array.isArray(st.scopeViolations) ? st.scopeViolations : null,
                ...(Array.isArray(st.changedFiles) ? { changedFiles: st.changedFiles } : {}),
                ...(st.scopeError ? { scopeNote: st.scopeError } : {}),
                ...(Array.isArray(st.scopeViolations) && st.scopeViolations.length
                  ? { scopeWarning: `${st.scopeViolations.length} changed file(s) fall outside the declared scope (advisory; review them).` }
                  : {}),
              }
            : {}),
          ...(st.verified === false
            ? {
                verifiedNote:
                  "VERIFICATION GATE FAILED (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails). Treat this run as unverified — do not report it as successful work.",
              }
            : {}),
          output,
        });
      },
    });

    api.registerTool({
      name: "fleet_answer",
      label: "Fleet Answer",
      description:
        "Answer a worker's hand-raised clarifying question and re-dispatch the task with the answer + prior context. Use when fleet_dispatch returns handRaised:true. The worker gets the answer and continues where it stopped.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          question: { type: "string", description: "The worker's question (from the handRaised result)." },
          answer: { type: "string", description: "Your answer / decision." },
          priorContext: { type: "string", description: "The original task prompt (so the worker keeps context)." },
          model: { type: "string", description: "Optional model override." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
          timeoutMs: { type: "number", description: "Per-node timeout, ms." },
        },
        required: ["node", "cwd", "question", "answer", "priorContext"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as {
          node: string;
          cwd: string;
          question: string;
          answer: string;
          priorContext: string;
          model?: string;
          transport?: "http" | "acp";
          timeoutMs?: number;
        };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);

        // Re-dispatch with the answer appended to the original context.
        const prompt = [
          p.priorContext,
          "",
          // Issue #35: the question came from a worker (model output), so it is
          // quoted as data and bounded; only `answer` is the caller's own voice.
          "A clarifying question was raised and answered:",
          `Q: ${sanitizeQuestion(p.question)}`,
          `A: ${p.answer}`,
          "Continue the task with this answer. Do not re-ask the same question.",
        ].join("\n");

        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: {
            prompt,
            cwd: p.cwd,
            transport: p.transport ?? "http",
            model: p.model,
            timeoutMs: p.timeoutMs ?? 300_000,
          },
          timeoutMs: p.timeoutMs ?? 300_000,
          signal,
        });
        return jsonResult(inv);
      },
    });

    api.registerTool({
      name: "fleet_iterate",
      label: "Fleet Iterate",
      description:
        "Dispatch a task and auto-iterate: if the worker's result indicates failure (build errors, test failures, or a hand-raise), re-dispatch with the errors appended until success, maxIterations, or NO-PROGRESS escalation. Tracks whether each iteration's output differs from the last — if the worker repeats the same errors (no progress), it escalates instead of burning tokens in a blind retry loop.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          prompt: { type: "string", description: "The task / goal for OpenCode." },
          maxIterations: { type: "number", description: "Max iterations before giving up (default 5)." },
          model: { type: "string", description: "Optional model override." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
          timeoutMs: { type: "number", description: "Per-iteration timeout, ms." },
          successMarker: {
            type: "string",
            description: "Optional string that indicates success (e.g. 'build succeeded'). If absent, treats any non-error result as success.",
          },
          noProgressEscalate: {
            type: "boolean",
            description: "Escalate (stop + report) when consecutive iterations produce identical output (no progress). Default true.",
          },
          expect: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: { type: "array", items: { type: "string" }, description: "Artifact paths that must exist after each iteration (relative to the run cwd and inside it: absolute paths and `..` are refused)." },
              command: { type: "string", description: "Verification command run via `bash -c` in the run cwd after the worker exits; must exit 0. Bounded to 120s (process group killed). It runs outside the engine's permission system, so it must be a repo-relative script path with plain arguments (e.g. `./scripts/check.sh --fast`) unless the operator set allowSetupCommands; an arbitrary shell command such as `npm test && echo ok` is refused." },
            },
            description: "Optional post-run verification gate (issue #62), identical to fleet_dispatch.expect: after each iteration the node records verified/verifyDetails on the result. An iteration with verified:false is NOT success — the loop keeps iterating (or escalates) instead of stopping there.",
          },
        },
        required: ["node", "cwd", "prompt"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as {
          node: string;
          cwd: string;
          prompt: string;
          maxIterations?: number;
          model?: string;
          transport?: "http" | "acp";
          timeoutMs?: number;
          successMarker?: string;
          noProgressEscalate?: boolean;
          expect?: { files?: string[]; command?: string };
        };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);

        // Issue #62 review (coverage gap): fleet_iterate accepts the same
        // optional verification gate as fleet_dispatch, validated up front and
        // threaded to the node on EVERY iteration.
        const { parseExpectSpec, withVerified, relayTimeoutWithGate } = await import("./verify.js");
        const expectSpec = parseExpectSpec(p.expect);
        if (!expectSpec.ok) {
          return jsonResult({ ok: false, error: `invalid expect: ${expectSpec.error}` });
        }
        // `expect.command` runs on the node OUTSIDE the engine's permission system,
        // so it gets the same rule as provision `setup`: a repo-relative script
        // path unless the operator allows arbitrary commands (issue #34).
        if (expectSpec.expect?.command) {
          const cmdCheck = checkSetup(expectSpec.expect.command, cfg.allowSetupCommands === true);
          if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.command: ${cmdCheck.error}` });
        }

        const maxIter = p.maxIterations ?? 5;
        const escalateOnNoProgress = p.noProgressEscalate ?? true;
        const iterations: Array<{ iter: number; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean | null; progress?: boolean }> = [];
        let currentPrompt = p.prompt;
        let prevFingerprint = "";
        // Last iteration's parsed outcome, in scope after the loop exits.
        let lastOutcome: { verified?: boolean; verifyDetails?: unknown } | null = null;

        for (let i = 1; i <= maxIter; i++) {
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: {
              prompt: currentPrompt,
              cwd: p.cwd,
              transport: p.transport ?? "http",
              model: p.model,
              timeoutMs: p.timeoutMs ?? 300_000,
              expect: expectSpec.expect,
            },
            timeoutMs: relayTimeoutWithGate(p.timeoutMs ?? 300_000, expectSpec.expect !== undefined),
            signal,
          });
          const payload = (inv as { payload?: unknown }).payload;
          const parsed =
            typeof payload === "string"
              ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown })
              : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown } | undefined) ?? {});
          const verified = typeof parsed.verified === "boolean" ? parsed.verified : null;
          lastOutcome = parsed;

          // Fingerprint the output to detect progress (or lack thereof).
          const fingerprint = (parsed.summary ?? "").slice(0, 500) + "|" + (parsed.error ?? "").slice(0, 500);
          const progress = i === 1 ? true : fingerprint !== prevFingerprint;
          prevFingerprint = fingerprint;

          iterations.push({
            iter: i,
            summary: parsed.summary,
            handRaised: parsed.handRaised,
            question: parsed.question,
            error: parsed.error,
            verified,
            progress,
          });

          // Hand-raise: stop and let the caller answer.
          if (parsed.handRaised) {
            return jsonResult({ iterations, handRaised: true, question: parsed.question, done: false });
          }

          // Success check.
          // Issue #35: trust the exit-status-derived `ok`; only fall back to the
          // output regex for a node that predates it (ok undefined).
          // Issue #62 review (coverage gap): a FAILED verification gate is NOT
          // success even when ok is true — verified === false must never be
          // reported as done/success.
          const looksFailed = parsed.ok === undefined
            ? /error|failed|timed out|stuck/i.test(parsed.summary ?? "")
            : parsed.ok === false;
          const success =
            (p.successMarker ? (parsed.summary ?? "").includes(p.successMarker) : !looksFailed) && verified !== false;
          if (success) {
            return jsonResult(withVerified({ iterations, done: true, success: true, finalSummary: parsed.summary }, parsed));
          }

          // NO-PROGRESS escalation: same output as last iteration → stop, don't burn tokens.
          if (escalateOnNoProgress && i > 1 && !progress) {
            return jsonResult({
              iterations,
              done: false,
              success: false,
              escalated: true,
              reason: "no progress across iterations (identical output)",
              recommendation:
                "Escalate: switch to a heavier model, change the approach, or hand off to a human. Do not keep retrying the same prompt.",
            });
          }

          // Re-dispatch with the failure context appended.
          currentPrompt = [
            p.prompt,
            "",
            `Iteration ${i} did not succeed. The worker reported:`,
            parsed.summary ? quoteUntrusted("output", parsed.summary) : "",
            parsed.error ? quoteUntrusted("error", parsed.error) : "",
            ...(verified === false
              ? ["The post-run verification gate FAILED: the run must actually produce the artifacts/commands in `expect` — do not claim completion without them."]
              : []),
            "",
            "Fix the issues above and try again. Do not repeat the same approach.",
          ].join("\n");
        }

        return jsonResult(
          withVerified({ iterations, done: true, success: false, note: `exceeded ${maxIter} iterations` }, lastOutcome),
        );
      },
    });

    api.registerTool({
      name: "fleet_watch",
      label: "Fleet Watch",
      description:
        "Dispatch a task and watch it live: streams progress updates to the agent as the worker runs (via onUpdate), polls the node's activity, and returns the final result when the task completes. This is the monitoring view — use it when you want to see a task in progress rather than fire-and-forget.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          prompt: { type: "string", description: "The task / goal for OpenCode." },
          model: { type: "string", description: "Optional model override." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport." },
          timeoutMs: { type: "number", description: "Per-run timeout, ms." },
          pollMs: { type: "number", description: "Activity poll interval, ms (default 15000)." },
          expect: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: { type: "array", items: { type: "string" }, description: "Artifact paths that must exist after the run (relative to the run cwd and inside it: absolute paths and `..` are refused)." },
              command: { type: "string", description: "Verification command run via `bash -c` in the run cwd after the worker exits; must exit 0. Bounded to 120s (process group killed). It runs outside the engine's permission system, so it must be a repo-relative script path with plain arguments (e.g. `./scripts/check.sh --fast`) unless the operator set allowSetupCommands; an arbitrary shell command such as `npm test && echo ok` is refused." },
            },
            description: "Optional post-run verification gate (issue #62), identical to fleet_dispatch.expect: after the worker exits the node records verified/verifyDetails on the result. A FAILED gate means the watched run must not be reported as successful work.",
          },
        },
        required: ["node", "cwd", "prompt"],
      },
      execute: async (toolCallId, params, signal, onUpdate) => {
        const p = params as {
          node: string;
          cwd: string;
          prompt: string;
          model?: string;
          transport?: "http" | "acp";
          timeoutMs?: number;
          pollMs?: number;
          expect?: { files?: string[]; command?: string };
        };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);

        // Issue #62 review (coverage gap): fleet_watch accepts the same
        // optional verification gate as fleet_dispatch — validated up front
        // and threaded to the node on every watch.
        const { parseExpectSpec, withVerified, relayTimeoutWithGate } = await import("./verify.js");
        const expectSpec = parseExpectSpec(p.expect);
        if (!expectSpec.ok) {
          return jsonResult({ ok: false, error: `invalid expect: ${expectSpec.error}` });
        }
        // `expect.command` runs on the node OUTSIDE the engine's permission system,
        // so it gets the same rule as provision `setup`: a repo-relative script
        // path unless the operator allows arbitrary commands (issue #34).
        if (expectSpec.expect?.command) {
          const cmdCheck = checkSetup(expectSpec.expect.command, cfg.allowSetupCommands === true);
          if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.command: ${cmdCheck.error}` });
        }

        const timeoutMs = p.timeoutMs ?? 300_000;
        const pollMs = p.pollMs ?? 15_000;
        const startedAt = Date.now();

        // Kick off the dispatch (fire-and-forget from the tool's perspective;
        // we monitor via activity polling).
        const dispatchPromise = api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: {
            prompt: p.prompt,
            cwd: p.cwd,
            transport: p.transport ?? "http",
            model: p.model,
            timeoutMs,
            expect: expectSpec.expect,
          },
          timeoutMs: relayTimeoutWithGate(timeoutMs, expectSpec.expect !== undefined),
          signal,
        });

        // Poll activity and stream progress until the dispatch settles.
        let settled = false;
        let lastActivity = "";
        const pollLoop = (async () => {
          while (!settled && Date.now() - startedAt < timeoutMs) {
            await new Promise((r) => setTimeout(r, pollMs));
            if (settled) break;
            try {
              const inv = await api.runtime.nodes.invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: { prompt: "__ACTIVITY__", cwd: "/", transport: "http" },
                timeoutMs: 15000,
                signal,
              });
              const payload = (inv as { payload?: unknown }).payload;
              const parsed =
                typeof payload === "string"
                  ? (JSON.parse(payload) as { activity?: Array<{ pid?: number; elapsed?: string; cpu?: string; command?: string }> })
                  : ((payload as { activity?: Array<{ pid?: number; elapsed?: string; cpu?: string; command?: string }> } | undefined) ?? {});
              const procs = parsed.activity ?? [];
              const summary = procs.length
                ? `${procs.length} opencode process(es) running (${procs.map((x) => x.elapsed ?? "?").join(", ")} elapsed)`
                : "no opencode process running";
              if (summary !== lastActivity) {
                lastActivity = summary;
                onUpdate?.({
                  content: [{ type: "text", text: summary }],
                  details: { progress: summary },
                  progress: { text: summary, visibility: "channel", privacy: "public" },
                });
              }
            } catch {
              // Activity poll is best-effort.
            }
          }
        })();

        const result = await dispatchPromise;
        settled = true;
        await pollLoop;

        const payload = (result as { payload?: unknown }).payload;
        const parsed =
          typeof payload === "string"
            ? (JSON.parse(payload) as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown })
            : ((payload as { ok?: boolean; summary?: string; handRaised?: boolean; question?: string; error?: string; verified?: boolean; verifyDetails?: unknown } | undefined) ?? {});
        const watchedVerified = typeof parsed.verified === "boolean" ? parsed.verified : null;

        onUpdate?.({
          content: [{ type: "text", text: `Task complete: ${parsed.summary ?? "(no summary)"}${watchedVerified === false ? " — VERIFICATION GATE FAILED (issue #62)" : ""}` }],
          details: { progress: "complete" },
          progress: { text: "Task complete", visibility: "channel", privacy: "public" },
        });

        // Issue #62 review: surface the gate outcome with the SAME shape as
        // fleet_run_status / the sync dispatch path (verified always present,
        // verifyDetails alongside) so a watched run's gate failure is visible
        // and must not be reported as successful work.
        return jsonResult(
          withVerified(
            {
              done: true,
              ok: parsed.ok,
              summary: parsed.summary,
              handRaised: parsed.handRaised,
              question: parsed.question,
              error: parsed.error,
              elapsedMs: Date.now() - startedAt,
              ...(watchedVerified === false
                ? {
                    verifiedNote:
                      "VERIFICATION GATE FAILED (issue #62): the worker exited but did not satisfy `expect` (see verifyDetails). Treat this run as unverified — do not report it as successful work.",
                  }
                : {}),
            },
            parsed,
          ),
        );
      },
    });

    api.registerTool({
      name: "fleet_provision",
      label: "Fleet Provision",
      description:
        "Provision a repository to one or more fleet nodes WITHOUT giving them GitHub credentials. The manager clones the repo (with its own credentials), ships a git bundle to the node, and the node unpacks it into the target directory. Workers stay credential-free and offline-capable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          repo: { type: "string", description: "Git URL the manager can access (e.g. git@github.com:org/repo)." },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          branch: { type: "string", description: "Branch to check out (default main)." },
          commit: { type: "string", description: "Optional commit SHA to check out." },
          cwd: {
            type: "string",
            description:
              "Target directory on the node(s). Issue #26: defaults to a workspace the worker principal can actually enter (<fleetRoot>/<repo>), instead of a /root path the service user cannot traverse.",
          },
          setup: {
            type: "string",
            description:
              "Optional repo-declared setup command to run on each node after checkout (issue #19), a repo-relative script path with plain arguments, e.g. \"scripts/setup.sh\" or \"./setup.sh --fast\" (the path must contain a \"/\"). Arbitrary shell commands (pipelines, &&, e.g. \"python3 -m venv .venv && ...\") are refused unless the operator sets allowSetupCommands. Lets a repo declare its own environment bootstrap so 'provisioned' means 'can run the tests'. Reported per node; never hardcoded.",
          },
        },
        required: ["repo"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { repo: string; cwd?: string; nodes?: string[]; branch?: string; commit?: string; setup?: string };
        const { createRepoBundle, provisionToNode, cleanupBundle } = await import("./provision.js");
        // Issue #34: refuse an arbitrary-shell `setup` unless the operator allows it.
        const setupCheck = checkSetup(p.setup ?? "", cfg.allowSetupCommands === true);
        if (!setupCheck.ok) return jsonResult({ ok: false, error: setupCheck.error });
        // Issue #26: default the landing path to a workspace the worker
        // principal can actually enter, instead of a /root path it cannot.
        const { defaultFleetCwd, resolveFleetRoot } = await import("./cwd.js");

        // Resolve target nodes.
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(`No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}. Configure \`nodes\` (or \`nodePrefixes\`) in the plugin config.`);
        }
        // The worker principal is serviceUser, defaulting to the login user (same rule as dispatch/deploy).
        let fleetRoot: string | undefined;
        try {
          fleetRoot = resolveFleetRoot(cfg, targets.map((n) => {
            const m = (n as { member?: { serviceUser?: string; user?: string } }).member;
            return m?.serviceUser ?? m?.user;
          }));
        } catch (e) {
          return jsonResult({ ok: false, error: (e as Error).message });
        }
        const targetCwd = p.cwd ?? (fleetRoot ? defaultFleetCwd(p.repo, fleetRoot) : undefined);
        if (!targetCwd) {
          return jsonResult({ ok: false, error: "no cwd given and no fleet root known: pass cwd, set fleetRoot in the plugin config, or give every target node the same serviceUser" });
        }

        // Create the bundle once (manager-side, with manager creds).
        const bundle = await createRepoBundle({ repo: p.repo, cwd: targetCwd, branch: p.branch, commit: p.commit });
        if (bundle.error || !bundle.bundlePath) {
          return jsonResult({ ok: false, error: bundle.error ?? "bundle creation failed" });
        }

        // Ship to each node via SSH (manager has SSH access to nodes).
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          // Node-channel fallback for SSH-free nodes (e.g. Windows): ships the
          // bundle in chunks through opencode.run control messages.
          const channelInvoke = async (params: Record<string, unknown>, timeoutMs?: number) =>
            api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params,
              timeoutMs: timeoutMs ?? 60_000,
              signal,
            });
          const r = await provisionToNode(
            host,
            bundle.bundlePath,
            {
              repo: p.repo,
              cwd: targetCwd,
              branch: p.branch,
              commit: p.commit,
              setup: p.setup,
              allowSetupCommands: cfg.allowSetupCommands === true,
              serviceUser: (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
                ?? (node as { member?: { user?: string } }).member?.user,
            },
            channelInvoke,
          );
          results[node.displayName ?? node.nodeId] = r;
        }
        // Clean up the manager-side bundle + staging dir to avoid bloat.
        await cleanupBundle(bundle.bundlePath);
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_provision_config",
      label: "Fleet Provision Config",
      description:
        "Ship OpenCode agent definitions, global rules (AGENTS.md), skills, and opencode.json to fleet nodes so workers work consistently with the manager. The manager holds the source-of-truth config; workers get it via SSH (no worker credentials needed).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          configDir: {
            type: "string",
            description: "Local dir containing agents/, skills/, AGENTS.md, opencode.json to ship. Defaults to plugin's config dir.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[]; configDir?: string };
        const { provisionConfigToNode, discoverLocalConfig } = await import("./config-provision.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) return jsonResult(`No fleet nodes found.`);

        // Discover what config is available to ship (report search paths).
        const baseDir = p.configDir ?? join(api.rootDir ?? process.cwd(), "config");
        const local = await discoverLocalConfig(baseDir);
        if (!local.agentsDir && !local.globalRulesFile && !local.skillsDir && !local.opencodeConfigFile) {
          return jsonResult({
            ok: false,
            searched: local.report.searched,
            missing: local.report.missing,
            note: `No config found. Create agents/, skills/, AGENTS.md, or opencode.json under the searched paths above.`,
          });
        }

        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await provisionConfigToNode(host, local);
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_sync",
      label: "Fleet Sync",
      description:
        "Pull changes made on a fleet node back to GitHub. The worker creates a bundle of its changes; the manager applies and pushes with its own credentials. Workers never need GitHub credentials.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          cwd: { type: "string", description: "Working directory on the node." },
          repo: { type: "string", description: "Git URL the manager can access." },
          allowUnverified: { type: "boolean", description: "Publish even though the latest fleet run on this node and checkout FAILED its verification gate (or, with sync.requireVerified, has none). Off by default." },
          branch: { type: "string", description: "Clone BASE branch: a branch that already EXISTS on origin, checked out so the worker's changes can be applied on top of it (default main). NOT the destination — the destination is resolved from the worker's own branch (or from a pinned destination set internally); a protected destination is redirected to `fleet/<name>` and reported as `redirectedFrom`." },
        },
        required: ["node", "cwd", "repo"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; cwd: string; repo: string; branch?: string; allowUnverified?: boolean };
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const node = nodes.find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const host = node.remoteIp ?? node.displayName ?? node.nodeId;
        const cfg = (api.pluginConfig ?? {}) as FleetConfig;
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const member = fleet.find((t) => (t.displayName ?? t.nodeId) === (node.displayName ?? node.nodeId))?.member;

        // Issue #65: do not publish work whose verification gate failed.
        const { loadLedger, latestRunFor, syncGate } = await import("./ledger.js");
        const gate = syncGate(
          latestRunFor(await loadLedger(api.rootDir ?? process.cwd()), [node.displayName, node.nodeId].filter((x): x is string => !!x), p.cwd),
          { allowUnverified: p.allowUnverified === true, requireVerified: cfg.sync?.requireVerified === true },
        );
        if (!gate.allow) return jsonResult({ ok: false, error: gate.reason, verified: gate.verified, ...(gate.runId ? { runId: gate.runId } : {}) });
        const gateNote = gate.reason ? { verifiedNote: gate.reason, verified: gate.verified } : { verified: gate.verified };

        // SSH-free node: bundle on the worker via the node channel, pull the
        // base64 back in chunks, then push with manager credentials.
        if (member?.ssh === false) {
          const transferId = `sync-${Date.now()}`;
          const invoke = async (params: Record<string, unknown>, timeoutMs?: number) =>
            api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params,
              timeoutMs: timeoutMs ?? 60_000,
              signal,
            });
          const bundleInv = await invoke({ prompt: "__BUNDLE__", cwd: p.cwd, transport: "http", transferId }, 120_000);
          const bundlePl = payloadOf(bundleInv);
          if (!bundlePl.ok) return jsonResult({ ok: false, error: bundlePl.error ?? "worker bundle failed" });
          const parts: string[] = [];
          for (let i = 0; ; i++) {
            const c = payloadOf(await invoke({ prompt: "__SEND_CHUNK__", cwd: "/", transport: "http", transferId, chunkIndex: i }, 60_000));
            if (c.done) break;
            if (!c.ok || typeof c.data !== "string") return jsonResult({ ok: false, error: c.error ?? "chunk read failed" });
            parts.push(c.data);
          }
          const assembled = parts.join("");
          // Fail closed: node responses are not trusted, so a missing or
          // malformed digest is as bad as a mismatch (node predating #38?).
          if (typeof bundlePl.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundlePl.sha256)) {
            return jsonResult({ ok: false, error: "worker did not return a bundle sha256; upgrade the node (opencode-fleet with checksum support) before syncing over the node channel" });
          }
          if (!isCanonicalBase64(assembled)) {
            return jsonResult({ ok: false, error: "reassembled worker bundle is not canonical base64" });
          }
          const got = createHash("sha256").update(Buffer.from(assembled, "base64")).digest("hex");
          if (got !== bundlePl.sha256) {
            return jsonResult({ ok: false, error: "worker bundle checksum mismatch after transfer; refusing to push a corrupted bundle" });
          }
          const { syncFromNode } = await import("./provision.js");
          const r = await syncFromNode("local", p.cwd, p.repo, p.branch ?? "main", {
            mode: "from-base64",
            base64: assembled,
            branch: p.branch ?? "main",
            // The branch the worker actually has checked out (SSH-free path), so a
            // feature-branch worker publishes its own commits instead of the base.
            workerBranch: typeof bundlePl.branch === "string" ? bundlePl.branch : undefined,
            destBranch: p.branch,
          }, undefined, cfg.sync);
          return jsonResult({ ...r, ...gateNote, viaChannel: true });
        }

        const { syncFromNode } = await import("./provision.js");
        const r = await syncFromNode(host, p.cwd, p.repo, p.branch ?? "main", undefined, p.branch, cfg.sync);
        return jsonResult({ ...r, ...gateNote });
      },
    });

    api.registerTool({
      name: "fleet_cleanup",
      label: "Fleet Cleanup",
      description:
        "Keep fleet nodes tidy: run git GC on checkouts to prevent bloat and report disk usage. Node-side git bundles stage in per-run PRIVATE state dirs and every provision/sync run cleans its own staging (issue #63), so nothing is swept on other runs' behalf. Run periodically to avoid node bloat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
          cwd: { type: "string", description: "Optional checkout dir to GC on each node." },
          discardUnsyncedClones: { type: "boolean", description: "Also delete finished runs' isolated clones (issue #41) that hold commits or changes beyond their start commit. Off by default: unsynced work is kept and listed under keptUnsynced, never deleted silently." },
          pruneOlderThanDays: { type: "number", description: "Also delete finished runs' scripts/logs/state/done files and stale transfer staging older than this many days from the node's private state dir (default 7; 0 skips). A run whose script is still alive is never touched. Needs a node on protocol 3+." },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[]; cwd?: string; pruneOlderThanDays?: number; discardUnsyncedClones?: boolean };
        const { cleanupNode } = await import("./provision.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(`No fleet nodes found.`);
        }
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          const entry: Record<string, unknown> = await cleanupNode(host, p.cwd);
          // Issue #63: prune finished runs from the node's private state dir.
          const pruneDays = p.pruneOlderThanDays ?? 7;
          if (pruneDays > 0) {
            try {
              const pr = await api.runtime.nodes.invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: { prompt: "__PRUNE__", cwd: "/", transport: "http", op: "state.prune", olderThanDays: pruneDays, ...(p.discardUnsyncedClones ? { discardUnsyncedClones: true } : {}) },
                timeoutMs: 30000,
                signal,
              });
              const pp = (pr as { payload?: unknown }).payload;
              // A policy refusal (e.g. a node below protocol 3) may come back as a result
              // without a payload rather than a throw: report it, never silently drop it.
              entry.prune = pp === undefined || pp === null
                ? { ok: false, error: String((pr as { message?: unknown }).message ?? "node did not run the prune (no payload; node may predate protocol 3)") }
                : typeof pp === "string" ? JSON.parse(pp) : pp;
            } catch (e) {
              entry.prune = { ok: false, error: (e as Error).message };
            }
          }
          // Report (not delete) uncommitted worker changes (issue #4).
          if (p.cwd) {
            try {
              const stInv = await api.runtime.nodes.invoke({
                nodeId: node.nodeId,
                command: "opencode.run",
                params: { prompt: "__STATUS__", cwd: p.cwd, transport: "http" },
                timeoutMs: 20000,
                signal,
              });
              const stPayload = (stInv as { payload?: unknown }).payload;
              entry.treeState = typeof stPayload === "string" ? JSON.parse(stPayload) : stPayload;
            } catch {
              entry.treeState = { ok: false, note: "status check failed" };
            }
          }
          results[node.displayName ?? node.nodeId] = entry;
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_deploy",
      label: "Fleet Deploy",
      description:
        "One-command deploy of the opencode-fleet plugin: build, pack, install on the gateway + all worker nodes, restart node services. Returns a gatewayRestartRequired signal — the caller must perform the final gateway restart (it kills the session). Use after any plugin code change.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pluginDir: {
            type: "string",
            description: "Plugin repo root (where package.json lives). Defaults to the plugin's own dir.",
          },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node SSH hosts to deploy to. Omit for all fleet nodes.",
          },
          restartNodes: { type: "boolean", description: "Restart node services after install (default true)." },
          selfCheck: {
            type: "boolean",
            description:
              "After install+restart, run a trivial dispatch on each node and require the token back; fail the deploy if it does not (default true). Hash-equality proves the file matches, not that the plugin works.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { pluginDir?: string; nodes?: string[]; restartNodes?: boolean; selfCheck?: boolean };
        const { deployPlugin } = await import("./deploy.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        const hosts = targets.map((n) => n.remoteIp ?? n.displayName ?? n.nodeId);
        // Issue #18: thread each node's service principal (and SSH login user)
        // from membership config, so installs land in the right plugin root and
        // verification checks the build the running process will actually load.
        const nodeUsers: Record<string, string> = {};
        const nodeLoginUsers: Record<string, string> = {};
        for (const n of targets) {
          const host = n.remoteIp ?? n.displayName ?? n.nodeId;
          const svc = n.member?.serviceUser ?? n.member?.user;
          if (svc) nodeUsers[host] = svc;
          if (n.member?.user) nodeLoginUsers[host] = n.member.user;
        }
        const pluginDir = p.pluginDir ?? join(api.rootDir ?? process.cwd(), "..");
        const r = await deployPlugin({
          pluginDir,
          nodes: hosts,
          nodeUsers,
          nodeLoginUsers,
          restartNodes: p.restartNodes ?? true,
          selfCheck: p.selfCheck,
        });
        return jsonResult(r);
      },
    });

    api.registerTool({
      name: "fleet_recipe_recommend",
      label: "Fleet Recipe Recommend",
      description:
        "Recommend the best (model, thinking, agent, transport) combo for a task type + codebase, learned from past outcomes. Gives agents knobs to turn for speed / token efficiency: use a light model for simple tasks, a heavier model for complex ones, and a review-grade model for review. Returns the recommended combo and whether it was learned or a default.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskType: {
            type: "string",
            enum: ["simple-fix", "refactor", "feature", "review", "explore"],
            description: "Type of task.",
          },
          codebase: { type: "string", description: "Repo or codebase name." },
        },
        required: ["taskType", "codebase"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { taskType: string; codebase: string };
        const { recommendCombo, seedDefaults, resolveModelForClass } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        const seed = seedDefaults().find((d) => d.taskType === p.taskType);
        const defaults = seed?.combo ?? {
          model: "aperture-anthropic/glm-5.3-flash:cloud",
          transport: "http",
        };
        const rec = await recommendCombo(storePath, p.taskType, p.codebase, defaults);

        // Resolve the recommended model class against the CURRENT catalog so
        // the recommendation survives model churn (4-6 week cycle).
        let availableModels: string[] = [];
        try {
          // No catalog configured: skip live resolution and use the stored model.
          const res = cfg.apertureUrl ? await fetch(cfg.apertureUrl, { signal }) : undefined;
          if (res?.ok) {
            const data = (await res.json()) as { data?: Array<{ id?: string }> };
            availableModels = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
          }
        } catch {
          // Catalog unavailable — use the stored model as-is.
        }
        const modelClass = seed?.modelClass ?? "mid";
        const resolvedModel = resolveModelForClass(modelClass, availableModels, rec.combo.model);

        return jsonResult({
          ...rec,
          modelClass,
          resolvedModel,
          note:
            "Model resolved to the current catalog for its capability class, so the recipe stays valid as models churn.",
        });
      },
    });

    api.registerTool({
      name: "fleet_recipe_record",
      label: "Fleet Recipe Record",
      description:
        "Record the outcome of a fleet dispatch (combo used, tokens, cost, success, churn) so the recipe store learns which LLM/tooling/prompt combos work for which codebases and tasks. Call this after each dispatch to improve future recommendations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskType: { type: "string", description: "Type of task (simple-fix, refactor, feature, review, explore)." },
          codebase: { type: "string", description: "Repo or codebase name." },
          model: { type: "string", description: "Model used." },
          thinking: { type: "string", enum: ["low", "medium", "high"], description: "Thinking level used." },
          agent: { type: "string", description: "Agent used (build, plan, code-reviewer, explore)." },
          transport: { type: "string", enum: ["http", "acp"], description: "Transport used." },
          tokens: { type: "number", description: "Token usage." },
          cost: { type: "number", description: "Cost in USD." },
          success: { type: "boolean", description: "Whether the task succeeded. Not trusted on its own: with runId, a run whose verification gate or process FAILED is recorded as a failure whatever is passed here." },
          runId: { type: "string", description: "The fleet runId this outcome is about. When given, success is derived from the run's recorded result (verified/state), never from self-report alone." },
          churn: { type: "boolean", description: "Whether the task churned (too-light model / repeated attempts)." },
          rating: { type: "number", description: "Subjective rating 1-5 (5 = excellent fit for this task)." },
          goodFor: { type: "string", description: "What this combo was good for (indication)." },
          badFor: { type: "string", description: "What this combo was bad for (contraindication)." },
          notes: { type: "string", description: "Free-text notes on what worked." },
        },
        required: ["taskType", "codebase", "model", "success"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as {
          taskType: string;
          codebase: string;
          model: string;
          thinking?: "low" | "medium" | "high";
          agent?: string;
          transport?: "http" | "acp";
          tokens?: number;
          cost?: number;
          success: boolean;
          runId?: string;
          churn?: boolean;
          rating?: number;
          goodFor?: string;
          badFor?: string;
          notes?: string;
        };
        const { recordOutcome } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        // Issue #65: success derives from the recorded run, not from self-report.
        let derived = { success: p.success, overridden: false };
        if (p.runId) {
          const { loadLedger, recipeSuccess } = await import("./ledger.js");
          derived = recipeSuccess(p.success, (await loadLedger(api.rootDir ?? process.cwd())).find((r) => r.runId === p.runId));
        }
        const entry = await recordOutcome(storePath, {
          taskType: p.taskType,
          codebase: p.codebase,
          combo: { model: p.model, thinking: p.thinking, agent: p.agent, transport: p.transport },
          tokens: p.tokens,
          cost: p.cost,
          success: derived.success,
          churn: p.churn,
          rating: p.rating,
          goodFor: p.goodFor,
          badFor: p.badFor,
          notes: derived.overridden ? `${p.notes ? `${p.notes}\n` : ""}success overridden to false: run ${p.runId} failed (verification gate or process).` : p.notes,
          timestamp: new Date().toISOString(),
        });
        return jsonResult(derived.overridden ? { ...entry, successOverridden: true } : entry);
      },
    });

    api.registerTool({
      name: "fleet_recipe_list",
      label: "Fleet Recipe List",
      description: "List all learned fleet recipes (task type + codebase + combo + stats) so agents can see what combos have been tried and how they performed.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const { loadStore } = await import("./recipes.js");
        const storePath = join(api.rootDir ?? process.cwd(), "recipes.json");
        const store = await loadStore(storePath);
        return jsonResult(store.recipes);
      },
    });

    api.registerTool({
      name: "fleet_models",
      label: "Fleet Models",
      description:
        "List the LLM models available to OpenCode on fleet nodes (via the Aperture gateway). Returns model ids, provider, context window, and pricing so you can pick the right model per task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: {
            type: "string",
            description: "Optional node to query. Omit to query the Aperture gateway directly.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node?: string };
        // If a node is specified, read its OpenCode config for the model catalog.
        if (p.node) {
          const list = await api.runtime.nodes.list();
          const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
          if (!node) return jsonResult(`Node "${p.node}" not found.`);
          const inv = await api.runtime.nodes.invoke({
            nodeId: node.nodeId,
            command: "opencode.run",
            params: { prompt: "__MODELS__", cwd: "/", transport: "http" },
            timeoutMs: 20000,
            signal,
          });
          return jsonResult(inv);
        }
        // Otherwise query the Aperture gateway directly.
        const apertureUrl = cfg.apertureUrl;
        if (!apertureUrl) {
          return jsonResult("No model catalog configured: set apertureUrl in the opencode-fleet plugin config (an OpenAI-style /v1/models URL), or use nodes that report their own models.");
        }
        try {
          const res = await fetch(apertureUrl, { signal });
          if (!res.ok) return jsonResult(`Aperture gateway returned ${res.status}.`);
          const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
          const models = (data.data ?? []).map((m) => ({
            id: m.id,
            displayName: m.display_name,
            contextWindow: m.context_window_tokens,
            maxOutput: m.max_output_tokens,
            pricing: m.pricing,
            provider: (m.metadata as { provider?: { name?: string } } | undefined)?.provider?.name,
          }));
          return jsonResult(models);
        } catch (err) {
          return jsonResult(`Failed to query Aperture: ${(err as Error).message}`);
        }
      },
    });

    api.registerTool({
      name: "fleet_status",
      label: "Fleet Status",
      description: "Show health and connectivity of all fleet OpenCode nodes (dev2, dev3, ...).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const list = await api.runtime.nodes.list();
        return jsonResult(
          (list.nodes ?? []).map((n) => ({
            node: n.displayName ?? n.nodeId,
            id: n.nodeId,
            connected: n.connected ?? false,
            platform: n.platform,
            commands: n.commands ?? [],
            invocable: n.invocableCommands ?? [],
          })),
        );
      },
    });

    api.registerTool({
      name: "fleet_activity",
      label: "Fleet Activity",
      description:
        "Show running OpenCode processes on fleet nodes: pid, elapsed time, cpu, and command. SSHes into each node and inspects its process table so you can see which nodes are busy before dispatching more work.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[] };
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) {
          return jsonResult(
            `No fleet nodes found. Paired nodes: ${nodes.map((n) => n.displayName ?? n.nodeId).join(", ") || "none"}`,
          );
        }
        const results: Record<string, NodeActivityEntry[] | { error: string } | { skipped: string }> = {};
        for (const node of targets) {
          // Issue #8: skip nodes that don't support opencode.run (e.g. the
          // Windows desktop node) instead of failing the whole call.
          const invocable = (node as { invocableCommands?: string[] }).invocableCommands ?? [];
          if (!invocable.includes("opencode.run")) {
            results[node.displayName ?? node.nodeId] = { skipped: "not an opencode node (no opencode.run command)" };
            continue;
          }
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await getNodeActivity(host, async () => {
            // Fallback: ask the node host command to run ps locally.
            const inv = await api.runtime.nodes.invoke({
              nodeId: node.nodeId,
              command: "opencode.run",
              params: { prompt: "__ACTIVITY__", cwd: "/", transport: "http" },
              timeoutMs: 20000,
              signal,
            });
            const payload = (inv as { payload?: unknown }).payload;
            const parsed =
              typeof payload === "string"
                ? (JSON.parse(payload) as { activity?: NodeActivityEntry[]; error?: string })
                : ((payload as { activity?: NodeActivityEntry[]; error?: string } | undefined) ?? {});
            if (parsed.activity) return parsed.activity;
            return { error: parsed.error ?? "node returned no activity" };
          });
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_capabilities",
      label: "Fleet Capabilities",
      description:
        "Detect and report each fleet node's capabilities (CPU, RAM, disk, GPU, installed tools, available models). Use this to route work to nodes that can handle it, especially when nodes have diverging capabilities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node display names or ids. Omit for all fleet nodes.",
          },
        },
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { nodes?: string[] };
        const { detectNodeCapabilities } = await import("./capabilities.js");
        const list = await api.runtime.nodes.list();
        const nodes = list.nodes ?? [];
        const fleet = (await import("./membership.js")).resolveFleetNodes(nodes, cfg);
        const targets = p.nodes?.length
          ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
          : fleet;
        if (!targets.length) return jsonResult(`No fleet nodes found.`);
        const results: Record<string, unknown> = {};
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          results[node.displayName ?? node.nodeId] = await detectNodeCapabilities(host, node.displayName ?? node.nodeId);
        }
        return jsonResult(results);
      },
    });

    api.registerTool({
      name: "fleet_abort",
      label: "Fleet Abort",
      description: "Abort a run on a fleet node. Needs the runId (from fleet_dispatch); a sessionId is accepted if the ledger knows the run it belongs to. Never kills by name pattern.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          sessionId: { type: "string", description: "Session id; resolved to its runId through the ledger when runId is omitted." },
          runId: { type: "string", description: "The runId (from fleet_dispatch). Terminates that run engine-independently (Pi and opencode) and reports confirmed termination." },
        },
        required: ["node"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; sessionId?: string; runId?: string };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        // Issue #63: abort addresses one run. Resolve a sessionId through the ledger.
        let runId = p.runId;
        if (!runId && p.sessionId) {
          const { loadLedger, resolveAbortRunId } = await import("./ledger.js");
          runId = resolveAbortRunId(
            await loadLedger(api.rootDir ?? process.cwd()),
            p.sessionId,
            [node.displayName, node.nodeId].filter((x): x is string => !!x),
          );
        }
        if (!runId) {
          return jsonResult({ ok: false, aborted: false, error: "runId required: pass the runId from fleet_dispatch, or a sessionId the ledger recorded for this node" });
        }
        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: { prompt: "__ABORT__", cwd: "/", transport: "http", sessionId: p.sessionId, runId },
          timeoutMs: 15000,
          signal,
        });
        return jsonResult(inv);
      },
    });

    api.registerTool({
      name: "fleet_diff",
      label: "Fleet Diff",
      description: "Pull the diff summary from a finished OpenCode session on a fleet node.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { type: "string", description: "Node display name or id." },
          sessionId: { type: "string", description: "Session id to pull the diff for." },
          cwd: { type: "string", description: "Absolute repo path on the node (required to run git diff; read-only)." },
        },
        required: ["node", "sessionId", "cwd"],
      },
      execute: async (toolCallId, params, signal) => {
        const p = params as { node: string; sessionId: string; cwd: string };
        const list = await api.runtime.nodes.list();
        const node = (list.nodes ?? []).find((n) => n.displayName === p.node || n.nodeId === p.node);
        if (!node) return jsonResult(`Node "${p.node}" not found.`);
        const inv = await api.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: "opencode.run",
          params: { prompt: "__DIFF__", cwd: p.cwd, transport: "http", sessionId: p.sessionId },
          timeoutMs: 30000,
          signal,
        });
        return jsonResult(inv);
      },
    });
  },
});

/**
 * Manager-side: list running OpenCode processes on a node over SSH
 * (same execFile ssh pattern as provision.ts). Falls back to the node
 * invoke command (`__ACTIVITY__`) when SSH is unavailable.
 */
async function getNodeActivity(
  host: string,
  invokeFallback?: () => Promise<NodeActivityEntry[] | { error: string }>,
): Promise<NodeActivityEntry[] | { error: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      "ssh",
      [...sshPrefix(host, SSH_ARGS), OPCODE_PS_COMMAND],
      { timeout: 20_000 },
    );
    return parseActivity(stdout);
  } catch (sshErr) {
    // Fall back to the node host command channel when SSH is unavailable.
    if (invokeFallback) return invokeFallback();
    return { error: (sshErr as Error).message };
  }
}


/** Extract the parsed payload object from a node invoke result. */
function payloadOf(inv: unknown): Record<string, unknown> {
  const payload = (inv as { payload?: unknown }).payload;
  if (typeof payload === "string") {
    try { return JSON.parse(payload) as Record<string, unknown>; } catch { return {}; }
  }
  return ((payload as Record<string, unknown> | undefined) ?? {});
}

