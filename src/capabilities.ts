/**
 * Node capability detection + constraint-based routing.
 *
 * Detects what each node can actually do (CPU/RAM/disk, GPU, installed tools,
 * available models) so fleet_dispatch can route work to nodes that satisfy
 * capability constraints — important when nodes have diverging capabilities.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SSH_ARGS } from "./ssh.js";

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
export async function detectNodeCapabilities(nodeHost: string, nodeName: string): Promise<NodeCapabilities> {
  const caps: NodeCapabilities = { node: nodeName };
  try {
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
    ].join(" && ");
    const { stdout } = await execFileP("ssh", [...SSH_ARGS, nodeHost, cmd], {
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

    // Read the node's OpenCode model catalog.
    try {
      const raw = await readFile(join(homedir(), ".config", "opencode", "opencode.json"), "utf8");
      const cfg = JSON.parse(raw) as { provider?: Record<string, { models?: Record<string, unknown> }> };
      const models: string[] = [];
      for (const p of Object.values(cfg.provider ?? {})) {
        for (const modelId of Object.keys(p.models ?? {})) {
          models.push(modelId);
        }
      }
      caps.models = models;
    } catch {
      // No config — models unknown.
    }

    return caps;
  } catch (err) {
    return { node: nodeName, error: (err as Error).message };
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
