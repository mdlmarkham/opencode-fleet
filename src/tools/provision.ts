import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkSetup } from "../policy.js";
import { isCanonicalBase64 } from "../xfer.js";
import { type FleetConfig, payloadOf } from "./shared.js";

export function registerProvisionTools(api: OpenClawPluginApi, cfg: FleetConfig): void {
  api.registerTool({
    name: "fleet_provision",
    label: "Fleet Provision",
    description:
      "Provision a repository to fleet nodes WITHOUT giving them GitHub credentials: the manager clones with its own credentials, ships a git bundle, and the node unpacks it. Workers stay credential-free.",
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
            "Target directory on the node(s). defaults to a workspace the worker principal can actually enter (<fleetRoot>/<repo>), instead of a /root path the service user cannot traverse.",
        },
        setup: {
          type: "string",
          description:
            "Optional repo-declared setup command to run on each node after checkout, a repo-relative script path with plain arguments, e.g. \"scripts/setup.sh\" or \"./setup.sh --fast\" (the path must contain a \"/\"). Arbitrary shell commands (pipelines, &&, e.g. \"python3 -m venv .venv && ...\") are refused unless the operator sets allowSetupCommands. Lets a repo declare its own environment bootstrap so 'provisioned' means 'can run the tests'. Reported per node; never hardcoded.",
        },
      },
      required: ["repo"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { repo: string; cwd?: string; nodes?: string[]; branch?: string; commit?: string; setup?: string };
      const { createRepoBundle, provisionToNode, cleanupBundle, resolveWorkerIdentity } = await import("../provision.js");
      // Issue #34: refuse an arbitrary-shell `setup` unless the operator allows it.
      const setupCheck = checkSetup(p.setup ?? "", cfg.allowSetupCommands === true);
      if (!setupCheck.ok) return jsonResult({ ok: false, error: setupCheck.error });
      // Issue #26: default the landing path to a workspace the worker
      // principal can actually enter, instead of a /root path it cannot.
      const { defaultFleetCwd, resolveFleetRoot } = await import("../cwd.js");

      // Resolve target nodes.
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
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
            // Issue #189: opt-in distinct worker git identity (local to the checkout, never overwriting one).
            ...(cfg.workerGitIdentity ? { workerIdentity: resolveWorkerIdentity(cfg.workerGitIdentity, String(node.displayName ?? node.nodeId)) } : {}),
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
      "Ship OpenCode agent definitions, global rules (AGENTS.md), skills, and opencode.json to fleet nodes so workers work consistently with the manager. The manager holds the source-of-truth config; workers get it via SSH (no worker credentials needed). Opt-in installDenyBaseline merges the node-side deny-rule baseline into each node's opencode.json — merge-only and idempotent, never overwriting unrelated keys.",
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
        installDenyBaseline: {
          type: "boolean",
          description: "OPT-IN: after shipping, merge the deny-rule baseline into the node's ~/.config/opencode/opencode.json (union of deny rules; never overwrites unrelated keys; idempotent). Default false — behavior unchanged.",
        },
      },
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { nodes?: string[]; configDir?: string; installDenyBaseline?: boolean };
      const { provisionConfigToNode, discoverLocalConfig } = await import("../config-provision.js");
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
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
        results[node.displayName ?? node.nodeId] = await provisionConfigToNode(host, {
          ...local,
          ...(p.installDenyBaseline === true ? { installDenyBaseline: true } : {}),
        });
      }
      return jsonResult(results);
    },
  });

  api.registerTool({
    name: "fleet_sync",
    label: "Fleet Sync",
    description:
      "Pull a node's changes back to GitHub: the worker bundles them, the manager applies and pushes with its own credentials.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        node: { type: "string", description: "Node display name or id." },
        cwd: { type: "string", description: "Working directory on the node." },
        repo: { type: "string", description: "Git URL the manager can access." },
        allowScopeViolations: { type: "boolean", description: "Publish even though the run changed files outside its declared scope (or its scope was never checked) and sync.blockOnScopeViolation is set. Does not bypass a failed verification gate. Off by default." },
        head: { type: "string", description: "Full 40-hex sha of the commit being published. Required when sync.requireReview is set: a fleet_review PASS must exist for exactly this sha." },
        allowUnverified: { type: "boolean", description: "Publish even though the latest fleet run on this node and checkout FAILED its verification gate (or, with sync.requireVerified, has none). Off by default." },
        branch: { type: "string", description: "Clone BASE branch: a branch that already EXISTS on origin, checked out so the worker's changes can be applied on top of it (default main). NOT the destination — the destination is resolved from the worker's own branch (or from a pinned destination set internally); a protected destination is redirected to `fleet/<name>` and reported as `redirectedFrom`." },
      },
      required: ["node", "cwd", "repo"],
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { node: string; cwd: string; repo: string; branch?: string; head?: string; allowUnverified?: boolean; allowScopeViolations?: boolean };
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const node = nodes.find((n) => n.displayName === p.node || n.nodeId === p.node);
      if (!node) return jsonResult(`Node "${p.node}" not found.`);
      const host = node.remoteIp ?? node.displayName ?? node.nodeId;
      const cfg = (api.pluginConfig ?? {}) as FleetConfig;
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
      const member = fleet.find((t) => (t.displayName ?? t.nodeId) === (node.displayName ?? node.nodeId))?.member;

      // Issue #65: do not publish work whose verification gate failed.
      const { loadLedger, latestRunFor, syncGate } = await import("../ledger.js");
      const gate = syncGate(
        latestRunFor(await loadLedger(api.rootDir ?? process.cwd()), [node.displayName, node.nodeId].filter((x): x is string => !!x), p.cwd),
        { allowUnverified: p.allowUnverified === true, requireVerified: cfg.sync?.requireVerified === true, blockOnScopeViolation: cfg.sync?.blockOnScopeViolation === true, allowScopeViolations: p.allowScopeViolations === true },
      );
      if (!gate.allow) return jsonResult({ ok: false, error: gate.reason, verified: gate.verified, ...(gate.runId ? { runId: gate.runId } : {}) });
      // Issue #178: the review gate. A PASS recorded for exactly this head, or no publish.
      let reviewNote: Record<string, unknown> = {};
      let expectedHead: { expectedHead: string } | undefined;
      if (cfg.sync?.requireReview === true) {
        const { loadReviews, reviewGate } = await import("../review.js");
        const rg = reviewGate(await loadReviews(api.rootDir ?? process.cwd()), p.head ?? "", undefined, cfg.sync?.requireReviewSource === "spawned" ? { requireSource: "spawned" } : {});
        if (!rg.allow) return jsonResult({ ok: false, error: `sync.requireReview is set: ${rg.reason}`, review: rg.status, ...(p.head === undefined ? { hint: "pass `head` (the full sha being published)" } : {}) });
        reviewNote = { review: "PASS", reviewId: rg.record?.id };
        // The PASS is for this exact sha: syncFromNode refuses a bundle whose tip is anything else.
        expectedHead = { expectedHead: p.head!.toLowerCase() };
      }
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
        const { syncFromNode } = await import("../provision.js");
        const r = await syncFromNode("local", p.cwd, p.repo, p.branch ?? "main", {
          mode: "from-base64",
          base64: assembled,
          branch: p.branch ?? "main",
          // The branch the worker actually has checked out (SSH-free path), so a
          // feature-branch worker publishes its own commits instead of the base.
          workerBranch: typeof bundlePl.branch === "string" ? bundlePl.branch : undefined,
          destBranch: p.branch,
        }, undefined, cfg.sync, expectedHead);
        return jsonResult({ ...r, ...gateNote, ...reviewNote, viaChannel: true });
      }

      const { syncFromNode } = await import("../provision.js");
      const r = await syncFromNode(host, p.cwd, p.repo, p.branch ?? "main", undefined, p.branch, cfg.sync, expectedHead);
      return jsonResult({ ...r, ...gateNote, ...reviewNote });
    },
  });

  api.registerTool({
    name: "fleet_cleanup",
    label: "Fleet Cleanup",
    description:
      "Keep nodes tidy: git GC on checkouts, disk usage, prune finished runs' state, and (with cwd) report paths not owned by the service user (`ownership`; report only, see docs/STAGING.md). Run periodically.",
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
        discardUnsyncedClones: { type: "boolean", description: "Also delete finished runs' isolated clones that hold commits or changes beyond their start commit. Off by default: unsynced work is kept and listed under keptUnsynced, never deleted silently." },
        pruneOlderThanDays: { type: "number", description: "Also delete finished runs' scripts/logs/state/done files and stale transfer staging older than this many days from the node's private state dir (default 7; 0 skips). A run whose script is still alive is never touched. Needs a node on protocol 3+." },
      },
    },
    execute: async (toolCallId, params, signal) => {
      const p = params as { nodes?: string[]; cwd?: string; pruneOlderThanDays?: number; discardUnsyncedClones?: boolean };
      const { cleanupNode } = await import("../provision.js");
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
      const targets = p.nodes?.length
        ? fleet.filter((n) => p.nodes!.includes(n.displayName ?? n.nodeId) || p.nodes!.includes(n.nodeId))
        : fleet;
      if (!targets.length) {
        return jsonResult(`No fleet nodes found.`);
      }
      const results: Record<string, unknown> = {};
      for (const node of targets) {
        const host = node.remoteIp ?? node.displayName ?? node.nodeId;
        // Issue #189: report (never fix) checkout paths the worker's service user does not own. This runs
        // BEFORE cleanupNode: its `git gc` runs as the SSH login user and would itself leave root-owned
        // files in .git, so measuring afterwards would report damage this very call just did.
        // Only member.serviceUser counts: member.user is the SSH login user (often root), not the worker.
        let ownership: unknown;
        if (p.cwd) {
          const svcUser = (node as { member?: { serviceUser?: string } }).member?.serviceUser;
          if (svcUser) {
            const { probeOwnership } = await import("../provision.js");
            ownership = await probeOwnership(host, p.cwd, svcUser);
          } else {
            ownership = { ok: false, error: "no serviceUser configured for this node (member.serviceUser), so ownership was not checked" };
          }
        }
        const entry: Record<string, unknown> = await cleanupNode(host, p.cwd, (node as { member?: { serviceUser?: string } }).member?.serviceUser);
        if (ownership !== undefined) entry.ownership = ownership;
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
      const { deployPlugin } = await import("../deploy.js");
      const list = await api.runtime.nodes.list();
      const nodes = list.nodes ?? [];
      const fleet = (await import("../membership.js")).resolveFleetNodes(nodes, cfg);
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
      const pluginDir = p.pluginDir ?? (cfg.deploy?.pluginDir || join(api.rootDir ?? process.cwd(), ".."));
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
}
