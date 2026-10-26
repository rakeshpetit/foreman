import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { Store } from "../src/store/store.ts";
import { claudeResult, FakeDocker, flagValues, rateLimitLine } from "./fakes/docker/docker.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";
import { cli, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

/** A plan of one Task, so the default Pipeline runs it through every Agent Stage once. */
function onePlan(): string {
  const plan = tmpDir("foreman-plan-");
  writeFileSync(join(plan, "PLAN.md"), "# One task\n");
  writeFileSync(
    join(plan, "TASKS.md"),
    `## M1 · Only
### M1-T01 · Alpha
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Build alpha.
- **Done when:** alpha works.
`,
  );
  return plan;
}

test("M3 tracer: run --until-idle on the ContainerRunner hits a usage limit, resumes, and finishes the Task", async () => {
  const ntfy = new FakeNtfy();
  const server = await ntfy.start();
  try {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const docker = new FakeDocker();
    let limitSent = false;
    // The script of `claude`: every Agent leaves its report and passes, except the first implement,
    // which hits the usage limit before it writes anything.
    docker.claude = (args) => {
      const prompt = args.join("\n");
      const workdir = flagValues(args, "--volume")
        .find((v) => v.endsWith(":/work"))
        ?.slice(0, -":/work".length);
      // The Run's own report: its prompt may also name the reports of earlier Runs.
      const runId = flagValues(args, "--label")[0]?.replace("foreman.run=", "");
      const report = prompt.match(new RegExp(`/work/(\\.foreman/R-1/runs/${runId}-(\\w+)\\.md)`));
      assert.ok(workdir && report?.[1]);
      if (report[2] === "implement" && !limitSent) {
        limitSent = true;
        const stdout = claudeResult(
          { is_error: true, result: "You've hit your 5-hour usage limit" },
          [rateLimitLine("rejected", resetsAt)],
        );
        return { code: 1, stdout, stderr: "" };
      }
      mkdirSync(dirname(join(workdir, report[1])), { recursive: true });
      writeFileSync(join(workdir, report[1]), `# ${report[2]} report`);
      return {
        code: 0,
        stdout: claudeResult({ modelUsage: { "claude-sonnet-5-5": { costUSD: 0.01 } } }),
        stderr: "",
      };
    };

    const { root, home, out, err, run } = cli({
      env: { FOREMAN_NTFY_SERVER: server, FOREMAN_NTFY_TOPIC: "foreman" },
      docker,
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
    assert.equal(await run("import", root, onePlan()), 0);
    assert.equal(await run("go", "R-1"), 0);

    // First run: the workup Agent passes, then the implement Agent hits the limit and the queue pauses.
    assert.equal(await run("run", "--until-idle"), 0, err.join("\n"));
    assert.match(out.join("\n"), /Usage limit reached: paused until /);
    let store = Store.open(home);
    try {
      assert.deepEqual(
        store.listRuns().map((r) => [r.stage, r.verdict, r.exit_code]),
        [
          ["workup", "PASS", 0],
          ["implement", null, 1],
        ],
      );
      assert.equal(store.isPaused(), true);
      assert.equal(store.queueState().paused_until, new Date(resetsAt * 1000).toISOString());
      assert.equal(store.listTasks()[0]?.status, "queued");
      assert.equal(store.listTasks()[0]?.stage, "implement");
    } finally {
      store.close();
    }
    assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /\*\*Queue:\*\* paused until /);
    // A run while paused does nothing, and starts no container.
    const started = docker.callsStarting("run", "--rm").length;
    assert.equal(await run("run", "--until-idle"), 0);
    assert.equal(docker.callsStarting("run", "--rm").length, started);

    // Resume, and a second run finishes the Task.
    assert.equal(await run("resume"), 0);
    assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /\*\*Queue:\*\* running/);
    assert.equal(await run("run", "--until-idle"), 0, err.join("\n"));

    store = Store.open(home);
    try {
      assert.equal(store.listTasks()[0]?.status, "done");
      assert.equal(store.getRequest("R-1")?.phase, "done");

      // Workup, the limit-hit implement, then the retry of implement and the rest of the Pipeline.
      const runs = store.listRuns();
      assert.deepEqual(
        runs.map((r) => r.stage),
        ["workup", "implement", "implement", "review", "review", "verify", "research"],
      );
      assert.deepEqual(
        runs.map((r) => r.id),
        [1, 2, 3, 4, 5, 6, 7],
      );
      const limited = runs[1];
      assert.match(limited?.error ?? "", /usage limit/);
      assert.equal(limited?.verdict, null);
      assert.equal(limited?.exit_code, 1);
      const passed = runs.filter((r) => r.id !== 2);
      for (const r of passed) {
        assert.equal(r.verdict, "PASS");
        assert.equal(r.error, null);
        assert.equal(r.exit_code, 0);
        assert.equal(r.model, "claude-sonnet-5-5");
        assert.equal(r.tokens_in, 12);
        assert.equal(r.tokens_out, 34);
        assert.equal(r.cache_read, 5);
        assert.equal(r.cache_write, 6);
        assert.equal(r.context_peak, 13);
        assert.equal(r.cost_usd, 0.01);
        assert.ok(r.ended_at);
        assert.ok(r.report_path && existsSync(r.report_path));
      }
      assert.ok(runs.every((r) => r.request_id === "R-1" && r.task_id === "T-1"));

      // Every Run keeps its raw stream, the failed one too, under FOREMAN_HOME/runs/.
      assert.deepEqual(
        readdirSync(join(home, "runs")).sort(),
        runs.map((r) => `${r.id}.json`).sort(),
      );
      for (const r of runs) {
        const raw = readFileSync(join(home, "runs", `${r.id}.json`), "utf8");
        assert.match(raw, /"type":"result"/);
        assert.equal(/rate_limit_event/.test(raw), r.id === 2);
      }
      // Reports live in the Target repo.
      assert.equal(readdirSync(join(root, ".foreman", "R-1", "runs")).length, 6);
    } finally {
      store.close();
    }

    const status = readFileSync(join(home, "STATUS.md"), "utf8");
    assert.match(status, /Phase: done/);
    assert.match(status, /\| T-1 \| Alpha \|.*\| done \|/);

    const titles = ntfy.calls.map((c) => c.title);
    assert.deepEqual(titles, [
      "Foreman paused: usage limit",
      "Task done: T-1",
      "Request done: R-1",
    ]);
    assert.match(ntfy.calls[0]?.body ?? "", /paused until \d{4}-/);

    // One container per Run, each on the internal network and removed on exit.
    const containers = docker.callsStarting("run", "--rm");
    assert.equal(containers.length, 7);
    assert.ok(containers.every((c) => c.includes("foreman-agents")));
  } finally {
    await ntfy.stop();
  }
});
