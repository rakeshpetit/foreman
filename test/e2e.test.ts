import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { main } from "../src/cli/main.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";
import { FIXTURE_PLAN, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

test("tracer: import → go → run --until-idle with a scripted review failure", async () => {
  const ntfy = new FakeNtfy();
  const server = await ntfy.start();
  try {
    const root = tmpDir("foreman-e2e-");
    const home = join(root, "home");
    const out: string[] = [];
    const run = (...argv: string[]) =>
      main(argv, {
        env: { FOREMAN_HOME: home, FOREMAN_NTFY_SERVER: server, FOREMAN_NTFY_TOPIC: "foreman" },
        cwd: root,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        runner: new FakeRunner({
          implement: [{ verdict: "PASS", usage: { input_tokens: 5, output_tokens: 6 } }],
          review: [
            { verdict: "FAIL", usage: { input_tokens: 11, output_tokens: 22 } },
            { verdict: "PASS", usage: { input_tokens: 33, output_tokens: 44 } },
          ],
        }),
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
      const plain = (task: string) => [
        ...tickOf(task, "workup"),
        ...tickOf(task, "implement"),
        ...tickOf(task, "review"),
      ];
      assert.deepEqual(
        store.listEvents().map((e) => [e.type, e.subject]),
        [
          ["request.imported", "R-1"],
          ["request.go", "R-1"],
          // T-1's first review fails: a Round, caused by the review Stage.
          ...tickOf("T-1", "workup"),
          ...tickOf("T-1", "implement"),
          ...tickOf("T-1", "review", ["round.started", "T-1"]),
          ...tickOf("T-1", "implement"),
          ...tickOf("T-1", "review"),
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

      // One Run per stage run: 4 Tasks x 3 Stages, plus the Round's implement and review.
      const runs = store.listRuns();
      assert.equal(runs.length, 14);
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
      assert.deepEqual(usage("review").slice(0, 2), [
        [11, 22],
        [33, 44],
      ]);
    } finally {
      store.close();
    }

    assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /Phase: done/);
    const titles = ntfy.calls.map((c) => c.title);
    assert.ok(titles.includes("Request done: R-1"));
    assert.equal(titles.filter((t) => t?.startsWith("Task done")).length, 4);
  } finally {
    await ntfy.stop();
  }
});
