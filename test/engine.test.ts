import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parsePipeline } from "../src/config/pipeline.ts";
import { route } from "../src/engine/route.ts";
import { dropTask, nextActionable, type StageExecutor, tick } from "../src/engine/tick.ts";
import type { RoutedVerdict } from "../src/engine/verdict.ts";
import { LANES } from "../src/store/lane.ts";
import { buildingRequest, closeStores, fixturePipeline, memoryStore } from "./helpers.ts";

afterEach(closeStores);

const THREE_STAGES = parsePipeline(`
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
on_fail = "implement"

[kinds.default]
workup = ["a"]
implement = ["a"]
review = ["a"]
`);
const FIXTURE = fixturePipeline();
const lane = "normal" as const;

test("route: pass advances, fail returns to implement, last stage is done", () => {
  const t = { round_stage: 0, round_total: 0, lane };
  assert.deepEqual(route(THREE_STAGES, "workup", "PASS", t), {
    kind: "goto",
    stage: "implement",
    round_stage: 0,
    round_total: 0,
  });
  assert.deepEqual(route(THREE_STAGES, "implement", "PASS", t), {
    kind: "goto",
    stage: "review",
    round_stage: 0,
    round_total: 0,
  });
  assert.deepEqual(route(THREE_STAGES, "review", "PASS", t), {
    kind: "done",
    round_stage: 0,
    round_total: 0,
  });
  const round = { round_stage: 1, round_total: 1 };
  assert.deepEqual(route(THREE_STAGES, "review", "FAIL", t), {
    kind: "goto",
    stage: "implement",
    ...round,
  });
  assert.deepEqual(route(THREE_STAGES, "implement", "FAIL", t), {
    kind: "goto",
    stage: "implement",
    ...round,
  });
  assert.deepEqual(route(THREE_STAGES, "workup", "FAIL", t), {
    kind: "goto",
    stage: "workup",
    ...round,
  });
});

test("route: round_stage survives the implement pass and adds up across review fails", () => {
  let task = { round_stage: 0, round_total: 0, lane };
  const steps = [
    ["review", "FAIL", "implement", 1, 1],
    ["implement", "PASS", "review", 1, 1],
    ["review", "FAIL", "implement", 2, 2],
    ["implement", "PASS", "review", 2, 2],
    ["review", "FAIL", "implement", 3, 3],
  ] as const;
  for (const [stage, verdict, next, round_stage, round_total] of steps) {
    const transition = route(THREE_STAGES, stage, verdict, task);
    assert.deepEqual(transition, { kind: "goto", stage: next, round_stage, round_total });
    task = { round_stage, round_total, lane };
  }
});

test("route: a review pass resets round_stage but keeps round_total", () => {
  assert.deepEqual(
    route(THREE_STAGES, "review", "PASS", { round_stage: 2, round_total: 3, lane }),
    {
      kind: "done",
      round_stage: 0,
      round_total: 3,
    },
  );
});

// ADR 0010: Implement needs the red test, so a failed Workup retries Workup, and it costs a Round.
test("route: a failed workup stays at workup and costs a Round; a workup pass resets round_stage", () => {
  assert.deepEqual(
    route(THREE_STAGES, "workup", "FAIL", { round_stage: 1, round_total: 1, lane }),
    {
      kind: "goto",
      stage: "workup",
      round_stage: 2,
      round_total: 2,
    },
  );
  assert.deepEqual(
    route(THREE_STAGES, "workup", "PASS", { round_stage: 2, round_total: 2, lane }),
    {
      kind: "goto",
      stage: "implement",
      round_stage: 0,
      round_total: 2,
    },
  );
});

