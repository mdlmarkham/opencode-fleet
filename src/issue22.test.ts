import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenCodeCommand, type OpenCodeTask } from "./opencode.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "index.ts"), "utf8");

/**
 * Issue #22 regression guards.
 *
 * fleet_dispatch ran ZERO work and reported success. Four defects in the
 * generated launcher, any one fatal on its own:
 *   1. worker cannot cd into a /root cwd (Permission denied) — but the script
 *      continued and exit code was laundered;
 *   2. the prompt was never substituted — `__RUN_START__` reached opencode;
 *   3. the prompt was positioned as a flag value, so it was not the message;
 *   4. no `set -e`/fail-closed, so all of the above reported exitCode 0.
 */

function baseTask(over: Partial<OpenCodeTask> = {}): OpenCodeTask {
  return { prompt: "do the thing", cwd: "/srv/work/repo", transport: "http", ...over };
}

describe("issue #22 bug 1+4: cd must fail closed", () => {
  it("guards cd and exits non-zero on failure", () => {
    const cmd = buildOpenCodeCommand(baseTask());
    expect(cmd).toContain("cd '/srv/work/repo' ||");
    expect(cmd).toContain("exit 66");
    // The guard must come BEFORE the opencode invocation.
    expect(cmd.indexOf("cd '/srv/work/repo' ||")).toBeLessThan(cmd.indexOf("opencode run"));
  });

  it("names the principal and cwd in the failure so the cause is legible", () => {
    const cmd = buildOpenCodeCommand(baseTask({ cwd: "/root/ohm-ts-sidecar" }));
    expect(cmd).toContain("FLEET_ERROR");
    expect(cmd).toContain("cannot enter cwd /root/ohm-ts-sidecar");
    expect(cmd).toContain("$(id -un)");
  });

  it("the cd guard is emitted for acp transport too", () => {
    const cmd = buildOpenCodeCommand(baseTask({ transport: "acp" }));
    expect(cmd).toContain("cd '/srv/work/repo' ||");
    expect(cmd).toContain("exit 66");
  });
});

describe("issue #22 bug 2: the prompt must be the real prompt", () => {
  it("refuses to build a command when the prompt is empty", () => {
    expect(() => buildOpenCodeCommand(baseTask({ prompt: "" }))).toThrow(/no prompt/i);
    expect(() => buildOpenCodeCommand(baseTask({ prompt: "   " }))).toThrow(/no prompt/i);
  });

  it("refuses to build a command when the prompt is an unsubstituted control placeholder", () => {
    for (const p of ["__RUN_START__", "__RUN_STATUS__", "__RUN_RESULT__", "__RUN_ABORT__"]) {
      expect(() => buildOpenCodeCommand(baseTask({ prompt: p }))).toThrow(/placeholder/i);
    }
  });

  it("carries the real prompt into the command when one is supplied", () => {
    const cmd = buildOpenCodeCommand(baseTask({ prompt: "refactor the parser" }));
    expect(cmd).toContain("refactor the parser");
    expect(cmd).not.toContain("__RUN_START__");
  });
});

describe("issue #22 bug 3: the prompt is delivered as the message, not a flag value", () => {
  it("passes the prompt after a `--` separator", () => {
    const cmd = buildOpenCodeCommand(baseTask({ agent: "build", prompt: "fix the bug" }));
    expect(cmd).toContain("-- ");
    // The prompt must come after -- and after --format json, not between flags.
    const dashIdx = cmd.indexOf(" -- ");
    const promptIdx = cmd.indexOf("'fix the bug'");
    expect(promptIdx).toBeGreaterThan(dashIdx);
    // It must NOT sit between --agent and --format.
    const seg = cmd.slice(cmd.indexOf("--agent"), cmd.indexOf("--format"));
    expect(seg).not.toContain("fix the bug");
  });
});

describe("issue #22: detached launcher wiring", () => {
  it("the node handler requires realPrompt before launching", () => {
    expect(indexSrc).toContain("realPrompt");
    expect(indexSrc).toContain("refusing to launch an empty session");
  });

  it("the manager sends the real prompt alongside the sentinel", () => {
    expect(indexSrc).toContain('prompt: "__RUN_START__", realPrompt: p.prompt');
  });

  it("the generated script does not launder the exit code", () => {
    expect(indexSrc).toContain('"set -u"');
  });
});
