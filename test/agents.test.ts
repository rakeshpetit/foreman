import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentsFor } from "../src/config/agents.ts";
import { parsePipeline } from "../src/config/pipeline.ts";

const PIPELINE = parsePipeline(`
[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
on_fail = "implement"

[[stages]]
name = "gates"
type = "gate"
gates = ["check_passes"]
on_fail = "implement"

[kinds.ui]
review = ["reviewer-standards", "reviewer-ui"]

[kinds.api]
review = ["reviewer-standards", "reviewer-security"]

[kinds.default]
implement = ["generalist"]
review = ["reviewer-standards"]
`);

const task = (kind: string) => ({ id: "T-1", kind });
const config = (taskAgents: Record<string, Record<string, string[]>> = {}) => ({
  pipeline: PIPELINE,
  taskAgents,
});
const stage = (name: string) => {
  const s = PIPELINE.stages.find((x) => x.name === name);
  assert.ok(s);
  return s;
};

describe("agentsFor", () => {
  it("gives a ui Task and an api Task different reviewers", () => {
    assert.deepEqual(agentsFor(config(), task("ui"), stage("review")), [
      "reviewer-standards",
      "reviewer-ui",
    ]);
    assert.deepEqual(agentsFor(config(), task("api"), stage("review")), [
      "reviewer-standards",
      "reviewer-security",
    ]);
  });

  it("lets an override recorded at Go win over the Kind", () => {
    const c = config({ "T-1": { review: ["reviewer-spec"] } });
    assert.deepEqual(agentsFor(c, task("ui"), stage("review")), ["reviewer-spec"]);
  });

  it("only overrides the Stages the override names, and only for the Task it names", () => {
    const c = config({ "T-1": { implement: ["special"] }, "T-2": { review: ["reviewer-spec"] } });
    assert.deepEqual(agentsFor(c, task("ui"), stage("review")), [
      "reviewer-standards",
      "reviewer-ui",
    ]);
  });

  it("falls back to the default Kind for a Kind with no entry for the Stage", () => {
    assert.deepEqual(agentsFor(config(), task("ui"), stage("implement")), ["generalist"]);
    assert.deepEqual(agentsFor(config(), task("unheard-of"), stage("implement")), ["generalist"]);
    assert.deepEqual(agentsFor(config(), task("unheard-of"), stage("review")), [
      "reviewer-standards",
    ]);
  });

  it("returns no Agents for a Stage that has none to choose", () => {
    assert.deepEqual(agentsFor(config(), task("ui"), stage("gates")), []);
  });
});