test("route: on_pass and on_fail come from the config, and a Stage the Task was sent back to keeps round_stage", () => {
  const at = { round_stage: 0, round_total: 0, lane };
  const goto = (stage: string, round_stage = 0, round_total = 0) => ({
    kind: "goto",
    stage,
    round_stage,
    round_total,
  });
  assert.deepEqual(route(FIXTURE, "workup", "PASS", at), goto("red"));
  assert.deepEqual(route(FIXTURE, "red", "FAIL", at), goto("workup", 1, 1));
  assert.deepEqual(route(FIXTURE, "gates", "FAIL", at), goto("implement", 1, 1));
  assert.deepEqual(route(FIXTURE, "review", "PASS", at), goto("task_approval"));
  assert.deepEqual(route(FIXTURE, "task_approval", "PASS", at), goto("research"));
  assert.deepEqual(route(FIXTURE, "research", "PASS", at), {
    kind: "done",
    round_stage: 0,
    round_total: 0,
  });
  // Workup is the Stage `red` sends back to, so passing it keeps the count; `gates` is not, so it resets.
  const reworked = { round_stage: 1, round_total: 1, lane };
  assert.deepEqual(route(FIXTURE, "workup", "PASS", reworked), goto("red", 1, 1));
  assert.deepEqual(route(FIXTURE, "implement", "PASS", reworked), goto("gates", 1, 1));
  assert.deepEqual(route(FIXTURE, "gates", "PASS", reworked), goto("review", 0, 1));
});

test("route: a pass skips Stages outside the Task's lane", () => {
  const fast = { round_stage: 0, round_total: 0, lane: "fast" as const };
  const skipping = parsePipeline(
    `[[stages]]
name = "a"
type = "agent"
on_fail = "a"
lanes = ["normal"]

[[stages]]
name = "b"
type = "agent"
on_fail = "a"
lanes = ["normal"]

[[stages]]
name = "c"
type = "agent"
on_fail = "c"

[lanes.normal]
[lanes.fast]

[kinds.default]
a = ["x"]
b = ["x"]
c = ["x"]
`,
    {},
  );
  assert.deepEqual(route(skipping, "c", "PASS", fast), {
    kind: "done",
    round_stage: 0,
    round_total: 0,
  });
  assert.deepEqual(route(skipping, "c", "PASS", { ...fast, lane: "normal" }), {
    kind: "done",
    round_stage: 0,
    round_total: 0,
  });
});

test("route: every FAIL lands on its Stage's on_fail, in every lane the Stage runs in", () => {
  for (const lane of LANES) {
    const at = { round_stage: 0, round_total: 0, lane };
    for (const s of FIXTURE.stages) {
      if (s.lanes && !s.lanes.includes(lane)) continue;
      assert.deepEqual(
        route(FIXTURE, s.name, "FAIL", at),
        { kind: "goto", stage: s.on_fail, round_stage: 1, round_total: 1 },
        `${s.name} in ${lane}`,
      );
    }
  }
});

function seed() {
  const s = memoryStore();
  const { r, m: m1 } = buildingRequest(s, undefined, "m1");
  const m2 = s.createMilestone({ request_id: r.id, seq: 2, title: "m2" });
  return { s, r, m1, m2 };
}
const pass: StageExecutor = async () => "PASS";

test("tick with nothing to do is idle", async () => {
  const { s } = seed();
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }), {
    kind: "idle",
  });
});

test("tick skips while the queue is paused", async () => {
  const { s, m1 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.setQueueState({ paused: true, paused_until: "2999-01-01T00:00:00Z", reason: "limit" });
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }), {
    kind: "paused",
    reason: "limit",
  });
  s.setQueueState({ paused: true, paused_until: null, reason: "owner" });
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }), {
    kind: "paused",
    reason: "owner",
  });
  s.setQueueState({ paused: true, paused_until: "2000-01-01T00:00:00Z", reason: "limit" });
  assert.equal((await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass })).kind, "ran");
});

