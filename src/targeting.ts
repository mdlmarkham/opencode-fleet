/**
 * Which node(s) a `fleet_dispatch` targets (issue #168). The old default was to run the task on
 * EVERY fleet node when none was named, which for a caller that simply forgot to name one means
 * duplicated work, duplicated cost and N competing branches. Now an unnamed target is refused
 * (listing the nodes and their free slots), fan-out must be asked for, and `pick: "any"` chooses
 * one node with a free slot.
 *
 * Pure: slot counts come in as data.
 */

export interface NodeSlots {
  node: string;
  /** Configured slot limit, or null when unlimited. */
  limit: number | null;
  /** Free slots, or null when unlimited. */
  free: number | null;
}

export type TargetMode =
  | { mode: "explicit"; names: string[] }
  | { mode: "all" }
  | { mode: "pick"; among: "fleet" | string[] }
  | { mode: "refuse"; error: string; nodes: NodeSlots[] };

export interface TargetInput {
  node?: unknown;
  nodes?: unknown;
  pick?: unknown;
  /** Operator switch `dispatch.defaultTarget`: "all" restores the old fan-out default. */
  defaultTarget?: unknown;
  fleet: NodeSlots[];
}

const names = (nodes: NodeSlots[]): string => nodes.map((n) => `${n.node} (${n.free === null ? "unlimited" : `${n.free} free`})`).join(", ") || "none";

export function targetMode(i: TargetInput): TargetMode | { mode: "invalid"; error: string } {
  if (i.pick !== undefined && i.pick !== "any") return { mode: "invalid", error: 'pick must be "any"' };
  if (i.nodes !== undefined && i.nodes !== "all" && !(Array.isArray(i.nodes) && i.nodes.every((n) => typeof n === "string"))) {
    return { mode: "invalid", error: 'nodes must be an array of node names, or "all" to fan out to every fleet node' };
  }
  const explicit = typeof i.node === "string" && i.node ? [i.node] : Array.isArray(i.nodes) ? (i.nodes as string[]) : [];
  if (i.pick === "any") {
    if (i.nodes === "all") return { mode: "invalid", error: 'pick:"any" cannot be combined with nodes:"all"' };
    return { mode: "pick", among: explicit.length ? explicit : "fleet" };
  }
  if (explicit.length > 0) return { mode: "explicit", names: explicit };
  if (i.nodes === "all" || i.defaultTarget === "all") return { mode: "all" };
  // One candidate is not ambiguous: no node to forget to name.
  if (i.fleet.length === 1) return { mode: "explicit", names: [i.fleet[0]!.node] };
  return {
    mode: "refuse",
    nodes: i.fleet,
    error: `no target node given. Name one with node: "<name>", fan out explicitly with nodes: "all" (or an array), or let the plugin choose one with a free slot using pick: "any". Fleet nodes: ${names(i.fleet)}`,
  };
}

/** The node with the most free slots among `candidates` (unlimited nodes count as always free, listed last-resort so a limited node with room is preferred). Undefined when none has a free slot. */
export function pickNode(candidates: NodeSlots[]): NodeSlots | undefined {
  const open = candidates.filter((c) => c.free === null || c.free > 0);
  if (open.length === 0) return undefined;
  const limited = open.filter((c) => c.free !== null).sort((a, b) => (b.free ?? 0) - (a.free ?? 0));
  return limited[0] ?? open[0];
}

export const noFreeSlot = (candidates: NodeSlots[]) => ({
  ok: false as const,
  retryable: true as const,
  reason: "no-capacity" as const,
  error: `pick:"any" found no node with a free slot. Nodes: ${names(candidates)}. Retry later or wait for a run to finish (fleet_await).`,
  nodes: candidates,
});
