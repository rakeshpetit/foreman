import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store/store.ts";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "foreman-"));
}

test("migrates from empty and twice is a no-op", () => {
  const home = tmpHome();
  const a = Store.open(home);
  const r = a.createRequest({ title: "x", target_repo: "/r" });
  a.close();
  const b = Store.open(home);
  assert.equal(b.getRequest(r.id)?.title, "x");
  const v = b.db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, 1);
  b.close();
});

test("allocates R-n, M-n, T-n ids", () => {
  const s = Store.memory();
  const r1 = s.createRequest({ title: "a", target_repo: "/r" });
  const r2 = s.createRequest({ title: "b", target_repo: "/r" });
  assert.deepEqual([r1.id, r2.id], ["R-1", "R-2"]);
  const m = s.createMilestone({ request_id: r1.id, seq: 1, title: "m" });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "t" });
  assert.deepEqual([m.id, t.id], ["M-1", "T-1"]);
});

test("creates and reads every entity", () => {
  const s = Store.memory();
  const r = s.createRequest({ title: "a", target_repo: "/r", mode: "auto" });
  assert.equal(r.mode, "auto");
  s.updateRequest(r.id, { phase: "building" });
  assert.equal(s.getRequest(r.id)?.phase, "building");

  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  const t1 = s.createTask({ milestone_id: m.id, seq: 1, title: "t1", ref: "M1-T01" });
  const t2 = s.createTask({ milestone_id: m.id, seq: 2, title: "t2" });
  s.addDependency(t2.id, t1.id);
  assert.deepEqual(s.dependenciesOf(t2.id), [t1.id]);
  s.updateTask(t1.id, { status: "active", stage: "implement", round_total: 2 });
  assert.equal(s.getTask(t1.id)?.round_total, 2);
  assert.equal(s.listTasks(m.id).length, 2);

  const run = s.createRun({ task_id: t1.id, request_id: r.id, stage: "implement", agent: "a" });
  s.finishRun(run, { verdict: "PASS", tokens_in: 5 });
  assert.equal(s.getRun(run)?.verdict, "PASS");
  assert.ok(s.getRun(run)?.ended_at);

  const a = s.createApproval({ kind: "go", subject_id: r.id });
  assert.equal(s.listApprovals("pending").length, 1);
  s.decideApproval(a.id, "approved", "ok", "cli");
  assert.equal(s.getApproval(a.id)?.status, "approved");

  s.addEvent("x", "T-1", { a: 1 });
  assert.equal(s.listEvents()[0]?.payload, '{"a":1}');

  s.setQueueState({ paused_until: "2030-01-01", reason: "limit" });
  assert.equal(s.queueState().reason, "limit");
});

test("leases are exclusive until expiry", () => {
  const s = Store.memory();
  let t = new Date("2026-01-01T00:00:00Z");
  s.now = () => t;
  assert.ok(s.takeLease("T-1", "a", 1000));
  assert.ok(!s.takeLease("T-1", "b", 1000));
  t = new Date(t.getTime() + 2000);
  assert.deepEqual(s.expiredLeases(), ["T-1"]);
  assert.ok(s.takeLease("T-1", "b", 1000));
});

test("no SQL outside src/store", () => {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  for (const f of walk("src").filter((f) => !f.includes("/store/"))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /\b(SELECT|INSERT INTO|UPDATE \w+ SET)\b/, f);
  }
});
