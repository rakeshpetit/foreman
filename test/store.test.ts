import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { MIGRATIONS } from "../src/store/schema.ts";
import { Store } from "../src/store/store.ts";
import { closeStores, memoryStore, REPO_ROOT, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);
afterEach(closeStores);

function tmpHome() {
  return tmpDir("foreman-");
}

test("migrates from empty and twice is a no-op", () => {
  const home = tmpHome();
  const a = Store.open(home);
  const r = a.createRequest({ title: "x", target_repo: "/r" });
  a.close();
  const b = Store.open(home);
  assert.equal(b.getRequest(r.id)?.title, "x");
  b.close();
  const raw = new DatabaseSync(join(home, "foreman.db"));
  const v = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, MIGRATIONS.length);
  raw.close();
});

test("the requests table has no status column", () => {
  const home = tmpHome();
  Store.open(home).close();
  const raw = new DatabaseSync(join(home, "foreman.db"));
  const cols = raw.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
  raw.close();
  assert.ok(!cols.some((c) => c.name === "status"));
  assert.ok(cols.some((c) => c.name === "phase"));
});

test("Store.db is private", () => {
  const s = memoryStore();
  // @ts-expect-error db is private to the store
  assert.ok(s.db);
});

test("an unknown Origin, Lane, Approval kind or channel is a type error", () => {
  const s = memoryStore();
  const r = s.createRequest({ title: "a", target_repo: "/r" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  const base = { milestone_id: m.id, seq: 1, title: "t" };
  assert.throws(() => {
    // @ts-expect-error "robot" is not an Origin
    s.createTask({ ...base, origin: "robot" });
  });
  assert.throws(() => {
    // @ts-expect-error "slow" is not a Lane
    s.createTask({ ...base, lane: "slow" });
  });
  assert.throws(() => {
    // @ts-expect-error "wish" is not an Approval kind
    s.createApproval({ kind: "wish", subject_id: r.id });
  });
  assert.throws(() => {
    // @ts-expect-error "fax" is not a Channel
    s.createApproval({ kind: "go", subject_id: r.id, channel: "fax" });
  });
});

test("a stored row with an unknown value throws a clear error when read", () => {
  const home = tmpHome();
  const s = Store.open(home);
  const raw = new DatabaseSync(join(home, "foreman.db"));
  const r = s.createRequest({ title: "a", target_repo: "/r" });
  const m = s.createMilestone({ request_id: r.id, seq: 1, title: "m" });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "t" });
  raw.prepare("UPDATE tasks SET origin = 'robot' WHERE id = ?").run(t.id);
  assert.throws(() => s.getTask(t.id), /tasks T-1: unknown origin "robot"/);
  assert.throws(() => s.listTasks(), /unknown origin/);

  const run = s.createRun({ task_id: t.id, request_id: r.id, stage: "review" });
  raw.prepare("UPDATE runs SET verdict = 'pass' WHERE id = ?").run(run);
  assert.throws(() => s.getRun(run), /runs 1: unknown verdict "pass"/);

  const a = s.createApproval({ kind: "go", subject_id: r.id });
  raw.prepare("UPDATE approvals SET kind = 'wish' WHERE id = ?").run(a.id);
  assert.throws(() => s.getApproval(a.id), /approvals A-1: unknown kind "wish"/);
  raw.close();
  s.close();
});

test("allocates R-n, M-n, T-n ids", () => {
  const s = memoryStore();
  const r1 = s.createRequest({ title: "a", target_repo: "/r" });
  const r2 = s.createRequest({ title: "b", target_repo: "/r" });
  assert.deepEqual([r1.id, r2.id], ["R-1", "R-2"]);
  const m = s.createMilestone({ request_id: r1.id, seq: 1, title: "m" });
  const t = s.createTask({ milestone_id: m.id, seq: 1, title: "t" });
  assert.deepEqual([m.id, t.id], ["M-1", "T-1"]);
});

test("creates and reads every entity", () => {
  const s = memoryStore();
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

  assert.equal(s.isPaused(), false);
  s.setQueueState({ paused: true, paused_until: "2030-01-01", reason: "limit" });
  assert.deepEqual(s.queueState(), { paused: true, paused_until: "2030-01-01", reason: "limit" });
  s.setQueueState({ paused: true, paused_until: null, reason: "owner" });
  assert.equal(s.isPaused(), true);
  s.setQueueState({ paused: false, paused_until: null, reason: null });
  assert.equal(s.isPaused(), false);
});

test("listEvents(n) returns the newest n events, oldest first", () => {
  const s = memoryStore();
  for (let i = 1; i <= 25; i++) s.addEvent("e", `S-${i}`);
  assert.equal(s.listEvents().length, 25);
  const recent = s.listEvents(10);
  assert.equal(recent.length, 10);
  assert.deepEqual(
    recent.map((e) => e.subject),
    Array.from({ length: 10 }, (_, i) => `S-${i + 16}`),
  );
  assert.equal(s.listEvents(100).length, 25);
});

test("leases are exclusive until expiry", () => {
  const s = memoryStore();
  let t = new Date("2026-01-01T00:00:00Z");
  s.now = () => t;
  assert.ok(s.takeLease("T-1", "a", 1000));
  assert.ok(!s.takeLease("T-1", "b", 1000));
  t = new Date(t.getTime() + 2000);
  assert.deepEqual(s.expiredLeases(), ["T-1"]);
  assert.ok(s.takeLease("T-1", "b", 1000));
});

// Statement-shaped and case-sensitive (the store writes SQL in capitals), so prose like "create a Request" or "drop the Task" does not match.
const SQL = new RegExp(
  [
    String.raw`\bSELECT\b[^;]*\bFROM\b`,
    String.raw`\bINSERT\s+(OR\s+\w+\s+)?INTO\b`,
    String.raw`\bUPDATE\s+\w+\s+SET\b`,
    String.raw`\bDELETE\s+FROM\b`,
    String.raw`\bPRAGMA\s+\w+`,
    String.raw`\bCREATE\s+(TEMP(ORARY)?\s+)?(TABLE|INDEX|UNIQUE|VIEW|TRIGGER)\b`,
    String.raw`\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b`,
    String.raw`\bALTER\s+TABLE\b`,
    String.raw`\.prepare\(`,
  ].join("|"),
);

test("the SQL pattern catches statements and ignores prose", () => {
  for (const sql of [
    "SELECT * FROM tasks",
    "DELETE FROM leases WHERE x = 1",
    "PRAGMA user_version",
    "CREATE TABLE t (id)",
    "DROP TABLE t",
    "ALTER TABLE t ADD c",
    "UPDATE tasks SET a = 1",
    "INSERT OR IGNORE INTO t",
    "db.prepare(x)",
  ]) {
    assert.match(sql, SQL, sql);
  }
  for (const prose of [
    "Create a Request and drop the Task",
    "Select a Task, then update the status",
    "alter the plan; delete nothing",
    "prepareWorkdir(repo)",
  ]) {
    assert.doesNotMatch(prose, SQL, prose);
  }
});

test("no SQL outside src/store", () => {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  const src = join(REPO_ROOT, "src");
  for (const f of walk(src).filter((f) => !relative(src, f).startsWith("store/"))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), SQL, f);
  }
});
