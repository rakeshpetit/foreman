import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { agentExecutor } from "../src/engine/agent.ts";
import { tick } from "../src/engine/tick.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";
import { buildingRequest, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function setup(script: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = tmpDir("foreman-runner-");
  const s = new Store(":memory:");
  const { m } = buildingRequest(s, { title: "r", target_repo: join(dir, "work") });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  const runner = new FakeRunner(script);
  const executor = agentExecutor({ store: s, runner });
  return { dir, s, t, runner, executor };
}

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
    workdir: join(dir, "work"),
    reportPath: join(dir, "reports/T/implement.md"),
  });
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal(await readFile(join(dir, "work/src/a.txt"), "utf8"), "hi");
  assert.match(await readFile(result.reportPath, "utf8"), /verdict: PASS/);
});

test("engine runs a Task through all stub stages with FakeRunner; a scripted fail causes a Round", async () => {
  const { s, t, runner, executor } = setup({ review: [{ verdict: "FAIL" }] });
  while ((await tick(s, { executor })).kind === "ran");
  assert.deepEqual(
    runner.calls.map((c) => c.stage),
    ["workup", "implement", "review", "implement", "review"],
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
  assert.equal((await tick(s, { executor })).kind, "ran");
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
  assert.equal(await executor(task, "workup"), "PASS");
  const [run] = s.listRuns(t.id);
  assert.equal(run?.stage, "workup");
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
  await assert.rejects(boom(task, "implement"), /agent crashed/);
  const failed = s.listRuns(t.id)[1];
  assert.equal(failed?.error, "agent crashed");
  assert.ok(failed?.ended_at);
  assert.equal(failed?.verdict, null);
});
