import { describe, expect, it } from "vitest";
import {
  AUTO_SUPPORT_MIN_VERSION,
  BASELINE_DENY,
  baselinePresent,
  detectAutoSupport,
  mergeDenyBaseline,
  type PermissionAction,
} from "./deny-baseline.js";

/* Issue #51, slice 1 checks. Scope reminder: this slice is the SAFETY ARTIFACT
 * ONLY — the baseline data + pure merge/detection helpers. Nothing else in the
 * plugin may import it yet (slice 2 wires it), so these tests cover the data
 * contract, the union/idempotence/conflict semantics, and the --auto predicate.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-scan: EVERY permission value anywhere in the baseline (or any config) is "deny". */
function allValuesDeny(v: unknown): boolean {
  if (!isPlainObject(v)) return v === "deny";
  return Object.values(v).every(allValuesDeny);
}

describe("#51 slice 1: BASELINE_DENY is a deny-only, documented data baseline", () => {
  it("is pure data: frozen, non-empty pattern maps, every value exactly 'deny'", () => {
    expect(Object.isFrozen(BASELINE_DENY)).toBe(true);
    for (const [cat, denies] of Object.entries(BASELINE_DENY)) {
      expect(isPlainObject(denies), cat).toBe(true);
      expect(Object.isFrozen(denies), cat).toBe(true);
      expect(Object.keys(denies).length, cat).toBeGreaterThan(0);
      for (const v of Object.values(denies)) {
        expect(v, cat).toBe("deny");
        expect(typeof v === "function", cat).toBe(false);
      }
    }
    expect(allValuesDeny(BASELINE_DENY)).toBe(true);
  });

  it("covers category 1: external_directory denied wholesale (catch-all deny = out-of-cwd access)", () => {
    expect(BASELINE_DENY.external_directory["*"]).toBe("deny");
    expect(BASELINE_DENY.external_directory["**"]).toBe("deny");
  });

  it("covers category 2: destructive shell patterns (rm -rf non-descendants, git push, curl|sh, sh -c curl)", () => {
    const b = BASELINE_DENY.bash;
    // rm -rf of NON-descendants: absolute, traversal, home tilde/$HOME, preserve-root, sudo
    for (const p of [
      "rm -rf /*", "rm -fr /*",
      "rm -rf ..*", "rm -fr ..*",
      "rm -rf ~*", "rm -fr ~*",
      "rm -rf $HOME*", "rm -fr $HOME*",
      "rm -rf --no-preserve-root*", "rm -fr --no-preserve-root*",
      "sudo rm -rf /*", "sudo rm -fr /*", "sudo rm -rf ~*",
    ]) {
      expect(b[p], p).toBe("deny");
    }
    // git push (workers publish through the manager)
    for (const p of ["git push*", "git -C*push*", "sudo git push*"]) expect(b[p], p).toBe("deny");
    // curl|sh / sh -c curl (and the wget mirrors of the same vectors)
    expect(b["curl*|*sh*"]).toBe("deny");
    expect(b["wget*|*sh*"]).toBe("deny");
    expect(b["*sh -c*curl*"]).toBe("deny");
    expect(b["*sh -c*wget*"]).toBe("deny");
  });

  it("covers category 3: reads of the six credential paths are denied", () => {
    const patterns = Object.keys(BASELINE_DENY.read);
    for (const cred of ["~/.ssh", "~/.config/gh", "~/.aws", "~/.config/gcloud", ".netrc", ".npmrc"]) {
      expect(patterns.some((p) => p.includes(cred)), `a read deny for ${cred}`).toBe(true);
    }
    // dir + contents coverage for the home-anchored ones
    for (const dir of ["~/.ssh", "~/.config/gh", "~/.aws", "~/.config/gcloud"]) {
      expect(BASELINE_DENY.read[dir]).toBe("deny");
      expect(BASELINE_DENY.read[`${dir}/**`]).toBe("deny");
    }
    // netrc/npmrc: home + anywhere forms
    expect(BASELINE_DENY.read["~/.netrc"]).toBe("deny");
    expect(BASELINE_DENY.read["**/.netrc"]).toBe("deny");
    expect(BASELINE_DENY.read["~/.npmrc"]).toBe("deny");
    expect(BASELINE_DENY.read["**/.npmrc"]).toBe("deny");
  });

  it("covers category 4: network egress commands not needed for a coding task are denied", () => {
    const b = BASELINE_DENY.bash;
    // raw download tools
    expect(b["curl*"]).toBe("deny");
    expect(b["wget*"]).toBe("deny");
    // node-to-node egress and socket relays
    for (const p of ["ssh *", "scp *", "sftp *", "nc *", "ncat *", "netcat *", "socat *", "telnet *", "ftp *"]) {
      expect(b[p], p).toBe("deny");
    }
    // bash /dev/tcp,/dev/udp redirect egress
    expect(b["*>*dev/tcp*"]).toBe("deny");
    expect(b["*>*dev/udp*"]).toBe("deny");
    // the engine's own fetch tool is the same egress floor
    expect(BASELINE_DENY.webfetch["*"]).toBe("deny");
    // deliberately NOT denied: package managers and git's own network ops
    // (a coding task needs them; documented in the module).
    for (const needed of ["npm *", "npm install*", "pip install*", "git fetch*", "git pull*", "git clone*"]) {
      expect(b[needed], `${needed} must stay allowed by the baseline`).toBeUndefined();
    }
  });
});

