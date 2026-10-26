import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { loadAgent } from "../src/config/agent.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";
import { cli, FIXTURE_PLAN, REPO_ROOT, removeTmpDirs } from "./helpers.ts";

afterEach(removeTmpDirs);

/** The Stages of the default Pipeline after `review`. */
const TAIL = ["verify", "evidence", "task_approval", "research"];

test("tracer: import → go → run --until-idle on the default Pipeline, with a scripted review failure", async () => {
  const ntfy = new FakeNtfy();
  const server = await ntfy.start();
  try {
    const runner = new FakeRunner({
      "implementer-tdd": [{ verdict: "PASS", usage: { input_tokens: 5, output_tokens: 6 } }],
      "reviewer-standards": [
        { verdict: "FAIL", usage: { input_tokens: 11, output_tokens: 22 } },
        { verdict: "PASS", usage: { input_tokens: 33, output_tokens: 44 } },
      ],
    });
    const { root, home, run } = cli({
      env: { FOREMAN_NTFY_SERVER: server, FOREMAN_NTFY_TOPIC: "foreman" },
      runner,
    });

    assert.equal(await run("import", root, FIXTURE_PLAN), 0);
    assert.equal(await run("go", "R-1"), 0);
    assert.equal(await run("run", "--until-idle"), 0);

    const store = Store.open(home);
    try {
      const tasks = store.listTasks();
      assert.equal(tasks.length, 4);
      assert.ok(tasks.every((t) => t.status === "done"));
      assert.equal(
        tasks.reduce((n, t) => n + t.round_total, 0),
        1,
      );
      const milestones = store.listMilestones("R-1");
      assert.equal(milestones.length, 2);
      assert.ok(milestones.every((m) => m.status === "done"));
      assert.equal(store.getRequest("R-1")?.phase, "done");

      // The events table tells the whole story, in order. Each Stage run is one lease.
      const tickOf = (task: string, stage: string, ...extra: [string, string][]) => [
        ["lease.taken", task],
        ...(stage === "workup" ? [["task.started", task]] : []),
        ["stage.completed", task],
        ...extra,
        ["lease.released", task],
      ];
      const after = (task: string, ...stages: string[]) => stages.flatMap((st) => tickOf(task, st));
      // The Stages of defaults/pipeline.toml, in order. `review` is the one with two Agents.
      const plain = (task: string) =>
        after(task, "workup", "red", "implement", "gates", "review", ...TAIL);
      assert.deepEqual(
        store.listEvents().map((e) => [e.type, e.subject]),
        [
          ["request.imported", "R-1"],
          ["request.go", "R-1"],
          // T-1's first review fails: a Round, caused by the review Stage.
          ...after("T-1", "workup", "red", "implement", "gates"),
          ...tickOf("T-1", "review", ["round.started", "T-1"]),
          ...after("T-1", "implement", "gates", "review", ...TAIL),
          ...plain("T-2").slice(0, -1),
          ["milestone.done", "M-1"],
          ["lease.released", "T-2"],
          ...plain("T-3"),
          ...plain("T-4").slice(0, -1),
          ["milestone.done", "M-2"],
          ["request.done", "R-1"],
          ["lease.released", "T-4"],
        ],
      );
      const round = store.listEvents().filter((e) => e.type === "round.started");
      assert.deepEqual(JSON.parse(round[0]?.payload ?? "null"), {
        stage: "review",
        round_stage: 1,
        round_total: 1,
      });

      // One Run per Agent: 4 Tasks x 6 (workup, implement, two reviewers, verify, research), plus the
      // Round's implement and two reviewers. Gates and the owner stage run no Agent.
      const runs = store.listRuns();
      assert.equal(runs.length, 27);
      assert.ok(runs.every((r) => r.ended_at && r.report_path && r.error === null));
      assert.ok(runs.every((r) => r.request_id === "R-1" && r.exit_code === 0));
      const failed = runs.filter((r) => r.verdict === "FAIL");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.stage, "review");
      assert.deepEqual([failed[0]?.tokens_in, failed[0]?.tokens_out], [11, 22]);
      const usage = (stage: string) =>
        runs.filter((r) => r.stage === stage).map((r) => [r.tokens_in, r.tokens_out]);
      // Reports live in the Target repo, one per Run, and nowhere under FOREMAN_HOME.
      const runsDir = join(root, ".foreman/R-1/runs");
      assert.deepEqual(
        readdirSync(runsDir).sort(),
        runs.map((r) => `${r.id}-${r.stage}.md`).sort(),
      );
      assert.ok(runs.every((r) => r.report_path === join(runsDir, `${r.id}-${r.stage}.md`)));
      assert.equal(existsSync(join(home, "reports")), false);
      assert.deepEqual(usage("implement")[0], [5, 6]);
      assert.deepEqual(
        runs
          .filter((r) => r.agent === "reviewer-standards")
          .slice(0, 2)
          .map((r) => [r.tokens_in, r.tokens_out]),
        [
          [11, 22],
          [33, 44],
        ],
      );
      assert.deepEqual(
        runs.filter((r) => r.stage === "review").map((r) => r.agent),
        Array.from({ length: 5 }, () => ["reviewer-standards", "reviewer-spec"]).flat(),
      );
    } finally {
      store.close();
    }

    assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /Phase: done/);
    // Every Run is built from its Agent's AGENT.md, and a Round's rework reads the failed report.
    assert.equal(runner.calls.length, 27);
    for (const spec of runner.calls) {
      const { body } = loadAgent(join(REPO_ROOT, "agents", spec.agent, "AGENT.md"));
      assert.ok(spec.systemPrompt.startsWith(body.trim().split("\n")[0] ?? ""), spec.agent);
      assert.doesNotMatch(spec.systemPrompt, /\{\{/);
      assert.deepEqual(spec.verdictSchema.properties.verdict.enum.includes("PASS"), true);
    }
    const ofT1 = runner.calls.filter((c) => c.task === "T-1");
    const implements_ = ofT1.filter((c) => c.stage === "implement");
    assert.equal(implements_.length, 2);
    assert.doesNotMatch(implements_[0]?.userPrompt ?? "", /Blocking findings/);
    const rework = implements_[1]?.userPrompt ?? "";
    assert.match(rework, /## Blocking findings from the last Round/);
    assert.match(rework, /\(reviewer-standards\) # review report\n\n {2}verdict: FAIL/);
    assert.doesNotMatch(rework, /reviewer-spec\)/);
    assert.match(
      rework,
      /## Earlier reports for this Task[\s\S]*review \(reviewer-standards, FAIL\)/,
    );
    // The Stage after the rework sees those reports as history, not as findings to fix.
    const secondReview = ofT1.filter((c) => c.stage === "review").slice(2);
    assert.equal(secondReview.length, 2);
    assert.ok(secondReview.every((c) => !c.userPrompt.includes("Blocking findings")));

    const titles = ntfy.calls.map((c) => c.title);
    assert.ok(titles.includes("Request done: R-1"));
    assert.equal(titles.filter((t) => t?.startsWith("Task done")).length, 4);
  } finally {
    await ntfy.stop();
  }
});

/** A Target repo's `.foreman/config.toml`, written before the Request is imported. */
function targetConfig(root: string, toml: string): void {
  mkdirSync(join(root, ".foreman"), { recursive: true });
  writeFileSync(join(root, ".foreman", "config.toml"), toml);
}

/** Stub Agents in the Target repo's `.foreman/agents/`, for the names its config or overrides use. */
function targetAgents(root: string, ...names: string[]): void {
  for (const name of names) {
    const dir = join(root, ".foreman", "agents", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "AGENT.md"),
      "---\nmodel: sonnet\noutput:\n  verdicts: [PASS, FAIL]\n---\nStub role prompt.\n",
    );
  }
}

