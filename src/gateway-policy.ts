/**
 * Gateway-side invoke policy for `opencode.run` (issue #43).
 *
 * The policy is the single chokepoint every dispatch passes through, so it is
 * where the wire protocol is applied: the op is resolved (and checked against
 * the legacy sentinel prompt), the request is stamped with the protocol
 * version, and the node's protocol is learned from its replies. A node that
 * predates the protocol silently ignores `harness`/`piModel`; for any non-default
 * engine we therefore verify the node first instead of running the wrong engine.
 */

import { PROTOCOL_VERSION, nodeProtocolOf, resolveOp } from "./protocol.js";

export interface PolicyCtx {
  params: unknown;
  timeoutMs?: number;
  node?: { nodeId: string };
  invokeNode: (input?: { params?: unknown; timeoutMs?: number }) => Promise<{
    ok: boolean;
    message?: string;
    payload?: unknown;
    payloadJSON?: string | null;
  }>;
}

export type PolicyResult =
  | { ok: true; payload?: unknown }
  | { ok: false; message: string };

/** What we last learned about a node's protocol, keyed by node id. */
export interface ProtocolCache {
  get(nodeId: string): { version: number; at: number } | undefined;
  set(nodeId: string, v: { version: number; at: number }): void;
}

export function newProtocolCache(): ProtocolCache {
  const m = new Map<string, { version: number; at: number }>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_RUN_ID = "protocol-probe";

function payloadOfResult(r: { payload?: unknown; payloadJSON?: string | null }): unknown {
  if (r.payload !== undefined) return r.payload;
  if (typeof r.payloadJSON === "string") {
    try { return JSON.parse(r.payloadJSON); } catch { return r.payloadJSON; }
  }
  return undefined;
}

/**
 * Ask a node which protocol it speaks with a harmless, long-standing read-only
 * op (`__RUN_STATUS__` for an id that cannot exist): a protocol-0 node answers
 * "never-started" with no `protocol` field, a newer one adds it.
 */
async function probeProtocol(ctx: PolicyCtx): Promise<number> {
  const r = await ctx.invokeNode({
    params: { prompt: "__RUN_STATUS__", cwd: "/", transport: "http", runId: PROBE_RUN_ID, op: "run.status", protocol: PROTOCOL_VERSION },
    timeoutMs: 20_000,
  });
  if (!r.ok) throw new Error(r.message ?? "protocol probe failed");
  return nodeProtocolOf(payloadOfResult(r));
}

export async function handleOpencodeRunPolicy(
  ctx: PolicyCtx,
  cache: ProtocolCache,
  now: () => number = Date.now,
): Promise<PolicyResult> {
  const task = ctx.params as (Record<string, unknown> & { prompt?: unknown; cwd?: unknown; harness?: unknown; timeoutMs?: number }) | null;
  if (!task || typeof task.prompt !== "string" || !task.prompt.trim()) {
    return { ok: false, message: "opencode.run requires a non-empty prompt." };
  }
  if (!task.cwd || typeof task.cwd !== "string") {
    return { ok: false, message: "opencode.run requires a cwd." };
  }
  const resolved = resolveOp({ op: task.op, prompt: task.prompt });
  if (!resolved.ok) return { ok: false, message: resolved.error };

  const nodeId = ctx.node?.nodeId;
  const engine = typeof task.harness === "string" && task.harness ? task.harness : "opencode";
  const launches = resolved.op === "run" || resolved.op === "run.start";
  if (launches && engine !== "opencode") {
    let cached = nodeId ? cache.get(nodeId) : undefined;
    if (!cached || now() - cached.at > CACHE_TTL_MS) {
      let version: number;
      try {
        version = await probeProtocol(ctx);
      } catch (e) {
        return { ok: false, message: `cannot verify the node supports harness "${engine}": ${(e as Error).message}` };
      }
      cached = { version, at: now() };
      if (nodeId) cache.set(nodeId, cached);
    }
    if (cached.version < PROTOCOL_VERSION) {
      return {
        ok: false,
        message: `node speaks protocol ${cached.version} (< ${PROTOCOL_VERSION}) and would ignore harness "${engine}"; upgrade opencode-fleet on the node first`,
      };
    }
  }

  const result = await ctx.invokeNode({
    params: { ...task, op: resolved.op, protocol: PROTOCOL_VERSION },
    timeoutMs: task.timeoutMs,
  });
  if (!result.ok) return { ok: false, message: result.message ?? "opencode.run failed on node." };

  const payload = payloadOfResult(result);
  const version = nodeProtocolOf(payload);
  if (nodeId) cache.set(nodeId, { version, at: now() });
  return { ok: true, payload: result.payload ?? payload };
}