test("a task walks workup → implement → review → done, with a Round on failure", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const verdicts: RoutedVerdict[] = ["PASS", "PASS", "FAIL", "PASS", "PASS"];
  let i = 0;
  const seen: string[] = [];
  const executor: StageExecutor = async (_t, stage) => {
    seen.push(stage.name);
    return verdicts[i++] ?? "PASS";
  };
  while ((await tick(s, { pipelineFor: () => THREE_STAGES, executor })).kind === "ran");
  assert.deepEqual(seen, ["workup", "implement", "review", "implement", "review"]);
  const done = s.getTask(t.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.round_total, 1);
  assert.equal(s.listEvents().filter((e) => e.type === "stage.completed").length, 5);
  assert.deepEqual(s.expiredLeases(), []);
});

test("an executor that throws puts the Task back to queued, records stage.crashed and returns an error", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }); // workup passes, the Task is now at implement
  const executor: StageExecutor = async () => {
    throw new Error("runner exploded");
  };
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor }), {
    kind: "error",
    task: t.id,
    stage: "implement",
    message: "runner exploded",
  });
  const after = s.getTask(t.id);
  assert.equal(after?.status, "queued");
  assert.equal(after?.stage, "implement");
  const crashed = s.listEvents().filter((e) => e.type === "stage.crashed");
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0]?.subject, t.id);
  assert.deepEqual(JSON.parse(crashed[0]?.payload ?? "null"), {
    stage: "implement",
    message: "runner exploded",
  });
  assert.deepEqual(s.expiredLeases(), []);
  assert.equal(s.takeLease(t.id, "someone-else", 1000), true);
});

test("a Verdict the engine cannot route queues the Task and records verdict.unhandled", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }); // workup passes, the Task is now at implement
  for (const verdict of ["BLOCKED", "SCOPE_CHANGE"] as const) {
    const executor: StageExecutor = async () => verdict;
    const message = `stage "implement" ended with ${verdict}, which the engine cannot route yet`;
    assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor }), {
      kind: "error",
      task: t.id,
      stage: "implement",
      message,
    });
    const after = s.getTask(t.id);
    assert.equal(after?.status, "queued");
    assert.equal(after?.stage, "implement");
    assert.equal(after?.round_total, 0);
    const events = s.listEvents().filter((e) => e.type === "verdict.unhandled");
    assert.deepEqual(JSON.parse(events.at(-1)?.payload ?? "null"), {
      stage: "implement",
      verdict,
      message,
    });
  }
  assert.equal(s.listEvents().filter((e) => e.type === "stage.completed").length, 1);
  assert.deepEqual(s.expiredLeases(), []);
});

test("dependencies are respected and earliest milestone goes first", async () => {
  const { s, m1, m2 } = seed();
  const late = s.createTask({ milestone_id: m2.id, seq: 1, title: "late" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.addDependency(a.id, b.id); // a needs b even though a has the lower seq
  const order: string[] = [];
  const executor: StageExecutor = async (t, stage) => {
    if (stage.name === "review") order.push(t.id);
    return "PASS";
  };
  while ((await tick(s, { pipelineFor: () => THREE_STAGES, executor })).kind === "ran");
  assert.deepEqual(order, [b.id, a.id, late.id]);
});

test("a dependency that is not done blocks its dependant", async () => {
  const { s, m1 } = seed();
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  s.addDependency(b.id, a.id);
  s.updateTask(a.id, { status: "parked" });
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }), {
    kind: "idle",
  });
});

test("a dependency that is dropped does not block its dependant", () => {
  const { s, m1 } = seed();
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  s.addDependency(b.id, a.id);
  s.updateTask(a.id, { status: "dropped" });
  assert.equal(nextActionable(s)?.id, b.id);
});

test("Requests still in planning are not worked", async () => {
  const s = memoryStore();
  const r = s.createRequest({ title: "r", target_repo: "/r" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  assert.deepEqual(await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }), {
    kind: "idle",
  });
});

