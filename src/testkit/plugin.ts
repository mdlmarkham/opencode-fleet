/**
 * Test harness: load the real plugin entry against a fake OpenClaw API and call
 * its registered tools (issue: tool-level tests). Nothing here mocks the plugin's
 * own code; only the host (`api`) is faked, so the tests exercise the same
 * `execute` functions the gateway would.
 *
 * Importing the entry pulls in the OpenClaw SDK, which refuses old Node versions
 * (SQLite WAL bug), so callers use `loadEntry()` and skip when it is unavailable.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeNode {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  commands?: string[];
  [k: string]: unknown;
}

export interface InvokeCall {
  nodeId: string;
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export type InvokeHandler = (call: InvokeCall) => unknown | Promise<unknown>;

export interface Tool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export interface Loaded {
  tools: Map<string, Tool>;
  policies: unknown[];
  invokes: InvokeCall[];
  rootDir: string;
  /** Call a tool and return its decoded JSON result. */
  call: (name: string, params: Record<string, unknown>) => Promise<any>;
  /** Wait for a node invoke matching `pred` (dispatch fires its invoke after the tool returns). */
  waitForInvoke: (pred: (c: InvokeCall) => boolean, ms?: number) => Promise<InvokeCall | undefined>;
  dispose: () => void;
}

/** The plugin entry, or undefined when the SDK cannot load on this Node. */
export async function loadEntry(): Promise<{ register: (api: unknown) => void } | undefined> {
  try {
    const m = await import("../index.js");
    return m.default as unknown as { register: (api: unknown) => void };
  } catch {
    return undefined;
  }
}

/** Decode what `jsonResult` produced into the plain object the tool returned. */
export function decode(res: unknown): any {
  const r = res as { details?: unknown; content?: Array<{ text?: string }> } | undefined;
  if (r && r.details !== undefined) return r.details;
  const text = r?.content?.[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return text; }
  }
  return res;
}

export function loadPlugin(
  entry: { register: (api: unknown) => void },
  opts: { config?: Record<string, unknown>; nodes?: FakeNode[]; invoke?: InvokeHandler } = {},
): Loaded {
  const rootDir = mkdtempSync(join(tmpdir(), "fleet-tools-"));
  const tools = new Map<string, Tool>();
  const policies: unknown[] = [];
  const invokes: InvokeCall[] = [];
  const nodes = opts.nodes ?? [];
  const api = new Proxy(
    {
      pluginConfig: opts.config ?? {},
      rootDir,
      registerTool: (t: Tool) => void tools.set(t.name, t),
      registerNodeInvokePolicy: (p: unknown) => void policies.push(p),
      runtime: {
        nodes: {
          list: async () => ({ nodes }),
          invoke: async (call: InvokeCall) => {
            invokes.push(call);
            if (!opts.invoke) throw new Error("unexpected node invoke: " + call.command);
            return opts.invoke(call);
          },
        },
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : () => undefined) },
  );
  entry.register(api);
  return {
    tools, policies, invokes, rootDir,
    call: async (name, params) => {
      const t = tools.get(name);
      if (!t) throw new Error(`tool ${name} is not registered`);
      return decode(await t.execute("test-call", params));
    },
    waitForInvoke: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = invokes.find(pred);
        if (hit || Date.now() > end) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    dispose: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

/** A node-channel reply: the node returns its JSON result as the payload string. */
export const nodeReply = (payload: unknown) => ({ ok: true, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

/**
 * Put a stand-in `ssh` first on PATH that prints `output` (some tools probe the
 * node over real ssh before dispatching). Returns a restore function.
 */
export function fakeSsh(output: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fakessh-"));
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "ssh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
  chmodSync(bin, 0o755);
  // A stand-in scp that just succeeds (issue #51b tests ship baseline modules
  // over the same faked transport).
  const scpBin = join(dir, "scp");
  writeFileSync(scpBin, "#!/bin/sh\nexit 0\n");
  chmodSync(scpBin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  return () => {
    process.env.PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  };
}
