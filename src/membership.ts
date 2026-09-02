/**
 * Fleet membership resolution.
 *
 * Membership is EXPLICIT via plugin config (`nodes` map), not inferred from
 * display-name prefixes. The legacy `nodePrefixes` list remains as an
 * auto-include fallback when `nodes` is not configured — explicit beats
 * accidental: a node named "desktop-backup-files" must not be enrolled
 * because it shares a prefix.
 *
 * Config shape (plugins.entries.opencode-fleet.config):
 * {
 *   "nodes": {
 *     "dev2":    { "roles": ["worker"], "ssh": true },
 *     "desktop": { "roles": ["worker"], "ssh": false }
 *   },
 *   "nodePrefixes": ["dev"]   // fallback when `nodes` absent
 * }
 *
 * Keys are matched against the node's operator display name (case-insensitive,
 * also matched as a substring of the display name) or the stable nodeId.
 */

export interface FleetNodeConfig {
  /** Roles this node plays in the fleet (e.g. "worker", "reviewer"). */
  roles?: string[];
  /** Whether SSH is available to this node from the manager. When false, provisioning/sync use the node channel. */
  ssh?: boolean;
  /** Free-form platform hint (e.g. "windows", "linux"). Informational. */
  platform?: string;
  /** Arbitrary operator tags for future routing. */
  tags?: string[];
}

export interface ResolvedFleetNode {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  platform?: string;
  /** Membership metadata from config, when explicitly listed. */
  member?: FleetNodeConfig;
  /** True when included via the legacy prefix fallback rather than explicit config. */
  viaPrefix?: boolean;
}

export interface FleetMembershipConfig {
  /** Explicit membership: key = node display name or nodeId. */
  nodes?: Record<string, FleetNodeConfig>;
  /** Legacy fallback: include nodes whose display name starts with one of these. */
  nodePrefixes?: string[];
}

/**
 * Resolve which gateway nodes are fleet members.
 * Explicit `nodes` config wins; `nodePrefixes` is the fallback.
 */
export function resolveFleetNodes(
  gatewayNodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    platform?: string;
  }>,
  cfg: { nodes?: Record<string, FleetNodeConfig>; nodePrefixes?: string[] },
): ResolvedFleetNode[] {
  const explicit = cfg.nodes ?? {};
  const explicitKeys = Object.keys(explicit);
  const out: ResolvedFleetNode[] = [];

  for (const n of gatewayNodes) {
    const name = n.displayName ?? n.nodeId;
    // Exact nodeId match, case-insensitive display-name match, or
    // display-name-contains match for keys like "desktop" vs "Windows Node (DESKTOP)".
    const key =
      explicitKeys.find((k) => k === n.nodeId) ??
      explicitKeys.find((k) => k.toLowerCase() === name.toLowerCase()) ??
      explicitKeys.find((k) => name.toLowerCase().includes(k.toLowerCase()));
    if (key) {
      out.push({ ...n, member: explicit[key], viaPrefix: false });
      continue;
    }
    // Fallback: prefix auto-include (legacy behavior).
    const prefixes = cfg.nodePrefixes ?? ["dev"];
    if (prefixes.some((p) => name.startsWith(p))) {
      out.push({ ...n, viaPrefix: true });
    }
  }
  return out;
}