import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseAgent } from "../src/config/agent.ts";
import {
  assembleRunSpec,
  type BlockingFinding,
  type PriorReport,
  type RunSpecInput,
  renderTemplate,
} from "../src/runner/prompt.ts";

const GOLDEN = join(import.meta.dirname, "golden", "prompt");

/** Compares `actual` with a golden file; run with `UPDATE_GOLDEN=1` to rewrite it. */
function golden(name: string, actual: string) {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, "utf8"), `${name} differs; UPDATE_GOLDEN=1 to accept`);
}

const BODY = `# Implementer

You implement {{task.id}}: {{task.title}} ({{task.kind}}) for {{request.id}}.

Read the Task at {{paths.task}} and the Spec at {{paths.spec}}. Write your report to {{ paths.report }}.
`;

function agent(frontmatter: string) {
  return parseAgent(`---\n${frontmatter}\n---\n${BODY}`, {
    source: "agents/implementer/AGENT.md",
  });
}

const WITH_SKILLS = agent(`model: sonnet
effort: high
image: foreman-base
tools: [Read, Edit, Bash]
skills:
  preload: [tdd, handoff]
  available: [diagnose]
output:
  verdicts: [PASS, BLOCKED, SCOPE_CHANGE]
timeout: 45m
max_tokens: 400000`);

const NO_SKILLS = agent(`output:
  verdicts: [PASS, FAIL]`);

const SKILLS = {
  preload: [
    { name: "tdd", dir: "/skills/tdd", body: "Write the test first.\n" },
    { name: "handoff", dir: "/skills/handoff", body: "Leave a Handoff when you stop.\n" },
  ],
  available: [{ name: "diagnose", dir: "/skills/diagnose" }],
};

const PATHS = {
  task: "/work/.foreman/R-1/tasks/T-2.md",
  spec: "/work/.foreman/R-1/spec.md",
  plan: "/work/.foreman/R-1/plan.md",
  precedents: "/work/.foreman/precedents.md",
  report: "/work/.foreman/R-1/runs/7-implement.md",
  workdir: "/work",
};

function input(overrides: Partial<RunSpecInput> = {}): RunSpecInput {
  return {
    agent: WITH_SKILLS,
    skills: SKILLS,
    task: {
      id: "T-2",
      title: "Add the parser",
      kind: "api",
      ref: "M1-T02",
      lane: "normal",
      branch: "foreman/R-1/m1/T-2",
    },
    request: { id: "R-1", title: "Parser", mode: "manual", target_repo: "/repo" },
    stage: "implement",
    paths: PATHS,
    ...overrides,
  };
}

const REPORTS: PriorReport[] = [
  {
    stage: "workup",
    agent: "workup-tdd",
    verdict: "PASS",
    path: "/work/.foreman/R-1/runs/5-workup.md",
  },
  {
    stage: "review",
    agent: "reviewer-code",
    verdict: "FAIL",
    path: "/work/.foreman/R-1/runs/6-review.md",
  },
];
const FINDINGS: BlockingFinding[] = [
  { from: { agent: "reviewer-code" }, text: "parse() swallows the error from JSON.parse.\n" },
  { from: "owner", text: "Name the function parseTask, not parse.\nUpdate every caller." },
];

describe("assembleRunSpec", () => {
  it("first Round: Task files only", () => {
    const spec = assembleRunSpec(input());
    golden("first-round.system.md", spec.systemPrompt);
    golden("first-round.user.md", spec.userPrompt);
  });

  it("rework Round: earlier reports and blocking findings", () => {
    const spec = assembleRunSpec(input({ reports: REPORTS, findings: FINDINGS }));
    assert.equal(spec.systemPrompt, assembleRunSpec(input()).systemPrompt);
    golden("rework-round.user.md", spec.userPrompt);
  });

  it("a stage with no Skills has no Skills sections", () => {
    const spec = assembleRunSpec(
      input({ agent: NO_SKILLS, skills: { preload: [], available: [] } }),
    );
    golden("no-skills.system.md", spec.systemPrompt);
    assert.deepEqual(spec.skills, []);
    assert.doesNotMatch(spec.systemPrompt, /Skills/);
  });

  it("builds the Verdict schema from output.verdicts", () => {
    const spec = assembleRunSpec(input());
    assert.deepEqual(spec.verdictSchema, {
      type: "object",
      properties: { verdict: { type: "string", enum: ["PASS", "BLOCKED", "SCOPE_CHANGE"] } },
      required: ["verdict"],
      additionalProperties: false,
    });
  });

  it("carries the Run's identity, paths and the Agent's settings", () => {
    const { systemPrompt, userPrompt, verdictSchema, ...rest } = assembleRunSpec(input());
    assert.deepEqual(rest, {
      task: "T-2",
      stage: "implement",
      agent: "implementer",
      workdir: "/work",
      reportPath: PATHS.report,
      model: "sonnet",
      effort: "high",
      image: "foreman-base",
      tools: ["Read", "Edit", "Bash"],
      timeoutMs: 45 * 60_000,
      maxTokens: 400000,
      skills: [
        { name: "tdd", dir: "/skills/tdd" },
        { name: "handoff", dir: "/skills/handoff" },
        { name: "diagnose", dir: "/skills/diagnose" },
      ],
    });
  });

  it("leaves out settings the Agent does not set", () => {
    const spec = assembleRunSpec(
      input({ agent: NO_SKILLS, skills: { preload: [], available: [] } }),
    );
    for (const key of ["model", "effort", "image", "tools", "timeoutMs", "maxTokens"]) {
      assert.ok(!(key in spec), key);
    }
  });
});

describe("renderTemplate", () => {
  it("fills every known variable, and an unset one is empty", () => {
    const i = input();
    const out = renderTemplate(
      "{{task.ref}}|{{task.file}}|{{task.branch}}|{{task.lane}}|{{request.mode}}|{{request.target_repo}}|{{paths.workdir}}|{{paths.precedents}}",
      { ...i, task: { ...i.task, branch: null } },
    );
    assert.equal(out, `M1-T02|${PATHS.task}||normal|manual|/repo|/work|${PATHS.precedents}`);
  });
});
