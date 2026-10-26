import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { parsePipeline } from "../src/config/pipeline.ts";
import { agentExecutor } from "../src/engine/agent.ts";
import { Escalation } from "../src/engine/escalation.ts";
import { tick } from "../src/engine/tick.ts";
import { ContainerRunner } from "../src/runner/container.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { RunFailure, type Runner, type RunResult } from "../src/runner/runner.ts";
import { FakeDocker } from "./fakes/docker/docker.ts";
import {
  buildingRequest,
  closeStores,
  memoryStore,
  removeTmpDirs,
  stubConfig,
  tmpDir,
} from "./helpers.ts";

afterEach(removeTmpDirs);
afterEach(closeStores);

const PIPELINE = parsePipeline(`
[[stages]]
name = "implement"
type = "agent"
on_fail = "implement"

[[stages]]
name = "review"
type = "agent"
on_fail = "implement"

[kinds.default]
implement = ["coder"]
review = ["critic"]
`);

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/claude/result.json"), "utf8");

function setup() {
  const dir = tmpDir("foreman-recording-");
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const s = memoryStore();
  const { m } = buildingRequest(s, { title: "r", target_repo: repo });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  const config = stubConfig(PIPELINE);
  const coder = config.agents.get("coder");
  assert.ok(coder);
  config.agents.set("coder", { ...coder, agent: { ...coder.agent, effort: "high" } });
  const stage = (name: string) => {
    const found = PIPELINE.stages.find((x) => x.name === name);
    assert.ok(found);
    return found;
  };
  const task = () => {
    const row = s.getTask(t.id);
    assert.ok(row);
    return row;
  };
  return { dir, home, repo, s, t, task, stage, config };
}

/** A Runner that plays `outcomes` in turn: a RunFailure or an Error to throw, or a result to return. */
function scripted(outcomes: (RunFailure | Error | Partial<RunResult> | "no-report")[]): Runner & {
  calls: number;
} {
  return {
    calls: 0,
    async run(spec) {
      this.calls++;
      const outcome = outcomes.shift() ?? {};
      if (outcome instanceof Error) throw outcome;
      if (outcome !== "no-report") {
        mkdirSync(dirname(spec.reportPath), { recursive: true });
        writeFileSync(spec.reportPath, "report");
      }
      return {
        verdict: "PASS",
        reportPath: spec.reportPath,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          context_peak: 5,
          cost_usd: 0.5,
        },
        raw: '{"raw":true}',
        ...(outcome === "no-report" ? {} : outcome),
      };
    },
  };
}

describe("recording a Run", () => {
  it("turns a real Claude result into a complete row, through the ContainerRunner", async () => {
    const { home, repo, s, t, task, stage, config } = setup();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
    const docker = new FakeDocker();
    docker.claude = () => {
      // The Agent leaves its report where the prompt says: the first Run's id is 1.
      const report = join(repo, ".foreman", "R-1", "runs", "1-implement.md");
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, "# report");
      return { code: 0, stdout: FIXTURE, stderr: "" };
    };
    const runner = new ContainerRunner({ docker, home, user: "501:20" });
    const executor = agentExecutor({ store: s, runner, home, config });
    assert.equal(await executor(task(), stage("implement")), "PASS");

    const [row] = s.listRuns(t.id);
    assert.ok(row);
    assert.deepEqual(
      {
        agent: row.agent,
        stage: row.stage,
        model: row.model,
        effort: row.effort,
        verdict: row.verdict,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        context_peak: row.context_peak,
        cost_usd: row.cost_usd,
        exit_code: row.exit_code,
        report_path: row.report_path,
        error: row.error,
      },
      {
        agent: "coder",
        stage: "implement",
        model: "claude-sonnet-5-5",
        effort: "high",
        verdict: "PASS",
        tokens_in: 9,
        tokens_out: 410,
        cache_read: 12000,
        cache_write: 3500,
        context_peak: 11494,
        cost_usd: 0.0412,
        exit_code: 0,
        report_path: join(repo, ".foreman/R-1/runs/1-implement.md"),
        error: null,
      },
    );
    assert.ok(row.started_at && row.ended_at);
    assert.equal(typeof row.duration_ms, "number");
    assert.ok(existsSync(row.report_path ?? ""));
    // The raw JSON is kept under the foreman home, named for the Run.
    assert.equal(readFileSync(join(home, "runs", `${row.id}.json`), "utf8"), FIXTURE);
  });

  it("records the Agent's own model when the Runner does not say which one ran", async () => {
    const { s, t, task, stage, config, home } = setup();
    const coder = config.agents.get("coder");
    assert.ok(coder);
    config.agents.set("coder", { ...coder, agent: { ...coder.agent, model: "opus" } });
    await agentExecutor({ store: s, runner: new FakeRunner(), home, config })(
      task(),
      stage("implement"),
    );
    assert.equal(s.listRuns(t.id)[0]?.model, "opus");
  });
});

