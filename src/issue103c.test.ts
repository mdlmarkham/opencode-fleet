/**
 * Issue #103 group c: the node-side env knobs become settable in the plugin
 * config (with env still as the override).
 *
 * `allowedRoots()` (src/guard.ts) honors the config's `allowedRoots`, and
 * `fleetStateDir()` (src/paths.ts) honors the config's `stateDir`. An explicit
 * process env value wins over config, and with neither set the behavior is
 * byte-identical to before.
 */

import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { allowedRoots, setNodeEnvConfig, getDefaultNodeEnvConfig } from "./guard.js";
import { fleetStateDir } from "./paths.js";
import { FLEET_DIRNAME } from "./cwd.js";

const prevRootsEnv = process.env.FLEET_ALLOWED_ROOTS;
const prevStateEnv = process.env.FLEET_STATE_DIR;

afterEach(() => {
  if (prevRootsEnv === undefined) delete process.env.FLEET_ALLOWED_ROOTS;
  else process.env.FLEET_ALLOWED_ROOTS = prevRootsEnv;
  if (prevStateEnv === undefined) delete process.env.FLEET_STATE_DIR;
  else process.env.FLEET_STATE_DIR = prevStateEnv;
  setNodeEnvConfig(undefined);
});

describe("issue #103 group c: allowedRoots honors the plugin config (env still overrides)", () => {
  it("returns the config roots when env is unset", () => {
    delete process.env.FLEET_ALLOWED_ROOTS;
    const roots = allowedRoots(process.env, "/home/u", { allowedRoots: ["/srv/work", "/data/x"] });
    expect(roots).toEqual(["/srv/work", "/data/x"].map((r) => resolve(r)));
    for (const r of roots) expect(isAbsolute(r)).toBe(true);
  });

  it("env overrides config when env IS set", () => {
    process.env.FLEET_ALLOWED_ROOTS = "/from/env";
    const roots = allowedRoots(process.env, "/home/u", { allowedRoots: ["/srv/work", "/data/x"] });
    expect(roots).toEqual([resolve("/from/env")]);
  });

  it("returns the current default when neither env nor config is set (absolute, resolved)", () => {
    delete process.env.FLEET_ALLOWED_ROOTS;
    const roots = allowedRoots(process.env, "/home/u");
    expect(roots).toEqual([resolve(join("/home/u", FLEET_DIRNAME)), resolve("/home/u")]);
    for (const r of roots) expect(isAbsolute(r)).toBe(true);
  });

  it("relative config entries are dropped, like relative env entries always were", () => {
    delete process.env.FLEET_ALLOWED_ROOTS;
    expect(allowedRoots(process.env, "/home/u", { allowedRoots: ["rel", "/abs"] })).toEqual([resolve("/abs")]);
  });
});

describe("issue #103 group c: fleetStateDir honors the plugin config (env still overrides)", () => {
  it("returns the config value when env is unset", () => {
    delete process.env.FLEET_STATE_DIR;
    expect(fleetStateDir(process.env, { stateDir: "/x/config-state" })).toBe("/x/config-state");
  });

  it("env wins when set", () => {
    process.env.FLEET_STATE_DIR = "/x/env-state";
    expect(fleetStateDir(process.env, { stateDir: "/x/config-state" })).toBe("/x/env-state");
  });

  it("default unchanged when neither is set", () => {
    delete process.env.FLEET_STATE_DIR;
    expect(fleetStateDir(process.env)).toBe(join(homedir(), ".openclaw", "fleet", "state"));
  });
});

describe("issue #103 group c: captured plugin config (setNodeEnvConfig) feeds the defaults", () => {
  it("guardCwd-style defaults read the captured config: allowedRoots via getDefaultNodeEnvConfig", () => {
    delete process.env.FLEET_ALLOWED_ROOTS;
    setNodeEnvConfig({ allowedRoots: ["/srv/captured"], stateDir: "/x/captured-state" });
    expect(getDefaultNodeEnvConfig()).toEqual({ allowedRoots: ["/srv/captured"], stateDir: "/x/captured-state" });
    expect(allowedRoots(process.env, "/home/u", getDefaultNodeEnvConfig())).toEqual([resolve("/srv/captured")]);
    expect(fleetStateDir(process.env, getDefaultNodeEnvConfig())).toBe("/x/captured-state");
  });

  it("a clear of the capture restores the env/default behavior", () => {
    delete process.env.FLEET_STATE_DIR;
    setNodeEnvConfig({ stateDir: "/x/captured-state" });
    expect(fleetStateDir(process.env, getDefaultNodeEnvConfig())).toBe("/x/captured-state");
    setNodeEnvConfig(undefined);
    expect(fleetStateDir(process.env, getDefaultNodeEnvConfig())).toBe(join(homedir(), ".openclaw", "fleet", "state"));
  });
});