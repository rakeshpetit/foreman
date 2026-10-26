import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importPlan } from "../src/importer/import.ts";
import { ImportError, parseTasks } from "../src/importer/parse.ts";
import { Store } from "../src/store/store.ts";

test("imports this repo's docs/plan/TASKS.md", () => {
  const store = Store.memory();
  const repo = mkdtempSync(join(tmpdir(), "target-"));
  const res = importPlan(store, repo, "docs/plan");
  assert.equal(res.requestId, "R-1");
  assert.ok(res.milestones >= 8);
  assert.ok(res.tasks > 50);

  const tasks = store.listTasks();
  assert.equal(tasks.length, res.tasks);
  assert.ok(tasks.every((t) => t.origin === "planned"));
  const t = tasks.find((x) => x.ref === "M1-T07");
  assert.ok(t);
  assert.equal(t.kind, "cli");
  assert.equal(t.size_est, "M");
  const deps = store.dependenciesOf(t.id);
  assert.equal(deps.length, 3);
  const none = tasks.find((x) => x.ref === "M0-T01");
  assert.ok(none);
  assert.deepEqual(store.dependenciesOf(none.id), []);

  assert.ok(existsSync(join(repo, ".foreman", "R-1", "plan.md")));
  const file = readFileSync(join(repo, ".foreman", "R-1", "tasks", `${t.id}.md`), "utf8");
  assert.match(file, /^### M1-T07 · CLI skeleton/);
  assert.match(file, /Done when/);
});

const sample = (extra: string) => `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** x
${extra}`;

test("unknown dependency fails with the line number", () => {
  const text = sample(`### M1-T02 · B
- **Kind:** core · **Size:** S · **Depends:** M1-T09
`);
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 6 && /unknown task M1-T09/.test(e.message),
  );
});

test("duplicate ID fails with the line number", () => {
  const text = sample(`### M1-T01 · B
- **Kind:** core · **Size:** S · **Depends:** none
`);
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 5 && /duplicate/.test(e.message),
  );
});

test("a failed import writes nothing", () => {
  const store = Store.memory();
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  assert.throws(() => importPlan(store, dir, dir));
  assert.equal(store.listRequests().length, 0);
});