test("Kinds route to different Agents, and an override recorded at Go wins", async () => {
  const { root, home, run } = cli();
  // The fixture plan's Tasks: T-1 core, T-2 cli, T-3 core, T-4 core.
  targetConfig(
    root,
    `[kinds.core]
implement = ["implementer-core"]

[kinds.cli]
implement = ["implementer-cli"]
review = ["reviewer-standards", "reviewer-cli"]
`,
  );
  targetAgents(root, "implementer-core", "implementer-cli", "reviewer-cli", "reviewer-override");
  assert.equal(await run("import", root, FIXTURE_PLAN), 0);
  assert.equal(await run("go", "R-1"), 0);
  // What Go records for a Task the Owner gave its own Agents (M7-T06 adds the flag).
  const seed = Store.open(home);
  try {
    seed.updateTask("T-4", { agent_overrides: JSON.stringify({ review: ["reviewer-override"] }) });
  } finally {
    seed.close();
  }
  assert.equal(await run("run", "--until-idle"), 0);

  const store = Store.open(home);
  try {
    // Each Task's Agents, per Stage, in the order its Runs started. A rework Round would repeat them.
    const agentsOf = (task: string) => {
      const byStage = new Map<string, string[]>();
      for (const r of store.listRuns().filter((x) => x.task_id === task)) {
        if (r.stage === null || r.agent === null) continue;
        byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), r.agent]);
      }
      return Object.fromEntries(byStage);
    };
    const defaults = { review: ["reviewer-standards", "reviewer-spec"], verify: ["verifier-api"] };
    assert.deepEqual(agentsOf("T-1"), {
      workup: ["workup-tdd"],
      implement: ["implementer-core"],
      ...defaults,
      research: ["researcher-task"],
    });
    assert.deepEqual(agentsOf("T-2"), {
      workup: ["workup-tdd"],
      implement: ["implementer-cli"],
      review: ["reviewer-standards", "reviewer-cli"],
      verify: ["verifier-api"],
      research: ["researcher-task"],
    });
    assert.deepEqual(agentsOf("T-4"), {
      workup: ["workup-tdd"],
      implement: ["implementer-core"],
      review: ["reviewer-override"],
      verify: ["verifier-api"],
      research: ["researcher-task"],
    });
    assert.ok(store.listTasks().every((t) => t.status === "done"));
  } finally {
    store.close();
  }
});

