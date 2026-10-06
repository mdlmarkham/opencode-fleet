import { describe, expect, it } from "vitest";
import {
  BASELINE_DENY,
  baselinePresent,
  mergeDenyBaseline,
  type PermissionAction,
} from "./deny-baseline.js";

/* Issue #51c — order semantics of the deny-baseline merge.
 *
 * LIVE-VERIFIED (opencode 1.18.25 on dev3, 2026-10-06, scratch XDG configs,
 * `opencode run --format json`, every nested run `timeout 90`):
 *   - probe 1: {"bash":{"git push*":"deny","*":"allow"}} → `git push --dry-run
 *     origin master` EXECUTED (bash tool `status: completed`, exit 128 =
 *     missing remote — no permission rejection): the later broad allow shadowed
 *     the deny.
 *   - probe 2: {"bash":{"*":"allow","git push*":"deny"}} → same push DENIED
 *     (bash tool `status: error`, metadata null): the later deny won.
 *   - control probe (diag): {"bash":{"*":"deny"}} removed the bash tool.
 *   - probe 3 (baseline-shaped, feeds the curl scoping decision; no code
 *     change): {"bash":{"curl*":"deny"}} → `curl -sS http://127.0.0.1:9/`
 *     DENIED (status error, metadata null).
 * ⇒ opencode permission evaluation is LAST-MATCH-WINS by rule position, so
 * mergeDenyBaseline must emit user rules FIRST and re-add every baseline key
 * LAST. BASELINE WINS then holds for pattern-shadow conflicts (a broad user
 * allow in front of / before a baseline pattern), not just exact-key ones.
 */

type BashMap = Record<string, PermissionAction>;
const bashOf = (config: unknown): BashMap =>
  ((config as { permission?: { bash?: unknown } }).permission?.bash ?? {}) as BashMap;

/** Position of a key in the merged map's insertion order (JSON key order is
 *  what opencode's fromConfig flattening preserves into the ruleset). */
const positionOf = (m: BashMap, key: string): number => Object.keys(m).indexOf(key);