test("the last Task of a Milestone completes it; the last Milestone completes the Request", async () => {
  const { s, r, m1, m2 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  const completed = [];
  for (
    let result = await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass });
    result.kind === "ran";
  ) {
    completed.push(result.completed);
    result = await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass });
  }
  assert.deepEqual(completed.slice(0, 2), [
    { milestones: [], request: null },
    { milestones: [], request: null },
  ]);
  assert.deepEqual(
    completed.filter((c) => c.milestones.length > 0),
    [
      { milestones: [m1.id], request: null },
      { milestones: [m2.id], request: r.id },
    ],
  );
  assert.equal(s.getMilestone(m1.id)?.status, "done");
  assert.equal(s.getMilestone(m2.id)?.status, "done");
  assert.equal(s.getRequest(r.id)?.phase, "done");
  const events = s.listEvents().filter((e) => e.type.endsWith(".done"));
  assert.deepEqual(
    events.map((e) => [e.type, e.subject]),
    [
      ["milestone.done", m1.id],
      ["milestone.done", m2.id],
      ["request.done", r.id],
    ],
  );
});

test("a Milestone with an open Task does not complete", async () => {
  const { s, r, m1 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  for (let i = 0; i < 3; i++) await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass });
  assert.equal(s.getMilestone(m1.id)?.status, "pending");
  assert.equal(s.getRequest(r.id)?.phase, "building");
});

test("a Request whose last Task is dropped completes", async () => {
  const { s, r, m1, m2 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  for (let i = 0; i < 3; i++) await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass }); // a: workup, implement, review
  assert.equal(s.getMilestone(m1.id)?.status, "done");
  assert.equal(s.getRequest(r.id)?.phase, "building");
  assert.deepEqual(dropTask(s, b.id), { milestones: [m2.id], request: r.id });
  assert.equal(s.getTask(b.id)?.status, "dropped");
  assert.equal(s.getMilestone(m2.id)?.status, "done");
  assert.equal(s.getRequest(r.id)?.phase, "done");
  assert.ok(s.listEvents().some((e) => e.type === "request.done" && e.subject === r.id));
  assert.ok(s.listEvents().some((e) => e.type === "task.dropped" && e.subject === b.id));
});

test("a Task whose Stage is not in the Pipeline is an error and is left untouched", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a", stage: "deploy" });
  const result = await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass });
  assert.equal(result.kind, "error");
  assert.match(result.kind === "error" ? result.message : "", /no stage "deploy"/);
  assert.equal(s.getTask(t.id)?.status, "queued");
  assert.deepEqual(s.expiredLeases(), []);
});

test("a Task whose Stage is not in the Pipeline gets a stage.misconfigured event", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a", stage: "deploy" });
  const before = s.getTask(t.id);
  const result = await tick(s, { pipelineFor: () => THREE_STAGES, executor: pass });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" ? result.stage : "unset", "deploy");
  assert.deepEqual(s.getTask(t.id), before);
  const events = s.listEvents().filter((e) => e.type === "stage.misconfigured");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, t.id);
  const payload = JSON.parse(events[0]?.payload ?? "null");
  assert.equal(payload.stage, "deploy");
  assert.match(payload.message, /no stage "deploy"/);
});

test("a Task with no Stage that runs in its lane reports no Stage", async () => {
  const { s, m1 } = seed();
  const normalOnly = parsePipeline(
    `[[stages]]
name = "a"
type = "agent"
on_fail = "a"
lanes = ["normal"]

[lanes.normal]
[lanes.fast]

[kinds.default]
a = ["x"]
`,
    {},
  );
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a", lane: "fast" });
  const result = await tick(s, { pipelineFor: () => normalOnly, executor: pass });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" ? result.stage : "unset", undefined);
  assert.equal(s.getTask(t.id)?.status, "queued");
  assert.equal(s.listEvents().filter((e) => e.type === "stage.misconfigured").length, 1);
});

test("a fast-lane Task starts at the first Stage that runs in its lane", async () => {
  const { s, m1 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a", lane: "fast" });
  const seen: string[] = [];
  const executor: StageExecutor = async (_t, stage) => {
    seen.push(stage.name);
    return "PASS";
  };
  while ((await tick(s, { pipelineFor: () => FIXTURE, executor })).kind === "ran");
  assert.deepEqual(seen, ["implement", "gates", "review", "task_approval", "research"]);
});
