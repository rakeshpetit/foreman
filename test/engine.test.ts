import assert from "node:assert/strict";
import { test } from "node:test";
import { route, type Verdict } from "../src/engine/route.ts";
import { dropTask, nextActionable, type StageExecutor, tick } from "../src/engine/tick.ts";
import { Store } from "../src/store/store.ts";
import { buildingRequest } from "./helpers.ts";

test("route: pass advances, fail returns to implement, last stage is done", () => {
  const t = { round_stage: 0, round_total: 0 };
  assert.deepEqual(route("workup", "PASS", t), { kind: "goto", stage: "implement", ...t });
  assert.deepEqual(route("implement", "PASS", t), { kind: "goto", stage: "review", ...t });
  assert.deepEqual(route("review", "PASS", t), { kind: "done", ...t });
  const round = { round_stage: 1, round_total: 1 };
  assert.deepEqual(route("review", "FAIL", t), { kind: "goto", stage: "implement", ...round });
  assert.deepEqual(route("implement", "FAIL", t), { kind: "goto", stage: "implement", ...round });
  assert.deepEqual(route("workup", "FAIL", t), { kind: "goto", stage: "workup", ...round });
});

test("route: round_stage survives the implement pass and adds up across review fails", () => {
  let task = { round_stage: 0, round_total: 0 };
  const steps = [
    ["review", "FAIL", "implement", 1, 1],
    ["implement", "PASS", "review", 1, 1],
    ["review", "FAIL", "implement", 2, 2],
    ["implement", "PASS", "review", 2, 2],
    ["review", "FAIL", "implement", 3, 3],
  ] as const;
  for (const [stage, verdict, next, round_stage, round_total] of steps) {
    const transition = route(stage, verdict, task);
    assert.deepEqual(transition, { kind: "goto", stage: next, round_stage, round_total });
    task = { round_stage, round_total };
  }
});

test("route: a review pass resets round_stage but keeps round_total", () => {
  assert.deepEqual(route("review", "PASS", { round_stage: 2, round_total: 3 }), {
    kind: "done",
    round_stage: 0,
    round_total: 3,
  });
});

// ADR 0010: Implement needs the red test, so a failed Workup retries Workup, and it costs a Round.
test("route: a failed workup stays at workup and costs a Round; a workup pass resets round_stage", () => {
  assert.deepEqual(route("workup", "FAIL", { round_stage: 1, round_total: 1 }), {
    kind: "goto",
    stage: "workup",
    round_stage: 2,
    round_total: 2,
  });
  assert.deepEqual(route("workup", "PASS", { round_stage: 2, round_total: 2 }), {
    kind: "goto",
    stage: "implement",
    round_stage: 0,
    round_total: 2,
  });
});

function seed() {
  const s = Store.memory();
  const { r, m: m1 } = buildingRequest(s, undefined, "m1");
  const m2 = s.createMilestone({ request_id: r.id, seq: 2, title: "m2" });
  return { s, r, m1, m2 };
}
const pass: StageExecutor = async () => "PASS";

test("tick with nothing to do is idle", async () => {
  const { s } = seed();
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "idle" });
});

test("tick skips while the queue is paused", async () => {
  const { s, m1 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.setQueueState({ paused: true, paused_until: "2999-01-01T00:00:00Z", reason: "limit" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "paused", reason: "limit" });
  s.setQueueState({ paused: true, paused_until: null, reason: "owner" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "paused", reason: "owner" });
  s.setQueueState({ paused: true, paused_until: "2000-01-01T00:00:00Z", reason: "limit" });
  assert.equal((await tick(s, { executor: pass })).kind, "ran");
});

test("a task walks workup → implement → review → done, with a Round on failure", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const verdicts: Verdict[] = ["PASS", "PASS", "FAIL", "PASS", "PASS"];
  let i = 0;
  const seen: string[] = [];
  const executor: StageExecutor = async (_t, stage) => {
    seen.push(stage);
    return verdicts[i++] ?? "PASS";
  };
  while ((await tick(s, { executor })).kind === "ran");
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
  await tick(s, { executor: pass }); // workup passes, the Task is now at implement
  const executor: StageExecutor = async () => {
    throw new Error("runner exploded");
  };
  assert.deepEqual(await tick(s, { executor }), {
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

test("dependencies are respected and earliest milestone goes first", async () => {
  const { s, m1, m2 } = seed();
  const late = s.createTask({ milestone_id: m2.id, seq: 1, title: "late" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.addDependency(a.id, b.id); // a needs b even though a has the lower seq
  const order: string[] = [];
  const executor: StageExecutor = async (t, stage) => {
    if (stage === "review") order.push(t.id);
    return "PASS";
  };
  while ((await tick(s, { executor })).kind === "ran");
  assert.deepEqual(order, [b.id, a.id, late.id]);
});

test("a dependency that is not done blocks its dependant", async () => {
  const { s, m1 } = seed();
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b" });
  s.addDependency(b.id, a.id);
  s.updateTask(a.id, { status: "parked" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "idle" });
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
  const s = Store.memory();
  const r = s.createRequest({ title: "r", target_repo: "/r" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "idle" });
});

test("the last Task of a Milestone completes it; the last Milestone completes the Request", async () => {
  const { s, r, m1, m2 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  const completed = [];
  for (let result = await tick(s, { executor: pass }); result.kind === "ran"; ) {
    completed.push(result.completed);
    result = await tick(s, { executor: pass });
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
  for (let i = 0; i < 3; i++) await tick(s, { executor: pass });
  assert.equal(s.getMilestone(m1.id)?.status, "pending");
  assert.equal(s.getRequest(r.id)?.phase, "building");
});

test("a Request whose last Task is dropped completes", async () => {
  const { s, r, m1, m2 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m2.id, seq: 1, title: "b" });
  for (let i = 0; i < 3; i++) await tick(s, { executor: pass }); // a: workup, implement, review
  assert.equal(s.getMilestone(m1.id)?.status, "done");
  assert.equal(s.getRequest(r.id)?.phase, "building");
  assert.deepEqual(dropTask(s, b.id), { milestones: [m2.id], request: r.id });
  assert.equal(s.getTask(b.id)?.status, "dropped");
  assert.equal(s.getMilestone(m2.id)?.status, "done");
  assert.equal(s.getRequest(r.id)?.phase, "done");
  assert.ok(s.listEvents().some((e) => e.type === "request.done" && e.subject === r.id));
  assert.ok(s.listEvents().some((e) => e.type === "task.dropped" && e.subject === b.id));
});
