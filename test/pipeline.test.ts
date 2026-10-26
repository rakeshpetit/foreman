import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_PIPELINE_PATH,
  loadPipeline,
  PipelineError,
  parsePipeline,
  type StageConfig,
} from "../src/config/pipeline.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

/** Every Agent the default Pipeline names. foreman's `agents/` holds a stub for each. */
const DEFAULT_AGENTS = new Set([
  "workup-tdd",
  "implementer-tdd",
  "implementer-ui",
  "implementer-docs",
  "reviewer-standards",
  "reviewer-spec",
  "reviewer-security",
  "verifier-web-playwright",
  "verifier-api",
  "researcher-task",
]);

afterEach(removeTmpDirs);

const AGENTS = new Set(["writer", "coder", "critic-a", "critic-b"]);

const VALID = `
[[stages]]
name = "workup"
type = "agent"
on_fail = "workup"

[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
require = "all"
on_fail = "implement"

[kinds.default]
workup = ["writer"]
implement = ["coder"]
review = ["critic-a", "critic-b"]
`;

function issuesOfOpts(text: string, opts: Parameters<typeof parsePipeline>[1]): string[] {
  try {
    parsePipeline(text, opts);
  } catch (e) {
    assert.ok(e instanceof PipelineError, `expected a PipelineError, got ${String(e)}`);
    return e.issues;
  }
  assert.fail("expected the Pipeline to be rejected");
}

function issuesOf(text: string, agents = AGENTS): string[] {
  try {
    parsePipeline(text, { agents });
  } catch (e) {
    assert.ok(e instanceof PipelineError, `expected a PipelineError, got ${String(e)}`);
    return e.issues;
  }
  assert.fail("expected the Pipeline to be rejected");
}

