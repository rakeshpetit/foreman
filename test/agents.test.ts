import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentsFor } from "../src/config/agents.ts";
import { ConfigError } from "../src/config/layers.ts";
import { parsePipeline } from "../src/config/pipeline.ts";

const PIPELINE = parsePipeline(`
[[stages]]
name = "implement"
type = "agent"
agents = ["coder"]
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
agents = ["reviewer-standards"]
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
`);

const task = (kind: string, agent_overrides: string | null = null) => ({
  id: "T-1",
  kind,
  agent_overrides,
});
const stage = (name: string) => {
  const s = PIPELINE.stages.find((x) => x.name === name);
  assert.ok(s);
  return s;
};

describe("agentsFor", () => {
  it("gives a ui Task and an api Task different reviewers", () => {
    assert.deepEqual(agentsFor(PIPELINE, task("ui"), stage("review")), [
      "reviewer-standards",
      "reviewer-ui",
    ]);
    assert.deepEqual(agentsFor(PIPELINE, task("api"), stage("review")), [
      "reviewer-standards",
      "reviewer-security",
    ]);
  });

  it("lets an override recorded at Go win over the Kind", () => {
    const t = task("ui", JSON.stringify({ review: ["reviewer-spec"] }));
    assert.deepEqual(agentsFor(PIPELINE, t, stage("review")), ["reviewer-spec"]);
  });

  it("only overrides the Stages the override names", () => {
    const t = task("ui", JSON.stringify({ implement: ["special"] }));
    assert.deepEqual(agentsFor(PIPELINE, t, stage("review")), [
      "reviewer-standards",
      "reviewer-ui",
    ]);
  });

  it("falls back to the default Kind for a Kind with no entry for the Stage", () => {
    assert.deepEqual(agentsFor(PIPELINE, task("ui"), stage("implement")), ["generalist"]);
    assert.deepEqual(agentsFor(PIPELINE, task("unheard-of"), stage("implement")), ["generalist"]);
  });

  it("falls back to the Stage's own agents when no Kind names the Stage", () => {
    assert.deepEqual(agentsFor(PIPELINE, task("unheard-of"), stage("review")), [
      "reviewer-standards",
    ]);
  });

  it("returns no Agents for a Stage that has none to choose", () => {
    assert.deepEqual(agentsFor(PIPELINE, task("ui"), stage("gates")), []);
  });

  it("rejects an agent_overrides value that is not a Stage -> Agents object", () => {
    assert.throws(() => agentsFor(PIPELINE, task("ui", "[1]"), stage("review")), ConfigError);
    assert.throws(() => agentsFor(PIPELINE, task("ui", "{oops"), stage("review")), ConfigError);
  });
});
