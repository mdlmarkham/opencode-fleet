import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { shq } from "../shell.js";
import { AWAIT_MISSING_NOTE } from "../await.js";
import { DEFAULT_RUN_TIMEOUT_MS, validateHarnessTransport, validatePiOptions, type OpenCodeTask } from "../opencode.js";
import { probeAckRecovery, ACK_ABSENT_NOTE, ACK_PROBE_TIMEOUT_MS, type AckRecoveryOutcome } from "../recovery.js";
import { SSH_ARGS, sshPrefix } from "../ssh.js";
import { checkSetup, partitionEnv } from "../policy.js";
import { isSentinelPrompt } from "../protocol.js";
import { parseBudgetConfig } from "../budget.js";
import type { TriageResult } from "../s1-hooks.js";
import type { S1RouteDecision, S1RouteHarnessResult } from "../s1-wire.js";
import { type FleetConfig, expectParam, payloadOf, internalMissionCalls } from "./shared.js";

export function registerDispatchTools(api: OpenClawPluginApi, cfg: FleetConfig): { dispatchTool: { execute: (toolCallId: string, params: never, signal?: AbortSignal) => Promise<unknown> } } {
  const dispatchTool: Parameters<typeof api.registerTool>[0] = {
    name: "fleet_dispatch",
    label: "Fleet Dispatch",
    description:
      "Dispatch an OpenCode coding task to one or more remote OpenClaw nodes (dev2, dev3, ...). Returns per-node results. Use for multi-file coding work on remote dev hosts. Optionally filter nodes by capability constraints (GPU, disk, RAM, tools, models) so work routes to nodes that can actually handle it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The coding task / goal for OpenCode. Optional when `spec` is given: a spec-rendered prompt replaces it and this field is ignored." },
        spec: {
          type: "object",
          additionalProperties: false,
          description: "The dispatch unit: a goal, acceptance criteria and a verify gate. The engine prompt is rendered from goal + acceptance (the flat `prompt` is then ignored) and spec.verify becomes the post-run gate. Prompt-only dispatch still works but has no gate.",
          properties: {
            goal: { type: "string", description: "The task goal — the first line of the rendered engine prompt." },
            acceptance: { type: "array", items: { type: "string" }, description: "Acceptance criteria, rendered as a bullet list under 'Acceptance criteria:'. At most 50 items of 1000 characters." },
            scope: {
              type: "object",
              additionalProperties: false,
              description: "Advisory file scope (slice 2). Rendered into the prompt, and on a detached run the node lists the files that changed against the start commit and reports any outside the scope as scopeViolations in fleet_run_status. Not enforced. Also the overlap key for scheduling concurrent tasks.",
              properties: {
                files: { type: "array", items: { type: "string" }, description: "Repo-relative paths or globs (`*`, `**`, `?`); `dir/` means everything below dir. No absolute paths or `..`. At most 100." },
              },
              required: ["files"],
            },
            verify: {
              type: "object",
              additionalProperties: false,
              properties: {
                files: { type: "array", items: { type: "string" }, description: "Artifact paths that must exist after the run (relative to the run cwd, inside it). Same rules as expect.files." },
                command: { type: "string", description: "Verification command run in the run cwd after the worker exits; must exit 0 — same semantics as expect.command. Bounded to 120s unless timeoutMs is given." },
                commands: { type: "array", items: { type: "string" }, description: "plural verification gate — EVERY command is run in the run cwd after the worker exits and must exit 0 for the gate to pass. `command` below stays as a working single-command alias; do not pass both. Same setup-command rule as expect.command." },
                timeoutMs: { type: "number", description: "shared wall-clock bound applied to every verification command, ms; overrides the default 120000." },
              },
              description: "Post-run verification gate — mapped onto the existing `expect` gate. Absent => no gate, nothing extra is emitted.",
            },
          },
        },
        cwd: { type: "string", description: "Working directory on the target node(s)." },
        nodes: {
          oneOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }],
          description: 'Node display names or ids, or "all" to fan the same task out to every fleet node. Required unless `node` or `pick` is given (a fleet with a single node needs none).',
        },
        node: { type: "string", description: "Singular alias for nodes: [node]. Convenience for single-node dispatch." },
        pick: { type: "string", enum: ["any"], description: 'Let the plugin choose ONE node with a free slot (most free first), from `nodes` when given, else from the whole fleet. Returns a retryable no-capacity result when none is free.' },
        transport: { type: "string", enum: ["http", "acp"], description: "OpenCode transport." },
        harness: { type: "string", enum: ["opencode", "pi"], description: "Worker engine harness." },
        route: {
          type: "object",
          additionalProperties: false,
          description: "Opt-in S1 engine routing: rank candidate engine names for this task and use the pick as `harness` when it is a valid one (opencode|pi). Any failure keeps your `harness`. Omit for no S1 call.",
          properties: {
            candidates: { type: "array", items: { type: "string" }, description: "Candidate engine names, e.g. ['opencode','pi'], in criteria/tie-break order." },
          },
        },
        acknowledge: { type: "array", items: { type: "object", additionalProperties: false, properties: { objectionId: { type: "string" }, reason: { type: "string" } }, required: ["objectionId", "reason"] }, description: "Proceed despite design-gate objections: each entry names an objection id from a previous verdict and gives a reason. Recorded on the ledger. An operator `block` cannot be acknowledged." },
        piModel: { type: "string", description: "Pi model override (harness=pi); `provider/id` ref, e.g. myprovider/some-model. Falls back to the operator's piDefaultModel config." },
        piTools: { type: "array", items: { type: "string" }, description: "Pi tool allowlist (harness=pi), e.g. ['read','grep','ls'] for a read-only reviewer; [] disables all tools. Omitted = Pi defaults (read, bash, edit, write...). Fails closed: a node whose Pi lacks --tools refuses the run." },
        piJson: { type: "boolean", description: "Harness=pi: run Pi with --mode json (when the node's Pi supports it) so the result carries toolCalls, usage and stopReason, the final message is read from structured events, and the audit manifest records commands and usage. Default TRUE; pass false for plain text." },
        piOffline: { type: "boolean", description: "Run Pi with --offline (no automatic network activity). Fails closed if the node's Pi lacks the flag." },
        model: { type: "string", description: "Optional model override (must exist on node)." },
        agent: { type: "string", description: "Optional OpenCode agent (build/plan)." },
        autoApprove: { type: "boolean", description: "Opt-in: append --auto to `opencode run` to auto-approve all non-denied permissions for this run. Default false — this widens the trust posture." },
        autoTriage: { type: "boolean", description: "OPT-IN S1 triage (default false): when a run hand-raises a question, also ask the S1 triageHandRaise hook and surface a recommendation on the result as s1.triage ({action, reason}). Advisory only — it never auto-answers or changes the run; unavailable decisions escalate. Default false => no S1 call, no added fields." },
        timeoutMs: { type: "number", description: "Per-node timeout, ms." },
        maxIdleMs: { type: "number", description: "Kill the run if no output for this long, ms (stuck-loop guard). Default 120000." },
        maxDurationMs: { type: "number", description: "Kill the run if total runtime exceeds this, ms (stuck-loop guard). Default 600000." },
        async: { type: "boolean", description: "Run detached: returns a run handle immediately (runId + pid); the worker survives relay timeouts and its completion is recorded. Wait for it with fleet_await (one blocking call; do not poll fleet_run_status in a loop) or watch it live with fleet_watch. Default true." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for the worker process (per-dispatch environment). Names that execute code or redirect configuration (PATH, HOME, BASH_ENV, NODE_OPTIONS, LD_*, GIT_SSH*, OPENCODE_CONFIG*, ...) are REFUSED: the dispatch fails and names them. Operators can narrow this further (config env.allowOnly / env.extraDeny)." },
        isolation: { type: "string", enum: ["none", "clone"], description: "`clone`: the node runs the worker in a private git clone of `cwd` (committed state only) on branch fleet/<runId> and returns runCwd and branch (pass runCwd to fleet_sync); detached runs only. A level the node cannot honour is refused, never downgraded. Default from config `isolation`, else none." },
        expect: expectParam("Post-run verification gate. `verified` (true / false / null for none) is separate from `ok`: a run that exits 0 but produced nothing is not a success. Prefer `spec.verify`."),
        ref: { type: "object", additionalProperties: false, properties: { branch: { type: "string", description: "Branch to check out before running." }, commit: { type: "string", description: "Commit SHA to check out before running." } }, description: "Git ref to check out before running. Refused if the checkout has uncommitted changes." },
        perDispatchCostUsd: { type: "number", minimum: 0, description: "Per-run cost cap for THIS dispatch, USD: overrides budget.perDispatchCostUsd when the budget block sets one. Refused with a retryable budget-exhausted result when the day's remaining budget cannot cover it." },
        perDispatchTokens: { type: "number", minimum: 0, description: "Per-run token cap for THIS dispatch: overrides budget.perDispatchTokens. Refused with a retryable budget-exhausted result when the day's remaining budget cannot cover it." },
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
        nodes?: string[] | "all";
        node?: string;
        pick?: "any";
        transport?: "http" | "acp";
        harness?: "opencode" | "pi";
        route?: { candidates: string[] };
        piModel?: string;
        piTools?: string[];
        piOffline?: boolean;
        piJson?: boolean;
        acknowledge?: unknown;
        missionKey?: string;
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
        expect?: { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number };
        spec?: { goal: string; acceptance?: string[]; verify?: { files?: string[]; command?: string; commands?: string[]; timeoutMs?: number }; scope?: { files: string[] } };
        ref?: { branch?: string; commit?: string };
        perDispatchCostUsd?: number;
        perDispatchTokens?: number;
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
      const { parseTaskSpec, renderSpec } = await import("../spec.js");
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
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
      // Issue #168: an unnamed target is refused (it used to fan out to every node); fan-out and
      // single-node picking are explicit.
      const { targetMode, pickNode, noFreeSlot } = await import("../targeting.js");
      const { slotLimit: slotLimitFor, staleAfter: staleAfterFor, liveRuns: liveRunsFor } = await import("../capacity.js");
      const slotRuns = await (await import("../ledger.js")).loadLedger(api.rootDir ?? process.cwd());
      const slotsOf = (n: (typeof fleet)[number]) => {
        const lim = slotLimitFor(cfg.capacity, (n as { member?: { maxConcurrent?: unknown } }).member);
        const { live } = liveRunsFor(slotRuns, [n.displayName, n.nodeId].filter((x): x is string => !!x), Date.now(), staleAfterFor(cfg.capacity));
        const limit = lim.ok && lim.limit !== undefined ? lim.limit : null;
        return { node: n.displayName ?? n.nodeId, limit, free: limit === null ? null : Math.max(0, limit - live.length) };
      };
      const mode = targetMode({ node: p.node, nodes: p.nodes, pick: p.pick, defaultTarget: cfg.dispatch?.defaultTarget, fleet: fleet.map(slotsOf) });
      if (mode.mode === "invalid") return jsonResult({ ok: false, error: mode.error });
      if (mode.mode === "refuse") return jsonResult({ ok: false, error: mode.error, nodes: mode.nodes });
      // Issue #39 (budget slice): validate the per-dispatch cap overrides, then check the
      // budget BEFORE any launch, using the ledger as of now. Exhaustion returns a retryable
      // "budget-exhausted" result shaped like "no-capacity" (same family, same retry
      // semantics); per-dispatch overrides take precedence over the config defaults. The
      // overrides also ride the ledger entry so the day's accounting can show them.
      const { parseOverrides: parseBudgetOverrides, budgetCheck: checkBudget, budgetExhausted, parseBudgetConfig: parseBudgetLimits } = await import("../budget.js");
      const budgetParsed = parseBudgetLimits(cfg.budget);
      const budgetLimits = budgetParsed.ok ? budgetParsed.config : undefined;
      const overrideCheck = parseBudgetOverrides({ perDispatchCostUsd: p.perDispatchCostUsd, perDispatchTokens: p.perDispatchTokens });
      if (!overrideCheck.ok) return jsonResult({ ok: false, error: overrideCheck.error });
      const budgetNow = new Date().toISOString();
      const budgetVerdict = checkBudget(slotRuns, budgetLimits, budgetNow, overrideCheck.override);
      if (!budgetVerdict.allowed) {
        return jsonResult(budgetExhausted(budgetVerdict.spent ?? { costUsd: 0, tokens: 0 }, budgetVerdict.reason ?? "budget exhausted", overrideCheck.override));
      }
      const nodeFilter = mode.mode === "explicit" ? mode.names : mode.mode === "pick" && mode.among !== "fleet" ? mode.among : undefined;
      let targets = nodeFilter?.length
        ? fleet.filter((n) => nodeFilter!.includes(n.displayName ?? n.nodeId) || nodeFilter!.includes(n.nodeId))
        : fleet;

      // Apply capability constraints if provided.
      if (p.requires) {
        const { detectNodeCapabilities, satisfiesConstraints } = await import("../capabilities.js");
        const filtered: typeof targets = [];
        const skipped: string[] = [];
        for (const node of targets) {
          const host = node.remoteIp ?? node.displayName ?? node.nodeId;
          const svc = (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
            ?? (node as { member?: { user?: string } }).member?.user;
          const caps = await detectNodeCapabilities(host, node.displayName ?? node.nodeId, svc);
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
      if (mode.mode === "pick") {
        const candidates = targets.map(slotsOf);
        const chosen = pickNode(candidates);
        if (!chosen) return jsonResult(noFreeSlot(candidates));
        targets = targets.filter((n) => (n.displayName ?? n.nodeId) === chosen.node);
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
        void import("../s1-shadow.js")
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
        const { parseRouteOptIn, s1RouteHarness } = await import("../s1-wire.js");
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
      // Issue #51 slice 2: gate autoApprove on what the node's opencode can
      // actually parse. Probe `run --help` / `--version` per opencode target
      // and run the pure autoApproveGate predicate: an unsupported --auto is
      // REFUSED (never appended unparseable), a node without the deny
      // baseline proceeds with a warning. Default behavior (autoApprove not
      // set) never enters this branch — byte-identical dispatch.
      const autoApproveNodes = new Map<string, { nodeName: string; host: string; serviceUser?: string; probe: { version?: string; helpText?: string } }>();
      const autoApproveWarnings: Record<string, string[]> = {};
      if (p.autoApprove === true) {
        const autoUtil = await import("node:util");
        const autoCp = await import("node:child_process");
        const autoExecFileP = autoUtil.promisify(autoCp.execFile);
        const { SSH_ARGS: probeSshArgs } = await import("../ssh.js");
        const autoProbeSsh = async (host: string, command: string): Promise<string> => {
          try {
            const { stdout } = await autoExecFileP("ssh", [...sshPrefix(host, probeSshArgs), command], { timeout: 30_000 });
            return stdout;
          } catch (e) {
            return (e as { stdout?: string }).stdout ?? "";
          }
        };
        for (const node of targets) {
          const nodeName = node.displayName ?? node.nodeId;
          const host = node.remoteIp ?? nodeName;
          const svcForNode = (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
            ?? (node as { member?: { user?: string } }).member?.user;
          if ((node as { invocableCommands?: string[] }).invocableCommands?.includes("opencode.run")) {
            const helpText = await autoProbeSsh(host, "opencode run --help 2>/dev/null || true");
            const version = await autoProbeSsh(host, "opencode --version 2>/dev/null || true");
            autoApproveNodes.set(nodeName, { nodeName, host, serviceUser: svcForNode, probe: { version, helpText } });
          } else {
            const { detectNodeCapabilities } = await import("../capabilities.js");
            const caps = await detectNodeCapabilities(host, nodeName, svcForNode);
            autoApproveNodes.set(nodeName, {
              nodeName,
              host,
              serviceUser: svcForNode,
              probe: { version: caps.opencode && caps.opencode !== "none" ? caps.opencode : "" },
            });
          }
        }
      }
      // Issue #62: validate the optional verification gate up front so a
      // malformed spec is a clear refusal, never a silently-dropped gate.
      const { parseExpectSpec, withVerified, relayTimeoutWithGate } = await import("../verify.js");
      // Issue #65: with a structured spec the gate comes from spec.verify,
      // mapped onto the SAME machinery: same parser here, same node-side
      // evaluator (evaluateExpect / the launcher gate script), same ledger
      // shape. No verify (and no expect) => expect stays undefined and
      // nothing extra is emitted anywhere. When spec is given it is the
      // dispatch unit, so its verify supersedes a flat `expect`.
      // Issue #204: a flat `expect` alongside a spec used to be dropped silently (gate "none"). It now
      // stands in when the spec has no verify of its own; giving both is refused, never guessed.
      if (specCheck.spec && specCheck.spec.verify !== undefined && specCheck.spec.verify !== null && p.expect !== undefined && p.expect !== null) {
        return jsonResult({ ok: false, error: "pass the verification gate once: either spec.verify or the flat `expect`, not both" });
      }
      if (specCheck.spec && (specCheck.spec.verify === undefined || specCheck.spec.verify === null) && p.expect !== undefined && p.expect !== null) {
        specCheck.spec = { ...specCheck.spec, verify: p.expect as never }; // a copy: never mutate the caller's spec
      }
      const expectSpec = specCheck.spec
        ? parseExpectSpec(specCheck.spec.verify)
        : parseExpectSpec(p.expect);
      if (!expectSpec.ok) {
        return jsonResult({ ok: false, error: `invalid expect: ${expectSpec.error}` });
      }
      // `expect.command` runs on the node OUTSIDE the engine's permission system,
      // so it gets the same rule as provision `setup`: a repo-relative script
      // path unless the operator allows arbitrary commands (issue #34).
      // Issue #104: every plural `commands[]` entry gets the SAME rule.
      if (expectSpec.expect?.command) {
        const cmdCheck = checkSetup(expectSpec.expect.command, cfg.allowSetupCommands === true);
        if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.command: ${cmdCheck.error}` });
      }
      if (expectSpec.expect?.commands) {
        for (const cmd of expectSpec.expect.commands) {
          const cmdCheck = checkSetup(cmd, cfg.allowSetupCommands === true);
          if (!cmdCheck.ok) return jsonResult({ ok: false, error: `invalid expect.commands entry: ${cmdCheck.error}` });
        }
      }
      const { upsertRun, newRunId, probeRun, loadLedger, outcomeEntry } = await import("../ledger.js");
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
      // Issue #117: deterministic design gate. Only a structured spec is gated; a prompt-only
      // dispatch (no spec) and gate=off leave the dispatch byte-identical.
      const gateMode = cfg.project?.gate ?? "advise";
      let design: import("../design-gate.js").GateResult | undefined;
      if (specCheck.spec && gateMode !== "off") {
        const { evaluateDesignGate, parseAcknowledge } = await import("../design-gate.js");
        const ackCheck = parseAcknowledge(p.acknowledge);
        if (!ackCheck.ok) return jsonResult({ ok: false, error: ackCheck.error });
        const names = new Set(opencodeTargets.flatMap((n) => [n.displayName, n.nodeId].filter((x): x is string => !!x)));
        // Issue #196: only genuinely-running entries at query time are conflict evidence;
        // finished ledger entries ride as informational recentlyFinished, never as overlap.
        const { capacityInputFromLedger } = await import("../capacity.js");
        const { staleAfter: capacityStaleAfter } = await import("../capacity.js");
        const gateInput = capacityInputFromLedger(await loadLedger(rootDir) as never, {
          nodeNames: [...names],
          cwd: p.cwd,
          excludeRunId: undefined,
          now: Date.now(),
          staleAfterMs: capacityStaleAfter(cfg.capacity),
        });
        const gate = evaluateDesignGate(specCheck.spec, {
          inFlight: gateInput.inFlight,
          isolated: (p.isolation ?? cfg.isolation ?? "none") === "clone",
          bounds: { ...(cfg.project?.maxScopePatterns ? { maxScopePatterns: cfg.project.maxScopePatterns } : {}), ...(cfg.project?.maxAcceptanceItems ? { maxAcceptanceItems: cfg.project.maxAcceptanceItems } : {}) },
        }, ackCheck.acks);
        if (!gate.ok) return jsonResult({ ok: false, error: gate.error });
        design = gate.result;
        if (gateMode === "enforce" && design.blocked) {
          return jsonResult({ ok: false, error: `design gate (${design.verdict}): fix the objections or acknowledge them with a reason`, design });
        }
      }
      // Issue #168: success is the exit code unless a gate is given. A dispatch with no verify gate
      // says so (advise), or is refused (enforce), under the same project.gate setting.
      const noGate = expectSpec.expect === undefined;
      if (noGate && gateMode === "enforce") {
        return jsonResult({ ok: false, error: "project.gate=enforce: this dispatch has no verification gate, so success would be just the process exit code. Pass a `spec` with `verify` (or `expect`), or set project.gate to advise/off." });
      }
      const dispatchWarnings: string[] = [];
      if (p.timeoutMs !== undefined && p.timeoutMs < 600_000 && (specCheck.spec?.acceptance?.length ?? 0) >= 2) {
        dispatchWarnings.push(`timeoutMs ${p.timeoutMs} is under 10 minutes for a spec with ${specCheck.spec!.acceptance!.length} acceptance criteria; the run will be killed at the limit with the work half-done. Omit timeoutMs for the 30-minute default.`);
      }
      const results: Record<string, unknown> = {};
      if (skippedNodes.length) results.skipped = skippedNodes;
      if (design && design.verdict !== "accept") results.design = design;
      if (noGate && gateMode !== "off") results.verification = { gate: "none", note: "no verify gate: success is just the process exit code and is unchecked. Pass a `spec` with `verify` (or `expect`) so a run that exits 0 but did nothing is caught." };
      if (dispatchWarnings.length) results.warnings = dispatchWarnings;
      // Issue #87, slice 3: surface the opt-in routing decision — only when
      // `route` was requested; the default path adds no field at all.
      if (s1RouteDecision) results.s1 = { route: s1RouteDecision };
      // Issue #26: validate the cwd AS THE WORKER PRINCIPAL before dispatch.
      // A /root path is unreachable by a non-root service user, so the run
      // cannot start — refuse with an actionable error instead of sending it
      // and discovering the failure later (or, pre-#22, reporting success).
      const { cwdCheckCommand, evaluateCwdCheck, looksWorkerInaccessible, defaultFleetCwd, resolveFleetRoot } = await import("../cwd.js");
      const { SSH_ARGS } = await import("../ssh.js");
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
        // Issue #51 slice 2: per-node autoApprove gate. Runs BEFORE any ledger
        // write so a refusal leaves no run record.
        const nodeName = node.displayName ?? node.nodeId;
        if (p.autoApprove === true) {
          const entry = autoApproveNodes.get(nodeName);
          const { autoApproveGate } = await import("../deny-baseline.js");
          const { detectNodeCapabilities } = await import("../capabilities.js");
          const capsForBaseline = entry
            ? await detectNodeCapabilities(entry.host, nodeName, entry.serviceUser).catch(() => null)
            : null;
          const gate = autoApproveGate({
            autoApprove: true,
            nodeName,
            probe: entry?.probe,
            denyBaseline: capsForBaseline?.denyBaseline === true,
          });
          if (!gate.ok) {
            results[nodeName] = { ok: false, error: gate.error };
            continue;
          }
          if (gate.warning) autoApproveWarnings[nodeName] = [gate.warning];
        }
        // Issue #26: refuse an unusable cwd BEFORE recording a run or
        // dispatching. Check as the worker principal; a fast path-only check
        // catches the common /root case without an SSH round trip.
        const nodeKey = nodeName;
        const svcUser = (node as { member?: { serviceUser?: string; user?: string } }).member?.serviceUser
          ?? (node as { member?: { user?: string } }).member?.user;
        const loginUser = (node as { member?: { user?: string } }).member?.user;
        const sshHost = loginUser ? `${loginUser}@${nodeKey}` : nodeKey;
        // Issue #105: the same host string the ssh cwd probe uses — the
        // isolation-capability probe targets the node through one path
        // (`loginUser@nodeKey` when a login user is set), as the worker
        // principal (`svcUser`) runs there (issue #164).
        const entryHostForCaps = sshHost;
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
        // Issue #105 capability probe: an EXPLICIT isolation level must be one
        // the node can honour. Refuse before ledger/launch — hard, never a
        // silent downgrade. Absent `isolation` (a config default or none)
        // keeps today's behavior untouched.
        if (p.isolation !== undefined && p.isolation !== "none") {
          const { probeIsolationLevels } = await import("../capabilities.js");
          const isolationCaps = await probeIsolationLevels(entryHostForCaps, svcUser);
          if (!isolationCaps.levels.includes(p.isolation)) {
            const have = isolationCaps.levels.length ? isolationCaps.levels.join(", ") : "none";
            const why = isolationCaps.error
              ? ` (capability probe failed: ${isolationCaps.error})`
              : ` (gitClone=${isolationCaps.gitClone}, bwrap=${isolationCaps.bwrap})`;
            results[nodeKey] = {
              ok: false,
              error:
                `refusing to dispatch: node ${nodeName} does not support isolation \"${p.isolation}\"${why}; ` +
                `supported levels: ${have}. No run was launched — pick a supported level, extend the node's capabilities, or omit isolation.`,
            };
            continue;
          }
        }
        // Issue #105: an isolated run copies the object store; refuse (retryably) when the node is short of disk.
        if (isolationMode === "clone" && (cfg.capacity?.minFreeDiskGb ?? 0) > 0) {
          const { diskFreeCommand, parseFreeKb, diskHeadroom } = await import("../capacity.js");
          const room = diskHeadroom(nodeName, parseFreeKb(await sshProbe(sshHost, diskFreeCommand(shq(p.cwd)))), cfg.capacity!.minFreeDiskGb!);
          if (!room.ok) { results[nodeKey] = room; continue; }
        }
        // Issue #137: a configured minimum Pi version is enforced at dispatch, failing closed when unreadable.
        if (routed.harness === "pi" && cfg.dispatch?.piMinVersion) {
          const { checkPiVersion, PI_VERSION_COMMAND } = await import("../pi-version.js");
          const v = checkPiVersion(await sshProbe(sshHost, PI_VERSION_COMMAND), cfg.dispatch.piMinVersion);
          if (!v.ok) { results[nodeKey] = { ok: false, error: `refusing to dispatch: node ${nodeName}: ${v.error}` }; continue; }
        }
        if (routed.harness !== "pi" && (p.piTools !== undefined || p.piOffline !== undefined || p.piJson !== undefined)) {
          results[nodeKey] = { ok: false, error: "piTools/piOffline/piJson apply to harness=pi only; refusing so the restriction is not silently ignored" };
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
          ...(p.piJson !== undefined ? { piJson: p.piJson } : {}),
          model: p.model,
          agent: p.agent,
          autoApprove: p.autoApprove === true,
          timeoutMs: p.timeoutMs ?? cfg.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
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
          // Issue #117: overrides are part of the run's record.
          ...(design?.acknowledged.length ? { gateAcknowledged: design.acknowledged } : {}),
          ...(internalMissionCalls.has(rawParams as object) && typeof raw.missionKey === "string" && raw.missionKey.length <= 160 ? { missionKey: raw.missionKey } : {}),
          // Issue #166: what the gate said at dispatch, as ids (no text), for the spec-quality view.
          ...(design ? { design: { verdict: design.verdict, objectionIds: design.objections.map((o) => o.id) } } : {}),
          // Issue #39 (budget slice): the per-dispatch caps this run was admitted under,
          // so the day's accounting can show them; absent when no override was given.
          ...(overrideCheck.override ? { budgetCap: overrideCheck.override } : {}),
        };
        // Issue #39: per-node concurrency slots. With no limit configured this is the plain
        // upsert it always was; with one, the count and the insert are a single atomic step.
        const { slotLimit, staleAfter, noCapacity } = await import("../capacity.js");
        const limit = slotLimit(cfg.capacity, (node as { member?: { maxConcurrent?: unknown } }).member);
        if (!limit.ok) {
          results[nodeKey] = { ok: false, error: limit.error };
          continue;
        }
        if (limit.limit !== undefined) {
          const { reserveRun } = await import("../ledger.js");
          const slot = await reserveRun(rootDir, ledgerEntry, {
            nodeNames: [node.displayName, node.nodeId].filter((x): x is string => !!x),
            limit: limit.limit,
            staleAfterMs: staleAfter(cfg.capacity),
          });
          if (!slot.ok) {
            results[nodeKey] = noCapacity(nodeKey, limit.limit, slot.running);
            continue;
          }
        } else {
          await upsertRun(rootDir, ledgerEntry);
        }
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
              timeoutMs: task.timeoutMs === undefined ? undefined : relayTimeoutWithGate(task.timeoutMs, expectSpec.expect !== undefined, expectSpec.expect),
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
                ...(autoApproveWarnings[nodeName] ? { warnings: autoApproveWarnings[nodeName] } : {}),
              };
              continue;
            }
            // Issue #39: a launch the node definitively refused (or a probe proving nothing started)
            // leaves no run, so the ledger entry must not keep holding a concurrency slot. An
            // inconclusive probe stays `running`: the run may exist.
            if (nodeRejected || recovery.verdict === "absent") {
              await upsertRun(rootDir, { ...ledgerEntry, updatedAt: new Date().toISOString(), state: "failed", summary: `launch failed: ${errMsg}`.slice(0, 500) });
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
              ...(autoApproveWarnings[nodeName] ? { warnings: autoApproveWarnings[nodeName] } : {}),
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
              note: `Worker launched detached and survives relay timeouts. Wait with fleet_await({runIds:[runId]}) (not a fleet_run_status loop) or fleet_watch; fleet_resume finds it after interruptions. ${AWAIT_MISSING_NOTE}`,
              ...(autoApproveWarnings[nodeName] ? { warnings: autoApproveWarnings[nodeName] } : {}),
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
            ...(autoApproveWarnings[nodeName] ? { warnings: autoApproveWarnings[nodeName] } : {}),
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
                ? `Run is LIVE on the node (pid ${probe.pid}). Wait with fleet_await({runIds:[runId]}) or fleet_watch. ${AWAIT_MISSING_NOTE}`
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
          const { s1TriageIfRequested, triageContextFromRun } = await import("../s1-wire.js");
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
            ...(autoApproveWarnings[nodeName] ? { warnings: autoApproveWarnings[nodeName] } : {}),
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
  };
  api.registerTool(dispatchTool);

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
      const { loadLedger, upsertRun, probeRun } = await import("../ledger.js");
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
  return { dispatchTool };
}
