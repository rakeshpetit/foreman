import assert from "node:assert/strict";
import { test } from "node:test";
import { route } from "../src/engine/route.ts";
import { type StageExecutor, tick } from "../src/engine/tick.ts";
import { Store } from "../src/store/store.ts";

test("route: pass advances, fail returns to implement, last stage is done", () => {
  assert.deepEqual(route("workup", "pass"), { kind: "goto", stage: "implement", round: false });
  assert.deepEqual(route("implement", "pass"), { kind: "goto", stage: "review", round: false });
  assert.deepEqual(route("review", "pass"), { kind: "done" });
  assert.deepEqual(route("review", "fail"), { kind: "goto", stage: "implement", round: true });
  assert.deepEqual(route("implement", "fail"), { kind: "goto", stage: "implement", round: true });
  assert.deepEqual(route("workup", "fail"), { kind: "goto", stage: "workup", round: true });
});

function seed() {
  const s = Store.memory();
  const r = s.createRequest({ title: "r", target_repo: "/r" });
  s.updateRequest(r.id, { phase: "building" });
  const m1 = s.createMilestone({ request_id: r.id, seq: 1, title: "m1" });
  const m2 = s.createMilestone({ request_id: r.id, seq: 2, title: "m2" });
  return { s, r, m1, m2 };
}
const pass: StageExecutor = async () => "pass";

test("tick with nothing to do is idle", async () => {
  const { s } = seed();
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "idle" });
});

test("tick skips while the queue is paused", async () => {
  const { s, m1 } = seed();
  s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  s.setQueueState({ paused_until: "2999-01-01T00:00:00Z", reason: "limit" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "paused", reason: "limit" });
  s.setQueueState({ paused_until: "2000-01-01T00:00:00Z", reason: "limit" });
  assert.equal((await tick(s, { executor: pass })).kind, "ran");
});

test("a task walks workup → implement → review → done, with a Round on failure", async () => {
  const { s, m1 } = seed();
  const t = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const outcomes = ["pass", "pass", "fail", "pass", "pass"] as const;
  let i = 0;
  const seen: string[] = [];
  const executor: StageExecutor = async (_t, stage) => {
    seen.push(stage);
    return outcomes[i++] as "pass" | "fail";
  };
  while ((await tick(s, { executor })).kind === "ran");
  assert.deepEqual(seen, ["workup", "implement", "review", "implement", "review"]);
  const done = s.getTask(t.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.round_total, 1);
  assert.equal(s.listEvents().filter((e) => e.type === "stage.completed").length, 5);
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
    if (stage === "review") order.push(t.id);
    return "pass";
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

test("Requests still in planning are not worked", async () => {
  const s = Store.memory();
  const r = s.createRequest({ title: "r", target_repo: "/r" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  s.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  assert.deepEqual(await tick(s, { executor: pass }), { kind: "idle" });
});
