/**
 * Node capability detection + constraint-based routing.
 *
 * Detects what each node can actually do (CPU/RAM/disk, GPU, installed tools,
 * available models) so fleet_dispatch can route work to nodes that satisfy
 * capability constraints — important when nodes have diverging capabilities.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SSH_ARGS, sshPrefix } from "./ssh.js";
import { shq } from "./shell.js";

const execFileP = promisify(execFile);

export interface NodeCapabilities {
  node: string;
  cpu?: string;
  memGb?: number;
  diskFreeGb?: number;
  gpu?: string[];
  tools?: string[];
  models?: string[];
  opencode?: string;
  /**
   * True when the node's opencode config carries the full issue-#51 deny-rule
   * baseline (checked with baselinePresent against the same opencode.json the
   * model catalog is read from). false when the config is missing/unparseable.
   */
  denyBaseline?: boolean;
  /**
   * Python environment facts (issue #19). A manager needs these to pick a
   * working dependency-install strategy per node — the fleet nodes differ
   * (PEP 668 vs bare venv), and the same command fails on one of them.
   */
  python?: {
    /** python3 version string, if present. */
    version?: string;
    /** Whether `python3 -m venv` is usable (ensurepip available). */
    venvAvailable?: boolean;
    /** Which pip install strategy the node requires. */
    pipStrategy?: "venv" | "user-break-system-packages" | "none";
    /** True when PEP 668 marks the system env externally-managed. */
    externallyManaged?: boolean;
  };
  /**
   * Isolation capabilities (issue #105 capability probe). Both booleans and
   * the `isolationLevels` list are derived from the SAME single SSH fact pass
   * as the rest of the record — the probe command echoes GITCLONE/BWRAP facts
   * alongside CPU/MEM/etc.
   */
  /** True when the node has a working `git` (probed via `git --version`). */
  gitClone?: boolean;
  /**
   * True when `bwrap` is present AND usable (probed via `bwrap --version`;
   * a present-but-broken binary — non-zero exit — counts as absent).
   */
  bwrap?: boolean;
  /**
   * Isolation levels the node can honour: "clone" when gitClone, "bwrap" only
   * when bwrap is usable. Derived from the booleans above by deriveIsolationLevels.
   */
  isolationLevels?: string[];
  /**
   * Build provenance: which CODE this node is actually running. A digest of the
   * node's installed dist .js modules (not the entry stub, which never changes) —
   * the manager can compare it to its own build to answer "merged but deployed?".
   */
  build?: { digest: string; short: string; modules: number };
  error?: string;
}

export interface CapabilityConstraint {
  /** Require a GPU (e.g. ["nvidia"] or true for any). */
  gpu?: boolean | string[];
  /** Minimum free disk in GB. */
  minDiskGb?: number;
  /** Minimum RAM in GB. */
  minMemGb?: number;
  /** Require a specific tool installed (e.g. "docker", "node"). */
  tools?: string[];
  /** Require a specific model available (e.g. "glm-5.3-flash:cloud"). */
  models?: string[];
}

/**
 * Detect capabilities on a node via SSH (manager has SSH access).
 */
