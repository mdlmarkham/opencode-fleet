/**
 * Issue #111 smoke pins: the dev3 opencode capture fixture parses, and the engine
 * skills/agents/rules survey doc exists and names each engine row. Network-free;
 * the doc and fixture are the deliverables of the live survey, this file only
 * guards them against drift (a rewrite that drops an engine, or a mangled fixture).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpencodeCapture } from "./opencode-verify.js";
import { verifyOpencodeCapture } from "./opencode-verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs", "engines-skills.md");
const FIXTURE = join(ROOT, "src", "testkit", "oc-capture-dev3.json");

describe("issue #111: dev3 skills/agents/rules survey", () => {
  it("the capture fixture exists and parses as JSON", () => {
    expect(existsSync(FIXTURE), `${FIXTURE} missing`).toBe(true);
    const raw = readFileSync(FIXTURE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toBeTypeOf("object");
    const capture = parsed as OpencodeCapture;
    expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const probe of ["version", "help", "runHelp", "acpHelp", "agentList", "debugPaths", "debugSkill"]) {
      expect(capture.probes[probe], `probe ${probe} missing`).toBeDefined();
    }
    expect(capture.modelRun).toBeDefined();
  });

  it("the fixture is a dev3 capture that passes the opencode verifier's required checks", () => {
    const capture = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpencodeCapture;
    const report = verifyOpencodeCapture(capture);
    expect(report.opencodeVersion).toBe("1.18.25");
    expect(report.summary.missing).toBe(0);
    expect(report.summary.unverifiable).toBe(0);
    expect(report.ok).toBe(true);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    for (const id of ["agents.project-local", "skills.project-local", "paths.global"]) {
      expect(byId[id], `check ${id}`).toBe("confirmed");
    }
  });

  it("the survey doc exists and names each engine row (skills, agents, rules per engine)", () => {
    expect(existsSync(DOC), `${DOC} missing`).toBe(true);
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain("opencode 1.18.25");
    expect(doc).toContain("pi 0.73.1");
    for (const cell of ["SKILL.md", "AGENTS.md", ".opencode/agent", ".pi/agent/skills", "~/.config/opencode"]) {
      expect(doc, `doc must name ${cell}`).toContain(cell);
    }
    expect(doc).toContain("dev3");
    expect(doc).toContain("precedence");
    expect(doc).toContain("not supported");
  });
});