describe("#51c: mergeDenyBaseline is order-safe under live-verified last-match-wins", () => {
  it("the #106 shadow case: user allows broadly, baseline git push* deny stays LAST and wins", () => {
    const hostile = {
      permission: {
        bash: { "git *": "allow" },
      },
    };
    const merged = mergeDenyBaseline(hostile);
    const bash = bashOf(merged);

    // The user rule is preserved verbatim...
    expect(bash["git *"]).toBe("allow");
    // ...every baseline pattern is still present-and-deny...
    for (const [p, a] of Object.entries(BASELINE_DENY.bash)) expect(bash[p]).toBe(a);
    // ...and the baseline sits AFTER the broad allow, so under last-match-wins
    // an evaluated `git push ...` resolves to the baseline deny, not the allow.
    expect(positionOf(bash, "git push*")).toBeGreaterThan(positionOf(bash, "git *"));
    expect(baselinePresent(merged)).toBe(true);
  });

  it("baseline keys are emitted LAST for every merged map category, whatever the user order", () => {
    // The exact probe-1/probe-2 pair, plus a hostile exact-key allow.
    const variants: unknown[] = [
      { permission: { bash: { "git push*": "deny", "*": "allow" } } },
      { permission: { bash: { "*": "allow", "git push*": "deny" } } },
      { permission: { bash: { "git push*": "allow", "*": "allow" } } },
      { permission: { bash: { "ls*": "allow", "curl*": "ask", "git status*": "deny" } } },
    ];
    for (const [i, v] of variants.entries()) {
      const merged = mergeDenyBaseline(v);
      const bash = bashOf(merged);
      const keys = Object.keys(bash);
      const lastBaselinePos = Math.max(...Object.keys(BASELINE_DENY.bash).map((k) => keys.indexOf(k)));
      const firstUserPos = Math.min(
        ...keys.filter((k) => !(k in BASELINE_DENY.bash)).map((k) => keys.indexOf(k)),
      );
      expect(lastBaselinePos, `variant ${i}: some baseline key is not last`).toBeGreaterThan(firstUserPos);
      expect(Object.keys(BASELINE_DENY.bash).every((k) => bash[k] === "deny"), `variant ${i}`).toBe(true);
      expect(baselinePresent(merged), `variant ${i}`).toBe(true);
    }
  });

  it("exact-key conflicts resolve to deny with NO duplicate key (absorbed into the last block)", () => {
    const merged = mergeDenyBaseline({
      permission: { bash: { "git push*": "allow", "curl*": "ask", "ls*": "allow" } },
    });
    const bash = bashOf(merged);
    expect(bash["git push*"]).toBe("deny");
    expect(bash["curl*"]).toBe("deny");
    expect(bash["ls*"]).toBe("allow");
    const keys = Object.keys(bash);
    expect(keys.filter((k) => k === "git push*").length).toBe(1);
    expect(keys.filter((k) => k === "curl*").length).toBe(1);
    // and they sit with the baseline block, at the end
    expect(Math.max(keys.indexOf("git push*"), keys.indexOf("curl*")))
      .toBeGreaterThan(keys.indexOf("ls*"));
  });

  it("unrelated user keys and their relative positions are preserved; every baseline key ends deny", () => {
    const config = {
      model: "m",
      theme: "dark",
      permission: {
        edit: "ask",
        bash: { "ls*": "allow", "npm *": "ask", "git status*": "deny", "cargo *": "allow" },
      },
    };
    const merged = mergeDenyBaseline(config);
    // unrelated top-level keys preserved
    expect(merged.model).toBe("m");
    expect(merged.theme).toBe("dark");
    expect(merged.permission?.edit).toBe("ask");
    // user bash rules preserved AND in their original relative order, all
    // BEFORE any baseline key
    const bash = bashOf(merged);
    const userKeys = Object.keys(bash).filter((k) => !(k in BASELINE_DENY.bash));
    expect(userKeys).toEqual(["ls*", "npm *", "git status*", "cargo *"]);
    expect(bash["ls*"]).toBe("allow");
    expect(bash["npm *"]).toBe("ask");
    expect(bash["git status*"]).toBe("deny");
    expect(bash["cargo *"]).toBe("allow");
    // every baseline key ends with value deny, and is last
    for (const [p, a] of Object.entries(BASELINE_DENY.bash)) {
      expect(bash[p], p).toBe(a);
      expect(a, p).toBe("deny");
      expect(positionOf(bash, p)).toBeGreaterThan(Math.max(...userKeys.map((k) => Object.keys(bash).indexOf(k))));
    }
    expect(baselinePresent(merged)).toBe(true);
  });

  it("remains idempotent and JSON-round-trip stable under the new ordering", () => {
    const config = {
      permission: {
        bash: { "git *": "allow", "ls*": "allow" },
        edit: "ask",
      },
    };
    const once = mergeDenyBaseline(config);
    const twice = mergeDenyBaseline(mergeDenyBaseline(config));
    expect(twice).toEqual(once);
    // exact key order also stable (no churn between installs)
    expect(Object.keys(bashOf(twice))).toEqual(Object.keys(bashOf(once)));
    const fromJson = JSON.parse(JSON.stringify(once));
    expect(mergeDenyBaseline(fromJson)).toEqual(once);
    expect(Object.keys(bashOf(mergeDenyBaseline(fromJson)))).toEqual(Object.keys(bashOf(once)));
  });

  it("control pin: the merged map keeps the exact probe-2 shape that DENIED live, deny last", () => {
    // probe 2 live evidence (opencode 1.18.25): {"*":"allow","git push*":"deny"}
    // DENIED `git push --dry-run origin master`. The merge of a user map must
    // produce exactly that winner-last shape for the baseline patterns.
    const merged = mergeDenyBaseline({
      permission: { bash: { "*": "allow" } },
    });
    const bash = bashOf(merged);
    expect(bash["*"]).toBe("allow");
    for (const [p, a] of Object.entries(BASELINE_DENY.bash)) {
      expect(bash[p], p).toBe(a);
      expect(positionOf(bash, p)).toBeGreaterThan(positionOf(bash, "*"));
    }
    expect(baselinePresent(merged)).toBe(true);
  });
});