describe("#51 slice 1: mergeDenyBaseline (union, pure, idempotent)", () => {
  it("merges deny lists in as a UNION: user rules and unrelated keys are preserved", () => {
    const config = {
      model: "glm-5.3-flash:cloud",
      theme: "dark",
      agent: "build",
      permission: {
        edit: "ask",
        bash: { "ls*": "allow", "npm *": "ask", "git status*": "deny" },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(config));
    const merged = mergeDenyBaseline(config);

    // returns a NEW object; input untouched
    expect(merged).not.toBe(config);
    expect(merged.permission).not.toBe(config.permission);
    expect(JSON.parse(JSON.stringify(config))).toEqual(snapshot);

    // unrelated top-level keys and permission categories preserved
    expect(merged.model).toBe("glm-5.3-flash:cloud");
    expect(merged.theme).toBe("dark");
    expect(merged.agent).toBe("build");
    expect(merged.permission?.edit).toBe("ask");
    const bash = merged.permission?.bash as Record<string, PermissionAction>;
    expect(bash["ls*"]).toBe("allow");
    expect(bash["npm *"]).toBe("ask");
    expect(bash["git status*"]).toBe("deny");

    // and every baseline pattern is present-and-deny after the merge
    expect(baselinePresent(merged)).toBe(true);
  });

  it("adds the full baseline when the config has no permission block (or is not a config)", () => {
    for (const empty of [undefined, null, 7, "not a config", [], {}]) {
      const merged = mergeDenyBaseline(empty);
      expect(isPlainObject(merged.permission), String(empty)).toBe(true);
      for (const [cat, denies] of Object.entries(BASELINE_DENY)) {
        expect((merged.permission as Record<string, unknown>)[cat], String(cat)).toEqual(denies);
      }
      expect(baselinePresent(merged)).toBe(true);
    }
    // malformed permission block: replaced by the deny-only baseline (fail-safe)
    const merged = mergeDenyBaseline({ permission: "allow everything", note: "kept" });
    expect(merged.note).toBe("kept");
    expect(baselinePresent(merged)).toBe(true);
  });

  it("is idempotent: merging twice deep-equals merging once (including JSON round-trip)", () => {
    const config = {
      permission: {
        bash: { "ls*": "allow", "git push*": "deny" },
        edit: "ask",
        external_directory: "deny",
      },
      extra: { a: 1 },
    };
    const once = mergeDenyBaseline(config);
    const twice = mergeDenyBaseline(mergeDenyBaseline(config));
    expect(twice).toEqual(once);

    const fromJson = JSON.parse(JSON.stringify(once));
    expect(fromJson).toEqual(once);
    expect(mergeDenyBaseline(fromJson)).toEqual(once);

    // also idempotent over a config that already contains the baseline verbatim
    const withBaseline = { permission: JSON.parse(JSON.stringify(BASELINE_DENY)) };
    expect(mergeDenyBaseline(withBaseline)).toEqual(withBaseline);
  });

  it("never duplicates patterns: an already-present pattern is not re-added", () => {
    const config = { permission: { bash: { "git push*": "deny", "ls*": "allow" } } };
    const merged = mergeDenyBaseline(config);
    const mergedTwice = mergeDenyBaseline(mergeDenyBaseline(config));
    const keys = Object.keys(merged.permission?.bash as Record<string, unknown>);
    const keysTwice = Object.keys(mergedTwice.permission?.bash as Record<string, unknown>);
    expect(keysTwice.length).toBe(keys.length);
    expect(keysTwice).toEqual(keys);
    expect(keys.filter((k) => k === "git push*").length).toBe(1);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("#51 slice 1: mergeDenyBaseline adversarial — a conflicting ALLOW must lose", () => {
  it("tightens a user ALLOW on a denied pattern to deny (no duplicate, other rules kept)", () => {
    const adversarial = {
      permission: {
        // deliberately hostile: the node config allows exactly what the baseline denies
        external_directory: "allow",
        bash: {
          "git push*": "allow",
          "curl*": "ask",
          "rm -rf /*": "allow",
          // unrelated harmless user rules that must survive
          "ls*": "allow",
          "git status*": "ask",
        },
        edit: "ask",
      },
      model: "x",
    };
    const merged = mergeDenyBaseline(adversarial);
    const bash = merged.permission?.bash as Record<string, PermissionAction>;
    const ed = merged.permission?.external_directory as Record<string, PermissionAction>;

    // baseline WINS every pattern it denies...
    expect(bash["git push*"]).toBe("deny");
    expect(bash["curl*"]).toBe("deny");
    expect(bash["rm -rf /*"]).toBe("deny");
    // ...and on the catch-all category too (external_directory "allow" falls to deny)
    expect(ed["*"]).toBe("deny");
    expect(ed["**"]).toBe("deny");

    // nothing else the user allowed/asked is dropped, and the merge introduced
    // no duplicates: exactly one key per denied pattern.
    expect(bash["ls*"]).toBe("allow");
    expect(bash["git status*"]).toBe("ask");
    expect(merged.permission?.edit).toBe("ask");
    expect(merged.model).toBe("x");
    const keys = Object.keys(bash);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === "git push*").length).toBe(1);
    expect(keys.filter((k) => k === "rm -rf /*").length).toBe(1);

    // the tightened config still reports the baseline as present
    expect(baselinePresent(merged)).toBe(true);

    // and the merge is still idempotent over the hostile input
    expect(mergeDenyBaseline(mergeDenyBaseline(adversarial))).toEqual(merged);
  });

  it("keeps a NARROWER user allow that does not share the denied pattern, alongside the deny", () => {
    const config = {
      permission: {
        external_directory: { "~/shared/**": "allow" },
        bash: { "curl*": "allow" },
      },
    };
    const merged = mergeDenyBaseline(config);
    const ed = merged.permission?.external_directory as Record<string, PermissionAction>;
    expect(ed["~/shared/**"]).toBe("allow"); // user's narrower rule preserved
    expect(ed["*"]).toBe("deny"); // baseline catch-all deny added
    expect(ed["**"]).toBe("deny");
    const bash = merged.permission?.bash as Record<string, PermissionAction>;
    expect(bash["curl*"]).toBe("deny"); // exact-pattern conflict → baseline wins
    expect(baselinePresent(merged)).toBe(true);
  });
});

describe("#51 slice 1: baselinePresent", () => {
  it("is false for anything that does not carry the full baseline", () => {
    expect(baselinePresent(undefined)).toBe(false);
    expect(baselinePresent(null)).toBe(false);
    expect(baselinePresent("opencode.json")).toBe(false);
    expect(baselinePresent({})).toBe(false);
    expect(baselinePresent({ permission: {} })).toBe(false);
    expect(baselinePresent({ permission: { bash: { "ls*": "allow" } } })).toBe(false);
    // a baseline pattern demoted to ask instead of deny
    expect(
      baselinePresent({
        permission: {
          external_directory: BASELINE_DENY.external_directory,
          bash: { ...BASELINE_DENY.bash, "git push*": "ask" },
          read: BASELINE_DENY.read,
          webfetch: BASELINE_DENY.webfetch,
        },
      }),
    ).toBe(false);
    // a whole category missing
    const missingCat = JSON.parse(JSON.stringify(BASELINE_DENY)) as Record<string, unknown>;
    expect(missingCat.read).toBeDefined();
    delete missingCat.read;
    expect(baselinePresent({ permission: missingCat })).toBe(false);
    // scalar allow/ask for a denied category
    for (const weak of ["allow", "ask"]) {
      expect(
        baselinePresent({
          permission: {
            external_directory: weak,
            bash: BASELINE_DENY.bash,
            read: BASELINE_DENY.read,
            webfetch: "deny",
          },
        }),
      ).toBe(false);
    }
  });

  it("is true after mergeDenyBaseline, for the baseline verbatim, and for a scalar-deny handwrite", () => {
    expect(baselinePresent(mergeDenyBaseline({}))).toBe(true);
    expect(baselinePresent(mergeDenyBaseline({ model: "m", permission: { edit: "ask" } }))).toBe(true);
    expect(baselinePresent({ permission: JSON.parse(JSON.stringify(BASELINE_DENY)) })).toBe(true);
    // a whole-category scalar "deny" handwrite also covers its category
    expect(
      baselinePresent({
        permission: {
          external_directory: "deny",
          bash: BASELINE_DENY.bash,
          read: BASELINE_DENY.read,
          webfetch: "deny",
        },
      }),
    ).toBe(true);
  });
});

describe("#51 slice 1: detectAutoSupport (pure predicate for `opencode run --auto`)", () => {
  it("threshold is pinned to the verified floor (issue #30: dev2 at 1.18.26 runs --auto)", () => {
    expect(AUTO_SUPPORT_MIN_VERSION).toBe("1.18.0");
  });

  it("true: version at/above the threshold, with messy banner shapes tolerated", () => {
    expect(detectAutoSupport({ version: "1.18.26" })).toBe(true);
    expect(detectAutoSupport({ version: "opencode 1.18.26 (2026-05-10)" })).toBe(true);
    expect(detectAutoSupport({ version: "v2.3.4" })).toBe(true);
    expect(detectAutoSupport({ version: "1.18.0" })).toBe(true);
    expect(detectAutoSupport({ version: "3.0.0-rc.1+build.7" })).toBe(true);
    expect(detectAutoSupport({ version: "1.18.26-dev.42" })).toBe(true);

    // --help evidence alone is sufficient — even for an old or unparseable version
    const help = [
      "Usage: opencode run [message..]",
      "",
      "Flags:",
      "     --auto     Approve all permissions automatically for this run",
      "     --model    Model to use",
    ].join("\n");
    expect(detectAutoSupport({ helpText: help })).toBe(true);
    expect(detectAutoSupport({ version: "opencode 0.4.2", helpText: help })).toBe(true);
    expect(detectAutoSupport({ version: "unparseable", helpText: help })).toBe(true);
  });

  it("false: old, absent, garbage, or a lookalike flag", () => {
    expect(detectAutoSupport({})).toBe(false);
    expect(detectAutoSupport(undefined as unknown as { version?: string; helpText?: string })).toBe(false);
    for (const bad of ["", "garbage", "not-a-version", "opencode", "version 3 please"]) {
      expect(detectAutoSupport({ version: bad }), JSON.stringify(bad)).toBe(false);
    }
    // old builds (below the pinned threshold)
    for (const old of ["0.4.2", "opencode 0.47.2", "1.17.9"]) {
      expect(detectAutoSupport({ version: old }), old).toBe(false);
    }
    // --auto-approve / --autonomous / --automatic are NOT --auto (word-bounded)
    expect(
      detectAutoSupport({ helpText: "  --auto-approve    approve everything\n  --autonomous  unattended" }),
    ).toBe(false);
    expect(detectAutoSupport({ helpText: "supports automatic approval — no such flag listed" })).toBe(false);
    // version below threshold with weak help: still false
    expect(detectAutoSupport({ version: "0.4.2", helpText: "auto-approve only" })).toBe(false);
  });
});