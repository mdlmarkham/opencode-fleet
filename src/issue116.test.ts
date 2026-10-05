/**
 * Issue #116: `fleet_project_start` INTAKE + charter writer (bounded slice).
 * Pure tests only: no git, no network, no disk. The intake module is a stateful,
 * pure state machine — answers in, questions out, charter text out.
 */
import { describe, expect, it } from "vitest";
import { parseCharter } from "./project.js";
import { buildIntakeState, clearIntakeState, getIntakeState, intakeStep, intakeVerdict, renderCharter, type IntakeAnswers } from "./intake.js";

const full: IntakeAnswers = {
  goal: "Ship a plugin that validates PR descriptions against the charter.",
  users: ["operators", "repo maintainers"],
  constraints: ["no new dependencies", "runs offline"],
  nonGoals: ["no dashboard UI", "no multi-tenant support"],
  successCriteria: ["npm run verify exits 0 on the demo repo", "a human can observe the verdict in the PR comment"],
  riskiestAssumptions: ["operators actually read the charter"],
};

const stateOf = (projectId: string, answers: IntakeAnswers) => buildIntakeState(projectId, answers);

const withDeferred = (state: ReturnType<typeof buildIntakeState>, field: string, note: string) => ({
  ...state,
  deferred: { ...state.deferred, [field]: note },
});

describe("#116: intake push-back (completeness)", () => {
  it("missing non-goals => needs-more, listing nonGoals", () => {
    const { state } = intakeStep({ projectId: "p1" }, { ...full, nonGoals: [] });
    const v = intakeVerdict(state);
    expect(v.verdict).toBe("needs-more");
    expect(v.missing).toEqual(["nonGoals"]);
  });
  it("non-checkable success criterion => needs-more; verbatim wording is flagged insufficient", () => {
    const step = intakeStep({ projectId: "p2" }, { ...full, successCriteria: ["things go faster"] });
    expect(step.verdict).toBe("needs-more");
    expect(step.questions).toContain("successCriteria");
    expect(step.insufficient).toContain("successCriteria");
  });
  it("fully-populated => ready with no missing fields", () => {
    const state = stateOf("p3", full);
    const v = intakeVerdict(state);
    expect(v.verdict).toBe("ready");
    expect(v.missing).toEqual([]);
  });
  it("holds the line: goal missing, zero users, charter only when checkable", () => {
    // goal missing
    const noGoal = stateOf("p4", { ...full, goal: "" });
    expect(intakeVerdict(noGoal)).toMatchObject({ verdict: "needs-more", missing: ["goal"] });
    // zero users
    const noUsers = stateOf("p5", { ...full, users: [] });
    expect(intakeVerdict(noUsers)).toMatchObject({ verdict: "needs-more", missing: ["users"] });
    // goal present but success criteria without a command/observation can never be ready
    const vague = stateOf("p6", { ...full, successCriteria: ["it feels snappy"] });
    const v = intakeVerdict(vague);
    expect(v.verdict).toBe("needs-more");
    expect(v.missing).toEqual(["successCriteria"]);
  });
  it("questions only ask for still-missing/insufficient fields", () => {
    const s = { projectId: "p7" } as const;
    const first = intakeStep(s, { goal: "Set up intake" });
    expect(first.questions).toEqual(["users", "constraints", "nonGoals", "successCriteria", "riskiestAssumptions"]);
    const second = intakeStep(first.state, { users: ["ops"], nonGoals: ["no UI"], successCriteria: ["npm test passes"] });
    expect(second.questions).toEqual(["constraints", "riskiestAssumptions"]);
  });
});

describe("#116: deferred items become risks, never silently accepted", () => {
  it("deferred-only gap => risky-but-proceed with the deferred item surfaced as a risk", () => {
    const state = withDeferred(stateOf("p8", full), "constraints", "operator said: defer the offline check");
    const risky = intakeVerdict(state);
    expect(risky.verdict).toBe("risky-but-proceed");
    expect(risky.missing).toContain("constraints");
    expect(risky.risks.some((r) => r.includes("offline check"))).toBe(true);
  });
  it("a unfulfilled hold is NOT satisfied by deferral: risk is present, never accepted silently", () => {
    const state = withDeferred(stateOf("p9", { ...full, users: [] }), "users", "deferred: who uses it is TBD");
    const risky = intakeVerdict(state);
    expect(risky.verdict).toBe("risky-but-proceed");
    expect(risky.risks.join(" ")).toMatch(/TBD/);
  });
});

describe("#116: charter round-trip (render => parseCharter)", () => {
  it("parseCharter(renderCharter(state)) has zero errors and preserves every field", () => {
    const state = { ...stateOf("p10", full), name: "intake-demo" };
    const text = renderCharter(state);
    const { charter, errors } = parseCharter(text);
    expect(errors).toEqual([]);
    expect(charter).toMatchObject({
      schemaVersion: 1,
      name: "intake-demo",
      goal: full.goal,
      users: full.users,
      constraints: full.constraints,
      nonGoals: full.nonGoals,
      successCriteria: full.successCriteria,
      riskiestAssumptions: full.riskiestAssumptions,
    });
  });
  it("works without a name (name is optional) and without assumptions", () => {
    const state = { ...stateOf("p11", { ...full, riskiestAssumptions: [] }) };
    const { charter, errors } = parseCharter(renderCharter(state));
    expect(errors).toEqual([]);
    expect(charter).toMatchObject({ schemaVersion: 1, goal: full.goal, nonGoals: full.nonGoals });
    expect(charter?.name).toBeUndefined();
  });
});

describe("#116: resumable state keyed by projectId", () => {
  it("answers persist keyed by projectId and clearIntakeState drops them", () => {
    intakeStep({ projectId: "p12" }, { goal: "Persist me" });
    expect(getIntakeState("p12")?.answers.goal).toBe("Persist me");
    clearIntakeState("p12");
    expect(getIntakeState("p12")).toBeUndefined();
  });
  it("a second round merges into the first (resumable)", () => {
    const first = intakeStep({ projectId: "p13" }, { goal: "Resume me" });
    const second = intakeStep({ projectId: "p13" }, { users: ["later"] });
    expect(second.state.answers.goal).toBe("Resume me");
    expect(second.state.answers.users).toEqual(["later"]);
    expect(second.questions).toEqual(["constraints", "nonGoals", "successCriteria", "riskiestAssumptions"]);
    clearIntakeState("p13");
  });
});