export async function detectNodeCapabilities(nodeHost: string, nodeName: string, serviceUser?: string): Promise<NodeCapabilities> {
  const caps: NodeCapabilities = { node: nodeName };
  try {
    // Isolation facts default to UNSUPPORTED (issue #105): a probe that never
    // got the echo (partial transcript, older node) must surface an explicit
    // false — a missing fact is never reported as a capability.
    caps.gitClone = false;
    caps.bwrap = false;
    // One SSH pass collects every node fact (issues #19, #105): the whole
    // chain is a single command, so the isolation probes add no round-trip.
    const cmd = [
      `echo "CPU=$(nproc)"`,
      `echo "MEM=$(free -g | awk '/Mem:/{print $2}')"`,
      `echo "DISK=$(df -BG / | awk 'NR==2{print $4}' | tr -d 'G')"`,
      `echo "GPU=$(lspci 2>/dev/null | grep -iE 'vga|3d|nvidia|amd' | head -1 || echo none)"`,
      `echo "TOOLS=$(which docker node npm python3 go rustc 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\\n' ',')"`,
      `echo "OPENCODE=$(opencode --version 2>/dev/null || echo none)"`,
      // Python environment facts (issue #19).
      `echo "PYVER=$(python3 --version 2>/dev/null | awk '{print $2}' || echo none)"`,
      `echo "PYVENV=$(python3 -c 'import ensurepip' 2>/dev/null && echo yes || echo no)"`,
      `echo "PYPEP668=$(python3 -c 'import sysconfig,os; p=sysconfig.get_path("stdlib"); f=os.path.join(p,"EXTERNALLY-MANAGED"); print("yes" if os.path.exists(f) else "no")' 2>/dev/null || echo unknown)"`,
      `echo "PIPUSER=$(python3 -m pip --version >/dev/null 2>&1 && echo yes || echo no)"`,
      // Isolation capability facts (issue #105 capability probe). Part of the
      // SAME single SSH pass as every other fact — the whole chain is one
      // command, so no second round-trip: GITCLONE probes that git exists and
      // works (`--version`); BWRAP probes that bwrap exists AND runs cleanly
      // (a present-but-broken binary exits non-zero, so it counts as absent —
      // usable-ness, not mere presence).
      `echo "GITCLONE=$(git --version >/dev/null 2>&1 && echo yes || echo no)"`,
      `echo "BWRAP=$(bwrap --version >/dev/null 2>&1 && echo yes || echo no)"`,
    ].join(" && ");
    const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), cmd], {
      timeout: 30_000,
    });

    const lines = stdout.split("\n");
    for (const line of lines) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      switch (key) {
        case "CPU":
          caps.cpu = val;
          break;
        case "MEM":
          caps.memGb = parseInt(val, 10) || undefined;
          break;
        case "DISK":
          caps.diskFreeGb = parseInt(val, 10) || undefined;
          break;
        case "GPU":
          caps.gpu = val && val !== "none" ? [val] : [];
          break;
        case "TOOLS":
          caps.tools = val ? val.split(",").filter(Boolean) : [];
          break;
        case "OPENCODE":
          caps.opencode = val;
          break;
        case "PYVER":
          if (val && val !== "none") (caps.python ??= {}).version = val;
          break;
        case "PYVENV":
          (caps.python ??= {}).venvAvailable = val === "yes";
          break;
        case "PYPEP668":
          if (val === "yes" || val === "no") (caps.python ??= {}).externallyManaged = val === "yes";
          break;
        case "PIPUSER":
          break;
        case "GITCLONE":
          caps.gitClone = val === "yes";
          break;
        case "BWRAP":
          caps.bwrap = val === "yes";
          break;
      }
    }

    // Derive the pip install strategy from the facts (issue #19). This is the
    // signal a manager needs to avoid the per-node asymmetry: on dev2 (PEP 668
    // externally-managed) use a venv; on dev3 (bare venv, no ensurepip) use
    // --user --break-system-packages.
    {
      const py = (caps.python ??= {});
      if (py.version) {
        if (py.venvAvailable) py.pipStrategy = "venv";
        else if (py.externallyManaged) py.pipStrategy = "user-break-system-packages";
        else py.pipStrategy = "user-break-system-packages";
      } else {
        py.pipStrategy = "none";
      }
    }

    // Isolation levels (issue #105 capability probe): derived from the SAME
    // probed facts (gitClone/bwrap) via the shared pure helper.
    caps.isolationLevels = deriveIsolationLevels(caps.gitClone ?? false, caps.bwrap ?? false);

    // Read the node's OpenCode model catalog, and report whether the deny
    // baseline is present (issue #51 slice 2). The config lives on the NODE,
    // not on the gateway: read it over SSH as the service user (issue #51
    // review). Reading `homedir()` here reports the MANAGER's config for every
    // node — false assurance that silences the autoApprove safety warning.
    const { baselinePresent } = await import("./deny-baseline.js");
    const readNodeConfig = async (): Promise<unknown | undefined> => {
      const script = 'cat "$HOME/.config/opencode/opencode.json" 2>/dev/null';
      const user = serviceUser;
      const cmd = user
        ? `sudo -n -u ${shq(user)} -H bash -c ${shq(script)}`
        : `bash -c ${shq(script)}`;
      try {
        const { stdout } = await execFileP(
          "ssh",
          [...sshPrefix(nodeHost, SSH_ARGS), cmd],
          { timeout: 30_000 },
        );
        const text = stdout.trim();
        if (!text) return undefined;
        return JSON.parse(text) as unknown;
      } catch {
        // Remote read failed, node has no config, or it is unparseable — treat
        // as "no baseline" rather than falling back to the manager's config.
        return undefined;
      }
    };
    const cfg = (await readNodeConfig()) as
      | { provider?: Record<string, { models?: Record<string, unknown> }> }
      | undefined;
    if (cfg) {
      const models: string[] = [];
      for (const p of Object.values(cfg.provider ?? {})) {
        for (const modelId of Object.keys(p.models ?? {})) {
          models.push(modelId);
        }
      }
      caps.models = models;
      caps.denyBaseline = baselinePresent(cfg);
    } else {
      // No reachable/parseable node config — models unknown; no deny baseline.
      caps.denyBaseline = false;
    }

    return caps;
  } catch (err) {
    return { node: nodeName, error: (err as Error).message };
  }
}