describe("infrastructure failures", () => {
  it("retries a Run that left no valid Verdict once, and the retry's result stands", async () => {
    const { s, t, task, stage, home, config } = setup();
    const runner = scripted([new RunFailure("invalid-result", "no Verdict", "garbled"), {}]);
    const executor = agentExecutor({ store: s, runner, home, config });
    assert.equal(await executor(task(), stage("implement")), "PASS");
    assert.equal(runner.calls, 2);
    const [first, second] = s.listRuns(t.id);
    assert.equal(first?.error, "no Verdict");
    assert.equal(first?.verdict, null);
    assert.equal(first?.report_path, null);
    assert.equal(second?.verdict, "PASS");
    assert.equal(second?.error, null);
    // What the failed attempt printed is kept too.
    assert.equal(readFileSync(join(home, "runs", `${first?.id}.json`), "utf8"), "garbled");
    assert.equal(task().round_total, 0);
    assert.ok(s.listEvents().some((e) => e.type === "run.retried" && e.subject === t.id));
  });

  it("keeps the usage a failed Run reports, and a raw output that cannot be written does not hide the failure", async () => {
    const { s, t, task, stage, home, config } = setup();
    // `runs` is a file, so the raw output cannot be saved there.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "runs"), "in the way");
    const usage = {
      input_tokens: 7,
      output_tokens: 8,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 10,
      context_peak: 11,
      cost_usd: 0.25,
    };
    const runner = scripted([new RunFailure("invalid-result", "bad Verdict", "x", usage), {}]);
    const executor = agentExecutor({ store: s, runner, home, config });
    const log = mock.method(console, "error", () => {});
    try {
      assert.equal(await executor(task(), stage("implement")), "PASS");
    } finally {
      log.mock.restore();
    }
    const first = s.listRuns(t.id)[0];
    assert.equal(first?.error, "bad Verdict");
    assert.ok(first?.ended_at);
    assert.deepEqual([first?.tokens_in, first?.cache_write, first?.cost_usd], [7, 10, 0.25]);
    assert.match(String(log.mock.calls[0]?.arguments[0]), /could not keep the output of Run 1/);
  });

  it("treats a Verdict with no report as a failure, keeping the usage it spent", async () => {
    const { s, t, task, stage, home, config } = setup();
    const runner = scripted(["no-report", {}]);
    const executor = agentExecutor({ store: s, runner, home, config });
    assert.equal(await executor(task(), stage("implement")), "PASS");
    const [first, second] = s.listRuns(t.id);
    assert.match(first?.error ?? "", /left no report at .*1-implement\.md/);
    assert.equal(first?.verdict, null);
    assert.equal(first?.report_path, null);
    assert.deepEqual([first?.tokens_in, first?.cost_usd, first?.context_peak], [1, 0.5, 5]);
    assert.equal(readFileSync(join(home, "runs", `${first?.id}.json`), "utf8"), '{"raw":true}');
    assert.equal(second?.verdict, "PASS");
  });

  it("retries a timeout and a failed container the same way", async () => {
    for (const kind of ["timeout", "failed"] as const) {
      const { s, task, stage, home, config } = setup();
      const runner = scripted([new RunFailure(kind, "boom"), {}]);
      const executor = agentExecutor({ store: s, runner, home, config });
      assert.equal(await executor(task(), stage("implement")), "PASS", kind);
      assert.equal(runner.calls, 2, kind);
    }
  });

  it("escalates when the retry fails too, and neither Run left a Verdict", async () => {
    const { s, t, task, stage, home, config } = setup();
    const runner = scripted([
      new RunFailure("invalid-result", "first"),
      new RunFailure("invalid-result", "second"),
      {},
    ]);
    const executor = agentExecutor({ store: s, runner, home, config });
    await assert.rejects(
      executor(task(), stage("implement")),
      (e) =>
        e instanceof Escalation &&
        /coder/.test(e.message) &&
        /implement/.test(e.message) &&
        /second/.test(e.message),
    );
    assert.equal(runner.calls, 2, "one retry, no more");
    assert.deepEqual(
      s.listRuns(t.id).map((r) => [r.error, r.verdict]),
      [
        ["first", null],
        ["second", null],
      ],
    );
  });

  it("does not retry a bad token, nor a plain error: the engine stops instead", async () => {
    for (const failure of [new RunFailure("auth", "401"), new Error("setup")]) {
      const { s, t, task, stage, home, config } = setup();
      const runner = scripted([failure, {}]);
      const executor = agentExecutor({ store: s, runner, home, config });
      await assert.rejects(executor(task(), stage("implement")), failure);
      assert.equal(runner.calls, 1);
      assert.equal(s.listRuns(t.id).length, 1);
    }
  });

  it("parks the Task on an Escalation without costing a Round, and says so in an event", async () => {
    const { s, t, stage, home, config } = setup();
    const runner = scripted([
      new RunFailure("invalid-result", "a"),
      new RunFailure("invalid-result", "b"),
    ]);
    const executor = agentExecutor({ store: s, runner, home, config });
    const result = await tick(s, { pipelineFor: () => PIPELINE, executor });
    assert.equal(result.kind, "escalated");
    assert.ok(result.kind === "escalated" && result.task === t.id);
    assert.ok(result.kind === "escalated" && result.stage === stage("implement").name);
    const task = s.getTask(t.id);
    assert.equal(task?.status, "parked");
    assert.equal(task?.stage, "implement");
    assert.equal(task?.round_total, 0);
    assert.equal(task?.round_stage, 0);
    const events = s.listEvents().filter((e) => e.type === "task.escalated");
    assert.equal(events.length, 1);
    assert.match(events[0]?.payload ?? "", /"stage":"implement"/);
    // Its lease is released, and the parked Task is not picked up again.
    assert.equal((await tick(s, { pipelineFor: () => PIPELINE, executor })).kind, "idle");
  });
});
