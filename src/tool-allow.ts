/**
 * Tool-catalog parity (issue #261): a tool no agent can call is shipped-but-dead. The host filters each agent's tools through
 * `agents.entries.<id>.tools.allow`, so a tool added after an allow array was written is silently invisible to that agent.
 * Pure: given the host config and the plugin's registered tool names (the manifest's `contracts.tools`), report per agent
 * which registered tools it lacks and which `fleet_*` entries no longer exist. An agent that allows no `fleet_*` tool at all
 * is not a fleet agent and is left alone.
 */

export interface AllowFinding {
  agent: string;
  /** Registered tools this agent's allow array omits (invisible to it). */
  missing: string[];
  /** `fleet_*` entries in the allow array that are not registered (renamed or removed). */
  unknown: string[];
}
export interface AllowReport { ok: boolean; agents: AllowFinding[]; skipped: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function checkToolAllow(config: unknown, registered: readonly string[]): AllowReport {
  const entries = isObj(config) && isObj(config.agents) && isObj(config.agents.entries) ? config.agents.entries : {};
  const agents: AllowFinding[] = [];
  const skipped: string[] = [];
  const reg = new Set(registered);
  for (const [id, e] of Object.entries(entries)) {
    const allow = isObj(e) && isObj(e.tools) && Array.isArray(e.tools.allow) ? e.tools.allow.filter((x): x is string => typeof x === "string") : undefined;
    if (!allow || !allow.some((t) => t.startsWith("fleet_"))) { skipped.push(id); continue; }
    const have = new Set(allow);
    // A wildcard entry covers everything: nothing can be hidden from this agent.
    if (have.has("*") || have.has("fleet_*")) { agents.push({ agent: id, missing: [], unknown: [] }); continue; }
    agents.push({
      agent: id,
      missing: registered.filter((t) => !have.has(t)),
      unknown: allow.filter((t) => t.startsWith("fleet_") && !t.includes("*") && !reg.has(t)),
    });
  }
  return { ok: agents.every((a) => a.missing.length === 0 && a.unknown.length === 0), agents, skipped };
}

export function renderAllowReport(r: AllowReport): string {
  const L = [r.ok ? "tool allow arrays: every fleet agent can call every registered tool" : "tool allow arrays: DRIFT (a registered tool is invisible to an agent, or an entry names a removed tool)"];
  for (const a of r.agents) {
    if (a.missing.length) L.push(`  ${a.agent}: cannot call ${a.missing.length} registered tool(s): ${a.missing.join(", ")}`);
    if (a.unknown.length) L.push(`  ${a.agent}: allows unregistered tool(s): ${a.unknown.join(", ")}`);
  }
  if (r.skipped.length) L.push(`  (not fleet agents, left alone: ${r.skipped.join(", ")})`);
  return L.join("\n");
}

/**
 * The host config is JSON5 (the host parses it with JSON5): comments and trailing commas are legal, so plain
 * JSON.parse would report a perfectly good config as unreadable. Strict JSON first, then json5 when it resolves
 * (the host ships it); if neither works the caller reports `checked:false` rather than guessing.
 */
export async function parseHostConfig(text: string): Promise<unknown> {
  try { return JSON.parse(text); } catch (strict) {
    try {
      const name = "json5";
      const mod = (await import(name)) as { default?: { parse: (s: string) => unknown }; parse?: (s: string) => unknown };
      const parse = mod.default?.parse ?? mod.parse;
      if (!parse) throw strict;
      return parse(text);
    } catch { throw strict; }
  }
}

export type DeployAllow = { checked: false; reason: string } | { checked: true; ok: boolean; agents: AllowFinding[]; skipped: string[]; summary: string };

/**
 * The parity report for a deploy (issue #289): read-only, never edits the host config, and never throws.
 * An absent/unreadable config or manifest reports `checked: false` with the reason, so a deploy is never failed by it.
 */
export async function toolAllowForDeploy(configPath: string, manifestPath: string, read: (p: string) => Promise<string>): Promise<DeployAllow> {
  let config: unknown;
  try { config = await parseHostConfig(await read(configPath)); } catch (e) { return { checked: false, reason: `cannot read ${configPath}: ${(e as Error).message}`.slice(0, 200) }; }
  let tools: unknown;
  try { tools = (JSON.parse(await read(manifestPath)) as { contracts?: { tools?: unknown } }).contracts?.tools; } catch (e) { return { checked: false, reason: `cannot read ${manifestPath}: ${(e as Error).message}`.slice(0, 200) }; }
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === "string")) return { checked: false, reason: "the manifest has no contracts.tools" };
  const r = checkToolAllow(config, tools as string[]);
  return { checked: true, ok: r.ok, agents: r.agents, skipped: r.skipped, summary: renderAllowReport(r) };
}
