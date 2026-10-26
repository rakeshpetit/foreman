import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentExecutor } from "../src/engine/agent.ts";
import { tick } from "../src/engine/tick.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";

async function setup(script: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "foreman-runner-"));
  const s = new Store(":memory:");
  const r = s.createRequest({ title: "r", target_repo: "/r" });
  s.updateRequest(r.id, { phase: "building" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  const runner = new FakeRunner(script);
  const executor = agentExecutor({
    runner,
    workdir: join(dir, "work"),
    reportsDir: join(dir, "reports"),
  });
  return { dir, s, t, runner, executor };
}

test("FakeRunner writes scripted files, the report and returns usage", async () => {
  const { dir, runner } = await setup({
    implement: [
      {
        verdict: "pass",
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
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal(await readFile(join(dir, "work/src/a.txt"), "utf8"), "hi");
  assert.match(await readFile(result.reportPath, "utf8"), /verdict: pass/);
});

test("engine runs a Task through all stub stages with FakeRunner; a scripted fail causes a Round", async () => {
  const { s, t, runner, executor } = await setup({ review: [{ verdict: "fail" }] });
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