describe("parsePipeline", () => {
  it("accepts a minimal Pipeline and fills in defaults", () => {
    const p = parsePipeline(VALID, { agents: AGENTS });
    assert.deepEqual(
      p.stages.map((s) => [s.name, s.on_pass, s.on_fail, s.require]),
      [
        ["workup", "implement", "workup", "all"],
        ["implement", "review", "implement", "all"],
        ["review", "done", "implement", "all"],
      ],
    );
    assert.deepEqual(p.breaker, { per_stage: 3, per_task: 6 });
    assert.deepEqual(p.kinds, {
      default: { workup: ["writer"], implement: ["coder"], review: ["critic-a", "critic-b"] },
    });
    assert.equal(p.notify.usage, "task");
  });

  it("reads gate and owner stages, kinds, breaker, notify and lanes", () => {
    const p = parsePipeline(
      `${VALID}
[[stages]]
name = "gates"
type = "gate"
gates = ["check_passes", "diff_size"]
on_fail = "implement"
lanes = ["normal", "fast"]

[[stages]]
name = "approve"
type = "owner"
on_pass = "done"
on_fail = "implement"
max_rounds = 2

[kinds.ui]
review = ["critic-b"]

[breaker]
per_stage = 2
per_task = 5

[notify]
usage = "off"
events = ["request_done"]

[lanes.normal]
[lanes.fast]
under_lines = 30
`,
      { agents: AGENTS },
    );
    const gates = p.stages.find((s) => s.name === "gates");
    assert.deepEqual(gates?.gates, ["check_passes", "diff_size"]);
    assert.deepEqual(gates?.lanes, ["normal", "fast"]);
    assert.equal(p.stages.find((s) => s.name === "approve")?.max_rounds, 2);
    assert.deepEqual(p.kinds.ui, { review: ["critic-b"] });
    assert.deepEqual(Object.keys(p.kinds), ["default", "ui"]);
    assert.deepEqual(p.breaker, { per_stage: 2, per_task: 5 });
    assert.deepEqual(p.notify, { usage: "off", events: ["request_done"] });
    assert.deepEqual(p.lanes, { normal: {}, fast: { under_lines: 30 } });
  });

  it("names the stage and the bad target when routing points at an unknown stage", () => {
    const [issue, ...rest] = issuesOf(
      VALID.replace('on_fail = "implement"\n', 'on_fail = "implment"\n'),
    );
    assert.deepEqual(rest, []);
    assert.match(issue ?? "", /stage "implement"/);
    assert.match(issue ?? "", /on_fail/);
    assert.match(issue ?? "", /"implment" is not a stage/);
    assert.match(issue ?? "", /workup, implement, review, done/);
  });

  it("rejects an unknown Gate when the known Gates are given, and skips Agent and Gate checks when not", () => {
    const text = `${VALID}
[[stages]]
name = "gates"
type = "gate"
gates = ["check_passes", "chek_passes"]
on_fail = "implement"
`;
    assert.deepEqual(issuesOfOpts(text, { gates: new Set(["check_passes", "diff_size"]) }), [
      'stage "gates": unknown gate "chek_passes" (known: check_passes, diff_size)',
    ]);
    assert.ok(parsePipeline(text));
  });

  it("rejects an unknown Agent and lists the known ones", () => {
    const [issue] = issuesOf(VALID.replace('"writer"', '"wirter"'));
    assert.match(issue ?? "", /kinds\.default\.workup/);
    assert.match(issue ?? "", /unknown agent "wirter"/);
    assert.match(issue ?? "", /coder, critic-a, critic-b, writer/);
  });

  it("rejects a pass path that loops with no way out", () => {
    const issues = issuesOf(
      VALID.replace('require = "all"', 'require = "all"\non_pass = "workup"'),
    );
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /cycle/);
    assert.match(issues[0] ?? "", /workup -> implement -> review -> workup/);
    assert.match(issues[0] ?? "", /never reaches done/);
  });

  it("allows a fail path that loops back, because the Breaker bounds it", () => {
    parsePipeline(VALID, { agents: AGENTS });
  });

  it("requires on_fail, naming the stage", () => {
    const [issue] = issuesOf(VALID.replace('on_fail = "workup"\n', ""));
    assert.match(issue ?? "", /stage "workup"/);
    assert.match(issue ?? "", /on_fail is required/);
  });

  it("rejects on_fail = done and a stage named done", () => {
    assert.match(
      issuesOf(VALID.replace('on_fail = "workup"', 'on_fail = "done"')).join("\n"),
      /on_fail cannot be "done"/,
    );
    assert.match(
      issuesOf(VALID.replace('name = "workup"', 'name = "done"')).join("\n"),
      /"done" is reserved/,
    );
  });

  it("rejects duplicate stage names", () => {
    assert.match(
      issuesOf(VALID.replace('name = "review"', 'name = "implement"')).join("\n"),
      /duplicate stage name "implement"/,
    );
  });

  it("requires a default Kind entry for every agent stage, gates on gate stages, and forbids the wrong ones", () => {
    const noAgents = issuesOf(VALID.replace('workup = ["writer"]\n', "")).join("\n");
    assert.match(noAgents, /stage "workup": .*\[kinds\.default\].*workup = \["name"\]/);
    const gateNoGates = issuesOf(
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(gateNoGates, /stage "g".*gates/);
    const stageWithAgents = issuesOf(
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\ngates = ["x"]\nagents = ["coder"]\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(stageWithAgents, /stages\[3\]\.agents: .*\[kinds\.default\]/);
    const ownerWithGates = issuesOf(
      `${VALID}\n[[stages]]\nname = "o"\ntype = "owner"\ngates = ["x"]\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(ownerWithGates, /stage "o".*gates.*only for gate stages/);
    const requireOnGate = issuesOf(
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\ngates = ["x"]\nrequire = "any"\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(requireOnGate, /stage "g".*require.*only for agent stages/);
  });

  it("rejects kinds that name an unknown stage, a non-agent stage or an unknown Agent", () => {
    const withKinds = (body: string) =>
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\ngates = ["x"]\non_fail = "implement"\n\n${body}`;
    assert.match(
      issuesOf(withKinds('[kinds.ui]\nreveiw = ["critic-a"]')).join("\n"),
      /kinds\.ui: "reveiw" is not a stage/,
    );
    assert.match(
      issuesOf(withKinds('[kinds.ui]\ng = ["critic-a"]')).join("\n"),
      /kinds\.ui\.g: "g" is a gate stage, so it has no agents/,
    );
    assert.match(
      issuesOf(withKinds('[kinds.ui]\nreview = ["nobody"]')).join("\n"),
      /kinds\.ui\.review: unknown agent "nobody"/,
    );
  });

  it("rejects a stage lane that is not declared", () => {
    assert.match(
      issuesOf(
        `${VALID.replace('require = "all"', 'require = "all"\nlanes = ["fast"]')}\n[lanes.normal]\n`,
      ).join("\n"),
      /stage "review": lane "fast" is not declared in \[lanes\]/,
    );
  });

  it("rejects a lane foreman does not have, in the types and in a stage's lanes", () => {
    const stage: StageConfig = {
      name: "a",
      type: "agent",
      require: "all",
      on_pass: "done",
      on_fail: "a",
      // @ts-expect-error "slow" is not a Lane
      lanes: ["slow"],
    };
    assert.deepEqual(stage.lanes, ["slow"]);
    assert.match(
      issuesOf(VALID.replace('require = "all"', 'require = "all"\nlanes = ["slow"]')).join("\n"),
      /lanes/,
    );
  });

  it("rejects an on_fail target that does not run in every lane its stage runs in", () => {
    const stage = (name: string, onFail: string, lanes?: string) =>
      `[[stages]]\nname = "${name}"\ntype = "agent"\non_fail = "${onFail}"\n${lanes ? `lanes = ${lanes}\n` : ""}`;
    const lanes =
      '\n[lanes.normal]\n[lanes.fast]\n[kinds.default]\nimplement = ["coder"]\nreview = ["coder"]\n';
    // An all-lanes review fails to a normal-only implement: a fast Task would land on a skipped Stage.
    const bad = `${stage("implement", "implement", '["normal"]')}\n${stage("review", "implement")}${lanes}`;
    assert.match(
      issuesOf(bad).join("\n"),
      /stage "review": on_fail "implement" does not run in the fast lane, which "review" runs in/,
    );
    // Fine when the failing Stage runs only in lanes its target runs in, or the target runs in all.
    const narrow = `${stage("implement", "implement", '["normal"]')}\n${stage("review", "implement", '["normal"]')}${lanes}`;
    assert.doesNotThrow(() => parsePipeline(narrow));
    const wide = `${stage("implement", "implement")}\n${stage("review", "implement", '["fast"]')}${lanes}`;
    assert.doesNotThrow(() => parsePipeline(wide));
  });

  it("rejects unknown keys, so a typo is not silently ignored", () => {
    assert.match(
      issuesOf(VALID.replace('require = "all"', 'requires = "all"')).join("\n"),
      /stages\[2\].*requires/,
    );
    assert.match(
      issuesOf(`${VALID}\n[breaker]\nper_stage = 3\nper_taks = 6\n`).join("\n"),
      /per_taks/,
    );
  });

  it("rejects bad values with the path to them", () => {
    assert.match(
      issuesOf(VALID.replace('require = "all"', 'require = "most"')).join("\n"),
      /stages\[2\]\.require/,
    );
    assert.match(issuesOf(`${VALID}\n[breaker]\nper_stage = 0\n`).join("\n"), /breaker\.per_stage/);
    assert.match(issuesOf(`${VALID}\n[notify]\nusage = "daily"\n`).join("\n"), /notify\.usage/);
  });

  it("reports every problem at once", () => {
    const issues = issuesOf(
      VALID.replace('"writer"', '"wirter"').replace('on_fail = "workup"', 'on_fail = "nope"'),
    );
    assert.equal(issues.length, 2);
  });

  it("rejects a Pipeline with no stages", () => {
    assert.match(issuesOf("[breaker]\nper_stage = 3\n").join("\n"), /stages/);
  });

  it("reports TOML syntax errors", () => {
    assert.match(issuesOf("[[stages\nname = 1").join("\n"), /not valid TOML/);
  });

  it("prefixes every line of the message with the source", () => {
    try {
      parsePipeline("[breaker]\nper_stage = 0\n", { agents: AGENTS, source: "/x/pipeline.toml" });
      assert.fail("expected the Pipeline to be rejected");
    } catch (e) {
      assert.ok(e instanceof PipelineError);
      for (const line of e.message.split("\n")) assert.match(line, /^\/x\/pipeline\.toml/);
    }
  });
});

describe("defaults/pipeline.toml", () => {
  // No `agents` given: `loadPipeline` checks the names against foreman's own `agents/`.
  const pipeline = loadPipeline(DEFAULT_PIPELINE_PATH);

  it("validates", () => {
    assert.ok(pipeline.stages.length > 0);
  });

  it("runs workup, implement, gates, review, verify, evidence and Owner approval, then research", () => {
    assert.deepEqual(
      pipeline.stages.map((s) => [s.name, s.type]),
      [
        ["workup", "agent"],
        ["red", "gate"],
        ["implement", "agent"],
        ["gates", "gate"],
        ["review", "agent"],
        ["verify", "agent"],
        ["evidence", "gate"],
        ["task_approval", "owner"],
        ["research", "agent"],
      ],
    );
  });

  it("uses every Agent it names, and uses only those", () => {
    const named = new Set<string>();
    for (const stages of Object.values(pipeline.kinds))
      for (const agents of Object.values(stages)) for (const a of agents) named.add(a);
    assert.deepEqual([...named].sort(), [...DEFAULT_AGENTS].sort());
  });

  it("has several reviewers that must all pass, and the ADR 0006 Breaker limits", () => {
    const review = pipeline.stages.find((s) => s.name === "review");
    assert.deepEqual(pipeline.kinds.default?.review, ["reviewer-standards", "reviewer-spec"]);
    assert.equal(review?.require, "all");
    assert.deepEqual(pipeline.breaker, { per_stage: 3, per_task: 6 });
  });

  it("names the Agents of every agent stage under [kinds.default]", () => {
    const agentStages = pipeline.stages.filter((s) => s.type === "agent").map((s) => s.name);
    assert.deepEqual(Object.keys(pipeline.kinds.default ?? {}).sort(), agentStages.sort());
  });

  it("sends a failed Workup back to Workup (ADR 0010) and a failed review back to Implement", () => {
    const by = Object.fromEntries(pipeline.stages.map((s) => [s.name, s]));
    assert.equal(by.workup?.on_fail, "workup");
    assert.equal(by.review?.on_fail, "implement");
  });

  it("declares the fast lane, which skips Workup", () => {
    assert.deepEqual(pipeline.lanes.fast, { under_lines: 30 });
    const by = Object.fromEntries(pipeline.stages.map((s) => [s.name, s]));
    assert.deepEqual(by.workup?.lanes, ["normal"]);
    assert.deepEqual(by.red?.lanes, ["normal"]);
  });
});

describe("loadPipeline", () => {
  it("checks the Agent names against foreman's own agents/", () => {
    const path = join(tmpDir("foreman-pipeline-"), "pipeline.toml");
    writeFileSync(
      path,
      '[[stages]]\nname = "implement"\ntype = "agent"\non_fail = "implement"\n[kinds.default]\nimplement = ["implementer-tdd", "implemnter"]\n',
    );
    assert.throws(
      () => loadPipeline(path),
      (e) =>
        e instanceof PipelineError &&
        /kinds\.default\.implement: unknown agent "implemnter" \(known: .*implementer-tdd/.test(
          e.message,
        ),
    );
  });
});
