import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { agentsFor } from "../src/config/agents.ts";
import { DEFAULT_PIPELINE_PATH, loadPipeline, parsePipeline } from "../src/config/pipeline.ts";
import { agentExecutor } from "../src/engine/agent.ts";
import { gateExecutor, ownerExecutor, STUB_GATES, stageExecutor } from "../src/engine/executors.ts";
import { tick } from "../src/engine/tick.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";
import { buildingRequest, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function stageNamed(name: string) {
  const stage = PIPELINE.stages.find((s) => s.name === name);
  assert.ok(stage);
  return stage;
}

function setup(script: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = tmpDir("foreman-runner-");
  const s = new Store(":memory:");
  const { m } = buildingRequest(s, { title: "r", target_repo: join(dir, "work") });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  const runner = new FakeRunner(script);
  const executor = agentExecutor({ store: s, runner });
  return { dir, s, t, runner, executor };
}

const PIPELINE = parsePipeline(`
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
`);

test("FakeRunner writes scripted files, the report and returns usage", async () => {
  const { dir, runner } = setup({
    implement: [
      {
        verdict: "PASS",
        files: { "src/a.txt": "hi" },
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    ],
  });
  const result = await runner.run({
    task: "T",
    stage: "implement",
    agent: "coder",
    workdir: join(dir, "work"),
    reportPath: join(dir, "reports/T/implement.md"),
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal(await readFile(join(dir, "work/src/a.txt"), "utf8"), "hi");
  assert.match(await readFile(result.reportPath, "utf8"), /verdict: PASS/);
});

test("engine runs a Task through all stub stages with FakeRunner; a scripted fail causes a Round", async () => {
  const { s, t, runner, executor } = setup({ "critic-a": [{ verdict: "FAIL" }] });
  while ((await tick(s, { pipeline: PIPELINE, executor })).kind === "ran");
  assert.deepEqual(
    runner.calls.map((c) => [c.stage, c.agent]),
    [
      ["workup", "writer"],
      ["implement", "coder"],
      ["review", "critic-a"],
      ["review", "critic-b"],
      ["implement", "coder"],
      ["review", "critic-a"],
      ["review", "critic-b"],
    ],
  );
  const done = s.getTask(t.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.round_total, 1);
  for (const c of runner.calls) assert.ok(existsSync(c.reportPath));
});

test("the executor runs each Task in its own Request's repo, not the first building Request's", async () => {
  const dir = tmpDir("foreman-runner-");
  const s = new Store(":memory:");
  buildingRequest(s, { title: "first", target_repo: join(dir, "first") }, "m1");
  const { m: m2 } = buildingRequest(s, { title: "second", target_repo: join(dir, "second") }, "m2");
  const t = s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  const runner = new FakeRunner({});
  const executor = agentExecutor({ store: s, runner });
  assert.equal((await tick(s, { pipeline: PIPELINE, executor })).kind, "ran");
  assert.deepEqual(
    runner.calls.map((c) => [c.task, c.workdir]),
    [[t.id, join(dir, "second")]],
  );
});

test("the executor records each Run with its verdict, usage and report, and the error when the Runner throws", async () => {
  const { dir, s, t, executor } = setup({
    workup: [{ verdict: "PASS", usage: { input_tokens: 3, output_tokens: 4 } }],
  });
  const task = s.getTask(t.id);
  assert.ok(task);
  assert.equal(await executor(task, stageNamed("workup")), "PASS");
  const [run] = s.listRuns(t.id);
  assert.equal(run?.stage, "workup");
  assert.equal(run?.agent, "writer");
  assert.equal(run?.verdict, "PASS");
  assert.deepEqual([run?.tokens_in, run?.tokens_out], [3, 4]);
  assert.ok(run?.ended_at && run.duration_ms !== null);
  assert.equal(run?.report_path, join(dir, "work/.foreman/R-1/runs", `${run?.id}-workup.md`));
  assert.ok(run.report_path && existsSync(run.report_path));

  const boom = agentExecutor({
    store: s,
    runner: {
      async run() {
        throw new Error("agent crashed");
      },
    },
  });
  await assert.rejects(boom(task, stageNamed("implement")), /agent crashed/);
  const failed = s.listRuns(t.id)[1];
  assert.equal(failed?.error, "agent crashed");
  assert.ok(failed?.ended_at);
  assert.equal(failed?.verdict, null);
});

test('require = "all": one failing reviewer fails the Stage, every reviewer still runs, and it costs a Round', async () => {
  const { s, t, runner } = setup({ "critic-b": [{ verdict: "FAIL" }] });
  const executor = agentExecutor({ store: s, runner });
  while ((await tick(s, { pipeline: PIPELINE, executor })).kind === "ran") {
    if (s.getTask(t.id)?.round_total) break;
  }
  const task = s.getTask(t.id);
  assert.equal(task?.stage, "implement");
  assert.equal(task?.round_total, 1);
  assert.equal(task?.round_stage, 1);
  const reviews = s.listRuns(t.id).filter((r) => r.stage === "review");
  assert.deepEqual(
    reviews.map((r) => [r.agent, r.verdict]),
    [
      ["critic-a", "PASS"],
      ["critic-b", "FAIL"],
    ],
  );
  assert.ok(s.listEvents().some((e) => e.type === "round.started" && e.subject === t.id));
});

test('require = "any": the first PASS ends the Stage; all failing fails it', async () => {
  const any = parsePipeline(`
[[stages]]
name = "review"
type = "agent"
agents = ["critic-a", "critic-b"]
require = "any"
on_fail = "review"
`);
  const stage = any.stages[0];
  assert.ok(stage);
  const { s, t, runner } = setup({ "critic-a": [{ verdict: "PASS" }, { verdict: "FAIL" }] });
  const executor = agentExecutor({ store: s, runner });
  const task = s.getTask(t.id);
  assert.ok(task);
  assert.equal(await executor(task, stage), "PASS");
  assert.deepEqual(
    runner.calls.map((c) => c.agent),
    ["critic-a"],
  );
  const failing = setup({
    "critic-a": [{ verdict: "FAIL" }],
    "critic-b": [{ verdict: "FAIL" }],
  });
  const t2 = failing.s.getTask(failing.t.id);
  assert.ok(t2);
  assert.equal(await failing.executor(t2, stage), "FAIL");
  assert.deepEqual(
    failing.runner.calls.map((c) => c.agent),
    ["critic-a", "critic-b"],
  );
});

test("the gate executor runs the named Gates in turn and stops at the first failure", async () => {
  const { s, t } = setup({});
  const task = s.getTask(t.id);
  assert.ok(task);
  const stage = loadPipeline(DEFAULT_PIPELINE_PATH, {}).stages.find((x) => x.name === "gates");
  assert.ok(stage);
  const seen: string[] = [];
  const record = (name: string, verdict: "PASS" | "FAIL") => () => {
    seen.push(name);
    return verdict;
  };
  assert.equal(await gateExecutor(STUB_GATES)(task, stage), "PASS");
  const registry = {
    ...STUB_GATES,
    green_after: record("green_after", "PASS"),
    check_passes: record("check_passes", "FAIL"),
    test_integrity: record("test_integrity", "PASS"),
  };
  assert.equal(await gateExecutor(registry)(task, stage), "FAIL");
  assert.deepEqual(seen, ["green_after", "check_passes"]);
  await assert.rejects(
    gateExecutor({})(task, stage),
    /stage "gates": no gate "green_after" \(gates: \)/,
  );
});

test("stageExecutor sends each Stage to the executor for its type; the owner stub approves", async () => {
  const { s, t } = setup({});
  const task = s.getTask(t.id);
  assert.ok(task);
  const calls: string[] = [];
  const executor = stageExecutor({
    agent: async () => {
      calls.push("agent");
      return "PASS";
    },
    gate: async () => {
      calls.push("gate");
      return "FAIL";
    },
    owner: ownerExecutor,
  });
  const stages = loadPipeline(DEFAULT_PIPELINE_PATH, {}).stages;
  const of = (type: string) => stages.find((x) => x.type === type);
  const [agent, gate, owner] = [of("agent"), of("gate"), of("owner")];
  assert.ok(agent && gate && owner);
  assert.equal(await executor(task, agent), "PASS");
  assert.equal(await executor(task, gate), "FAIL");
  assert.equal(await executor(task, owner), "PASS");
  assert.deepEqual(calls, ["agent", "gate"]);
});

test("the executor runs the Agents agentsFor picks for the Task's Kind, and an override wins", async () => {
  const dir = tmpDir("foreman-runner-");
  const s = new Store(":memory:");
  const { m } = buildingRequest(s, { title: "r", target_repo: join(dir, "work") });
  const pipeline = parsePipeline(`
[[stages]]
name = "review"
type = "agent"
agents = ["reviewer-standards"]
on_fail = "review"

[kinds.ui]
review = ["reviewer-ui"]
`);
  const ui = s.createTask({ milestone_id: m.id, seq: 1, title: "a", kind: "ui", stage: "review" });
  const other = s.createTask({ milestone_id: m.id, seq: 2, title: "b", stage: "review" });
  const chosen = s.createTask({
    milestone_id: m.id,
    seq: 3,
    title: "c",
    kind: "ui",
    stage: "review",
  });
  s.updateTask(chosen.id, { agent_overrides: JSON.stringify({ review: ["reviewer-spec"] }) });
  const runner = new FakeRunner({});
  const executor = agentExecutor({
    store: s,
    runner,
    agentsFor: (task, stage) => agentsFor(pipeline, task, stage),
  });
  const stage = pipeline.stages[0];
  assert.ok(stage);
  for (const t of [ui, other, chosen]) {
    const row = s.getTask(t.id);
    assert.ok(row);
    await executor(row, stage);
  }
  assert.deepEqual(
    runner.calls.map((c) => [c.task, c.agent]),
    [
      [ui.id, "reviewer-ui"],
      [other.id, "reviewer-standards"],
      [chosen.id, "reviewer-spec"],
    ],
  );
});