for (const [name, toml, message] of [
  [
    "a stage routing to an unknown stage",
    `[[stages]]
name = "implement"
type = "agent"
on_fail = "nowhere"

[kinds.default]
implement = ["implementer-tdd"]
`,
    /nowhere/,
  ],
  [
    "a typo in the default Kind's agents",
    `[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[kinds.default]
implement = ["implemnter-tdd"]
`,
    /kinds\.default\.implement: unknown agent "implemnter-tdd" \(known: .*implementer-tdd/,
  ],
  [
    "an unknown agent in a Kind",
    '[kinds.core]\nimplement = ["implemnter-core"]\n',
    /kinds\.core\.implement: unknown agent "implemnter-core"/,
  ],
  ["TOML that does not parse", "[[stages]\n", /\.foreman\/config\.toml: not valid TOML/],
  ["an unknown top-level key", 'pipeline = "x"\n', /unknown key "pipeline"/],
] as const) {
  test(`run refuses to start on ${name}, and names the error`, async () => {
    const { root, home, run, err, runner } = cli();
    targetConfig(root, toml);
    assert.equal(await run("import", root, FIXTURE_PLAN), 0);
    assert.equal(await run("go", "R-1"), 0);
    assert.equal(await run("run", "--until-idle"), 1);
    assert.match(err.join("\n"), message);
    assert.equal(runner.calls.length, 0);
    const store = Store.open(home);
    try {
      assert.equal(store.listRuns().length, 0);
      assert.ok(store.listTasks().every((t) => t.status === "queued"));
    } finally {
      store.close();
    }
  });
}

test("run refuses to start on a per-Task override naming an unknown Agent", async () => {
  const { root, home, run, err, runner } = cli();
  assert.equal(await run("import", root, FIXTURE_PLAN), 0);
  assert.equal(await run("go", "R-1"), 0);
  const seed = Store.open(home);
  try {
    seed.updateTask("T-2", { agent_overrides: JSON.stringify({ review: ["reviewer-nobody"] }) });
  } finally {
    seed.close();
  }
  assert.equal(await run("run", "--until-idle"), 1);
  assert.match(
    err.join("\n"),
    /task T-2: stage "review": unknown agent "reviewer-nobody" \(known: .*reviewer-spec/,
  );
  assert.equal(runner.calls.length, 0);
});

test("run refuses to start on a malformed per-Task agent_overrides, naming the Task", async () => {
  const { root, home, run, err, runner } = cli();
  assert.equal(await run("import", root, FIXTURE_PLAN), 0);
  assert.equal(await run("go", "R-1"), 0);
  const seed = Store.open(home);
  try {
    seed.updateTask("T-2", { agent_overrides: '{"review": "reviewer-spec"}' });
  } finally {
    seed.close();
  }
  assert.equal(await run("run", "--until-idle"), 1);
  assert.match(err.join("\n"), /T-2: agent_overrides is not a/);
  assert.equal(runner.calls.length, 0);
  assert.equal(await run("config", "show", "R-1"), 1);
  assert.match(err.at(-1) ?? "", /T-2: agent_overrides is not a/);
});

test("a broken config does not stop `run` on a Request that is not building", async () => {
  const { root, run } = cli();
  targetConfig(root, "[[stages]\n");
  assert.equal(await run("import", root, FIXTURE_PLAN), 0);
  assert.equal(await run("run", "--until-idle"), 0);
});