/**
 * The isolation levels a node supports from the probed booleans (issue #105).
 *
 * Pure so the derivation rule is unit-testable without a node. "clone" needs a
 * working git clone; "bwrap" ONLY when bubblewrap is present AND usable — a
 * present-but-broken bwrap is as good as absent (fleet_dispatch refuses an
 * isolation level the node cannot actually honour, never downgrades).
 */
export function deriveIsolationLevels(gitClone: boolean, bwrap: boolean): string[] {
  const levels: string[] = [];
  if (gitClone) levels.push("clone");
  if (bwrap) levels.push("bwrap");
  return levels;
}

/**
 * Read the isolation facts out of a fake/real probe transcript (issue #105).
 *
 * Pure and independent of the full parse: `GITCLONE=yes|no`, `BWRAP=yes|no`.
 * A missing echo counts as "no" (the fact was not collected — treat as
 * unsupported rather than assuming support).
 */
export function parseIsolationFacts(output: string): { gitClone: boolean; bwrap: boolean } {
  const val = (key: string): boolean => {
    const line = output.split("\n").find((l) => l.includes(`${key}=`));
    if (!line) return false;
    return line.slice(line.indexOf(`${key}=`) + key.length + 1).trim() === "yes";
  };
  return { gitClone: val("GITCLONE"), bwrap: val("BWRAP") };
}

/**
 * Probe ONLY the isolation facts over SSH (one round-trip — the same
 * GITCLONE/BWRAP echoes the full pass uses, just alone). Used by
 * fleet_dispatch for the issue-#105 capability gate when the per-dispatch
 * isolation was not already established elsewhere.
 */
export async function probeIsolationLevels(nodeHost: string, serviceUser?: string): Promise<{ gitClone: boolean; bwrap: boolean; levels: string[]; error?: string }> {
  const cmd = [
    `echo "GITCLONE=$(git --version >/dev/null 2>&1 && echo yes || echo no)"`,
    `echo "BWRAP=$(bwrap --version >/dev/null 2>&1 && echo yes || echo no)"`,
  ].join(" && ");
  try {
    const { stdout } = await execFileP("ssh", [...sshPrefix(nodeHost, SSH_ARGS), cmd], { timeout: 30_000 });
    const facts = parseIsolationFacts(stdout);
    return { ...facts, levels: deriveIsolationLevels(facts.gitClone, facts.bwrap) };
  } catch (err) {
    // Unreachable or probe-failing node: refuse to claim levels it may not
    // have — the caller must fail closed on an explicitly requested level.
    return { gitClone: false, bwrap: false, levels: [], error: (err as Error).message };
  }
}

/**
 * Check whether a node's capabilities satisfy the given constraints.
 */
export function satisfiesConstraints(caps: NodeCapabilities, c: CapabilityConstraint): { ok: boolean; reason?: string } {
  if (c.gpu) {
    const hasGpu = (caps.gpu ?? []).length > 0;
    if (!hasGpu) return { ok: false, reason: "no GPU" };
    if (Array.isArray(c.gpu) && c.gpu.length) {
      const gpuStr = (caps.gpu ?? []).join(" ").toLowerCase();
      if (!c.gpu.some((g) => gpuStr.includes(g.toLowerCase()))) {
        return { ok: false, reason: `GPU does not match ${c.gpu.join("/")}` };
      }
    }
  }
  if (c.minDiskGb && (caps.diskFreeGb ?? 0) < c.minDiskGb) {
    return { ok: false, reason: `only ${caps.diskFreeGb}GB free (need ${c.minDiskGb}GB)` };
  }
  if (c.minMemGb && (caps.memGb ?? 0) < c.minMemGb) {
    return { ok: false, reason: `only ${caps.memGb}GB RAM (need ${c.minMemGb}GB)` };
  }
  if (c.tools?.length) {
    const missing = c.tools.filter((t) => !(caps.tools ?? []).includes(t));
    if (missing.length) return { ok: false, reason: `missing tools: ${missing.join(", ")}` };
  }
  if (c.models?.length) {
    const missing = c.models.filter((m) => !(caps.models ?? []).includes(m));
    if (missing.length) return { ok: false, reason: `missing models: ${missing.join(", ")}` };
  }
  return { ok: true };
}
