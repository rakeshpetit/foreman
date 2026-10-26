import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runEngine } from "../src/commands/run.ts";
import { parsePipeline } from "../src/config/pipeline.ts";
import { agentExecutor } from "../src/engine/agent.ts";
import { gateExecutor, ownerExecutor, stageExecutor } from "../src/engine/executors.ts";
import { tick } from "../src/engine/tick.ts";
import { STUB_GATES } from "../src/gates/stub.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { verdictSchema } from "../src/runner/prompt.ts";
import type { Runner } from "../src/runner/runner.ts";
import {
  buildingRequest,
  closeStores,
  fixturePipeline,
  memoryStore,
  removeTmpDirs,
  stubConfig,
  tmpDir,
} from "./helpers.ts";

afterEach(removeTmpDirs);
afterEach(closeStores);

function stageNamed(name: string) {
  const stage = PIPELINE.stages.find((s) => s.name === name);
  assert.ok(stage);
  return stage;
}

function setup(script: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = tmpDir("foreman-runner-");
  const s = memoryStore();
  const { m } = buildingRequest(s, { title: "r", target_repo: join(dir, "work") });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  const runner = new FakeRunner(script);
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: tmpDir("foreman-runs-"),
    config: stubConfig(PIPELINE),
  });
  return { dir, s, t, runner, executor };
}

const PIPELINE = parsePipeline(`
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
`);

test("FakeRunner writes scripted files, the report and returns usage", async () => {
  const { dir, runner } = setup({
    implement: [
      {
        verdict: "PASS",
        files: { "src/a.txt": "hi" },
        usage: { tokens_in: 5, tokens_out: 7 },
      },
    ],
  });
  const result = await runner.run({
    runId: 1,
    task: "T",
    stage: "implement",
    agent: "coder",
    workdir: join(dir, "work"),
    reportPath: join(dir, "reports/T/implement.md"),
    systemPrompt: "",
    userPrompt: "",
    verdictSchema: verdictSchema(["PASS"]),
    skills: [],
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.usage, {
    tokens_in: 5,
    tokens_out: 7,
    cache_read: 0,
    cache_write: 0,
    context_peak: null,
    cost_usd: 0,
  });
  assert.equal(await readFile(join(dir, "work/src/a.txt"), "utf8"), "hi");
  assert.match(await readFile(result.reportPath, "utf8"), /verdict: PASS/);
});

test("engine runs a Task through all stub stages with FakeRunner; a scripted fail causes a Round", async () => {
  const { s, t, runner, executor } = setup({ "critic-a": [{ verdict: "FAIL" }] });
  while ((await tick(s, { pipelineFor: () => PIPELINE, executor })).kind === "ran");
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
  const s = memoryStore();
  buildingRequest(s, { title: "first", target_repo: join(dir, "first") }, "m1");
  const { m: m2 } = buildingRequest(s, { title: "second", target_repo: join(dir, "second") }, "m2");
  const t = s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  const runner = new FakeRunner({});
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: tmpDir("foreman-runs-"),
    config: stubConfig(PIPELINE),
  });
  assert.equal((await tick(s, { pipelineFor: () => PIPELINE, executor })).kind, "ran");
  assert.deepEqual(
    runner.calls.map((c) => [c.task, c.workdir]),
    [[t.id, join(dir, "second")]],
  );
});

