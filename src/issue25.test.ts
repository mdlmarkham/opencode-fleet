import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const provision = readFileSync(join(here, "provision.ts"), "utf8");

/**
 * Issue #25 regression guards.
 *
 * The bug: the `safeDirCmd` steps were joined with a bare space (" "), so the
 * "add if absent" step and the following "verify" step concatenated without a
 * shell separator:
 *
 *   git config --system --add safe.directory 'X' git config --system --get-all ...
 *                                 ^^^^^^^^^^^^^^^^^^ no separator -> extra argv
 *
 * `git config` received the second command as extra arguments, the verify step
 * never ran as intended, and the whole provision command was malformed — so
 * `fleet_provision` failed on every node.
 *
 * Contract:
 *   1. the safe-directory steps are separated by an explicit shell separator
 *      (`;`), never just whitespace;
 *   2. the verify step fails CLOSED (non-zero) when it cannot confirm, rather
 *      than silently continuing;
 *   3. the step still emits the `---FLEET_SAFEDIR=ok` marker on success.
 */
describe("issue #25: fleet_provision emits well-formed shell", () => {
  it("separates the safe.directory steps with an explicit `;` (not a bare space)", () => {
    // The verify step must be preceded by a separator, not concatenated.
    expect(provision).toContain("`;`");
    // And must not sit directly after `--add ...`'s closing brace with only whitespace.
    expect(provision).not.toMatch(/--add safe\.directory[^`]*`,\s*\n\s*`git config --system --get-all/);
  });

  it("fails closed when safe.directory cannot be confirmed", () => {
    expect(provision).toContain("could not set safe.directory");
    expect(provision).toContain("exit 67");
  });

  it("still emits the success marker on the happy path", () => {
    expect(provision).toContain("---FLEET_SAFEDIR=ok");
  });
});
