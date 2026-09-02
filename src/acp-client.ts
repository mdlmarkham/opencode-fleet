/**
 * ACP transport — drives `opencode acp` as an ACP client.
 *
 * `opencode acp` is an ACP *server* (JSON-RPC over stdio). To run a task we
 * act as the ACP *client*: initialize, create a session, send the prompt, and
 * collect the agent's text output until the turn completes.
 *
 * Uses the official @agentclientprotocol/sdk `client()` API.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AcpRunOptions {
  prompt: string;
  cwd: string;
  model?: string;
  agent?: string;
  timeoutMs?: number;
  onChunk?: (chunk: string) => Promise<void>;
}

export interface AcpRunResult {
  ok: boolean;
  sessionId?: string;
  summary?: string;
  error?: string;
}

/**
 * Run a single prompt through `opencode acp` and collect the agent's text.
 */
export async function runAcpPrompt(options: AcpRunOptions): Promise<AcpRunResult> {
  const { prompt, cwd, model, agent, timeoutMs = 300_000, onChunk } = options;

  // Build the opencode acp command.
  // NOTE: `opencode acp` has NO --model flag (model is config-scoped on the
  // node). Only --agent is supported. Model allocation for ACP is therefore
  // set via the node's OpenCode config, not per-prompt.
  const args = ["acp"];
  if (agent) args.push("--agent", agent);
  args.push("--print-logs");

  const child: ChildProcess = spawn("opencode", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // Collect stderr for diagnostics.
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const result = await acp
      .client({ name: "opencode-fleet" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        // Auto-approve tool calls for headless operation.
        const option = ctx.params.options[0];
        return {
          outcome: {
            outcome: "selected",
            optionId: option?.optionId ?? "",
          },
        };
      })
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        return ctx.buildSession(cwd).withSession(async (session) => {
          const texts: string[] = [];
          session.prompt(prompt);

          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              return { sessionId: session.sessionId, texts, stopReason: message.stopReason };
            }
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              texts.push(update.content.text);
              if (onChunk) onChunk(update.content.text).catch(() => {});
            }
          }
        });
      });

    const summary = result.texts.join("").trim();
    return {
      ok: true,
      sessionId: result.sessionId,
      summary: summary || "(no text output)",
    };
  } catch (err) {
    return {
      ok: false,
      error: `${(err as Error).message}\n${stderr.slice(0, 500)}`,
    };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}