test("the executor records each Run with its verdict, usage and report, and the error when the Runner throws", async () => {
  const { dir, s, t, executor } = setup({
    workup: [{ verdict: "PASS", usage: { tokens_in: 3, tokens_out: 4 } }],
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
    runsDir: dir,
    config: stubConfig(PIPELINE),
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
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: tmpDir("foreman-runs-"),
    config: stubConfig(PIPELINE),
  });
  while ((await tick(s, { pipelineFor: () => PIPELINE, executor })).kind === "ran") {
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
require = "any"
on_fail = "review"

[kinds.default]
review = ["critic-a", "critic-b"]
`);
  const stage = any.stages[0];
  assert.ok(stage);
  const { s, t, runner } = setup({ "critic-a": [{ verdict: "PASS" }, { verdict: "FAIL" }] });
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: tmpDir("foreman-runs-"),
    config: stubConfig(PIPELINE),
  });
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
  const stage = fixturePipeline().stages.find((x) => x.name === "gates");
  assert.ok(stage);
  const seen: string[] = [];
  const record = (name: string, passed: boolean) => () => {
    seen.push(name);
    return { passed, detail: name };
  };
  assert.equal(await gateExecutor(STUB_GATES)(task, stage), "PASS");
  const registry = {
    ...STUB_GATES,
    green_after: record("green_after", true),
    check_passes: record("check_passes", false),
    test_integrity: record("test_integrity", true),
  };
  assert.equal(await gateExecutor(registry)(task, stage), "FAIL");
  assert.deepEqual(seen, ["green_after", "check_passes"]);
  // Validation has already checked the names, so a Gate missing from the registry just fails.
  assert.equal(await gateExecutor({})(task, stage), "FAIL");
});

test("the agent executor gives a Verdict the engine cannot route as the Stage's, and stops", async () => {
  const { s, t, runner, executor } = setup({
    "critic-a": [{ verdict: "BLOCKED" }],
  });
  const task = s.getTask(t.id);
  assert.ok(task);
  assert.equal(await executor(task, stageNamed("review")), "BLOCKED");
  assert.deepEqual(
    runner.calls.map((c) => c.agent),
    ["critic-a"],
  );
});

test("a BLOCKED Agent Run leaves a verdict.unhandled event and a queued Task", async () => {
  const { s, t, executor } = setup({ workup: [{ verdict: "BLOCKED" }] });
  const result = await tick(s, { pipelineFor: () => PIPELINE, executor });
  assert.equal(result.kind, "error");
  assert.equal(s.getTask(t.id)?.status, "queued");
  assert.equal(s.listEvents().filter((e) => e.type === "verdict.unhandled").length, 1);
  assert.equal(s.listRuns(t.id)[0]?.verdict, "BLOCKED");
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
  const stages = fixturePipeline().stages;
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
  const s = memoryStore();
  const { m } = buildingRequest(s, { title: "r", target_repo: join(dir, "work") });
  const pipeline = parsePipeline(`
[[stages]]
name = "review"
type = "agent"
on_fail = "review"

[kinds.ui]
review = ["reviewer-ui"]

[kinds.default]
review = ["reviewer-standards"]
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
  const runner = new FakeRunner({});
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: dir,
    config: stubConfig(pipeline, ["reviewer-spec"], { [chosen.id]: { review: ["reviewer-spec"] } }),
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

test("an Agent the config does not load fails the Run, which records the error", async () => {
  const { s, t, runner } = setup({});
  const task = s.getTask(t.id);
  assert.ok(task);
  const executor = agentExecutor({
    store: s,
    runner,
    runsDir: tmpDir("foreman-runs-"),
    config: { ...stubConfig(PIPELINE), agents: new Map() },
  });
  await assert.rejects(executor(task, stageNamed("workup")), /unknown agent "writer"/);
  assert.equal(runner.calls.length, 0);
  assert.match(s.listRuns(t.id)[0]?.error ?? "", /unknown agent "writer"/);
});

/** A building Request with one Task, and a second Request, still planning, with its own `.foreman/config.toml`. */
function twoRequests(secondConfig: string) {
  const dir = tmpDir("foreman-midrun-");
  const s = memoryStore();
  const first = buildingRequest(s, { title: "one", target_repo: join(dir, "one") });
  const t1 = s.createTask({ milestone_id: first.m.id, seq: 1, title: "a" });

  const repo2 = join(dir, "two");
  const agentDir = join(repo2, ".foreman", "agents", "custom-impl");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "AGENT.md"),
    "---\noutput:\n  verdicts: [PASS, FAIL]\n---\nRole prompt for {{task.id}}.\n",
  );
  writeFileSync(join(repo2, ".foreman", "config.toml"), secondConfig);
  const r2 = s.createRequest({ title: "two", target_repo: repo2 });
  const m2 = s.createMilestone({ request_id: r2.id, seq: 1, title: "m" });
  const t2 = s.createTask({ milestone_id: m2.id, seq: 1, title: "b", kind: "special" });

  // The second Request starts building while the first Request's first Stage runs.
  const fake = new FakeRunner();
  let started = false;
  const runner: Runner = {
    run: async (spec) => {
      if (!started) {
        started = true;
        s.updateRequest(r2.id, { phase: "building" });
      }
      return fake.run(spec);
    },
  };
  return { dir, s, t1, t2, fake, runner };
}

test("a Request that starts building mid-run runs its Task with its own Target repo's Kinds", async () => {
  const w = twoRequests('[kinds.special]\nimplement = ["custom-impl"]\n');
  const results = await runEngine(w.s, { foremanHome: w.dir, untilIdle: true, runner: w.runner });
  assert.deepEqual(results.at(-1), { kind: "idle" });
  assert.ok(w.s.listTasks().every((t) => t.status === "done"));
  const agentAt = (task: string) =>
    w.fake.calls.filter((c) => c.task === task && c.stage === "implement").map((c) => c.agent);
  assert.deepEqual(agentAt(w.t1.id), ["implementer-tdd"]);
  assert.deepEqual(agentAt(w.t2.id), ["custom-impl"]);
});

test("a broken config found mid-run is a tick error with a stage.misconfigured event", async () => {
  const w = twoRequests('[kinds.special]\nimplement = ["no-such-agent"]\n');
  const results = await runEngine(w.s, { foremanHome: w.dir, untilIdle: true, runner: w.runner });
  const last = results.at(-1);
  assert.equal(last?.kind, "error");
  assert.match(last?.kind === "error" ? last.message : "", /no-such-agent/);
  const event = w.s.listEvents().find((e) => e.type === "stage.misconfigured");
  assert.equal(event?.subject, w.t2.id);
  assert.equal(w.s.getTask(w.t2.id)?.status, "queued");
  assert.equal(w.s.getTask(w.t1.id)?.status, "done");
});

test("runEngine looks up no Task or Request", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/commands/run.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function runEngine"));
  const end = body.indexOf("\n}\n");
  assert.doesNotMatch(
    body.slice(0, end),
    /nextActionable|requestIdOf|getRequest|getMilestone|getTask|listTasks|listRequests/,
  );
});
