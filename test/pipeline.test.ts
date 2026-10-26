import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PIPELINE_PATH,
  loadPipeline,
  PipelineError,
  parsePipeline,
} from "../src/config/pipeline.ts";

/** Every Agent the default Pipeline names. The Agent files arrive in M5-T10 and M10-T07. */
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

const AGENTS = new Set(["writer", "coder", "critic-a", "critic-b"]);

const VALID = `
[[stages]]
name = "workup"
type = "agent"
agents = ["writer"]
on_fail = "workup"

[[stages]]
name = "implement"
type = "agent"
agents = ["coder"]
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
agents = ["critic-a", "critic-b"]
require = "all"
on_fail = "implement"
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
    assert.deepEqual(p.kinds, {});
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
    assert.deepEqual(p.kinds, { ui: { review: ["critic-b"] } });
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
    assert.match(issue ?? "", /stage "workup"/);
    assert.match(issue ?? "", /unknown agent "wirter"/);
    assert.match(issue ?? "", /coder, critic-a, critic-b, writer/);
  });

  it("rejects a pass path that loops with no way out", () => {
    const issues = issuesOf(
      VALID.replace(
        'agents = ["critic-a", "critic-b"]',
        'agents = ["critic-a", "critic-b"]\non_pass = "workup"',
      ),
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

  it("requires agents on agent stages and gates on gate stages, and forbids the wrong ones", () => {
    const noAgents = issuesOf(VALID.replace('agents = ["writer"]\n', "")).join("\n");
    assert.match(noAgents, /stage "workup".*agents/);
    const gateNoGates = issuesOf(
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(gateNoGates, /stage "g".*gates/);
    const gateWithAgents = issuesOf(
      `${VALID}\n[[stages]]\nname = "g"\ntype = "gate"\ngates = ["x"]\nagents = ["coder"]\non_fail = "implement"\n`,
    ).join("\n");
    assert.match(gateWithAgents, /stage "g".*agents.*only for agent stages/);
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
  const pipeline = loadPipeline(DEFAULT_PIPELINE_PATH, { agents: DEFAULT_AGENTS });

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
    for (const s of pipeline.stages) for (const a of s.agents ?? []) named.add(a);
    for (const stages of Object.values(pipeline.kinds))
      for (const agents of Object.values(stages)) for (const a of agents) named.add(a);
    assert.deepEqual([...named].sort(), [...DEFAULT_AGENTS].sort());
  });

  it("has several reviewers that must all pass, and the ADR 0006 Breaker limits", () => {
    const review = pipeline.stages.find((s) => s.name === "review");
    assert.deepEqual(review?.agents, ["reviewer-standards", "reviewer-spec"]);
    assert.equal(review?.require, "all");
    assert.deepEqual(pipeline.breaker, { per_stage: 3, per_task: 6 });
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
