import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type ImportFs, importPlan } from "../src/importer/import.ts";
import { ImportError, parseTasks } from "../src/importer/parse.ts";
import { Store } from "../src/store/store.ts";
import { FIXTURE_PLAN, REPO_ROOT, removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

test("imports the fixture plan: milestones, tasks, kinds, sizes, dependencies and files", () => {
  const store = Store.memory();
  const repo = tmpDir("target-");
  const res = importPlan(store, repo, FIXTURE_PLAN);
  assert.deepEqual(res, { requestId: "R-1", milestones: 2, tasks: 4 });

  const tasks = store.listTasks();
  assert.equal(tasks.length, res.tasks);
  assert.ok(tasks.every((t) => t.origin === "planned"));
  const ref = (r: string) => {
    const t = tasks.find((x) => x.ref === r);
    assert.ok(t, r);
    return t;
  };
  const beta = ref("M1-T02");
  assert.equal(beta.kind, "cli");
  assert.equal(beta.size_est, "M");
  assert.deepEqual(store.dependenciesOf(beta.id), [ref("M1-T01").id]);
  assert.deepEqual(store.dependenciesOf(ref("M1-T01").id), []);
  assert.equal(store.dependenciesOf(ref("M2-T02").id).length, 2);

  assert.ok(existsSync(join(repo, ".foreman", "R-1", "plan.md")));
  const file = readFileSync(join(repo, ".foreman", "R-1", "tasks", `${beta.id}.md`), "utf8");
  assert.match(file, /^### M1-T02 · Beta/);
  assert.match(file, /Done when/);
});

test("this repo's docs/plan/TASKS.md imports cleanly (M1-T02)", () => {
  const store = Store.memory();
  assert.equal(
    importPlan(store, tmpDir("target-"), join(REPO_ROOT, "docs", "plan")).requestId,
    "R-1",
  );
});

const sample = (extra: string) => `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** x
- **Done when:** x works
${extra}`;

test("unknown dependency fails with the line number", () => {
  const text = sample(`### M1-T02 · B
- **Kind:** core · **Size:** S · **Depends:** M1-T09
- **Do:** y
- **Done when:** y works
`);
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 7 && /unknown task M1-T09/.test(e.message),
  );
});

test("parses Do and Done when, including multi-line and Do (you)", () => {
  const plan = parseTasks(`## M1 · One
### M1-T01 · A
- **Kind:** owner · **Size:** S · **Depends:** none
- **Do (you):** click it
- **Done when:**
  - first
  - second
`);
  const t = plan.milestones[0]?.tasks[0];
  assert.equal(t?.size_est, "S");
  assert.equal(t?.do, "click it");
  assert.match(t?.doneWhen ?? "", /^\n {2}- first\n {2}- second/);
});

test("a task with no Do fails with its heading line", () => {
  const text = `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Done when:** x
`;
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 2 && /M1-T01 has no Do/.test(e.message),
  );
});

test("a task with no Done when fails with its heading line", () => {
  const text = `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** x
### M1-T02 · B
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** y
- **Done when:**
`;
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 2 && /M1-T01 has no Done when/.test(e.message),
  );
  assert.throws(
    () => parseTasks(text.replace("- **Do:** x\n", "- **Do:** x\n- **Done when:** ok\n")),
    (e) => e instanceof ImportError && e.line === 6 && /M1-T02 has no Done when/.test(e.message),
  );
});

test("a duplicate Milestone ID fails with the line number", () => {
  const text = `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** x
- **Done when:** x works
## M1 · Again
`;
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 6 && /duplicate milestone ID M1/.test(e.message),
  );
});

test("duplicate ID fails with the line number", () => {
  const text = sample(`### M1-T01 · B
- **Kind:** core · **Size:** S · **Depends:** none
`);
  assert.throws(
    () => parseTasks(text),
    (e) => e instanceof ImportError && e.line === 6 && /duplicate task/.test(e.message),
  );
});

test("a failed import writes nothing", () => {
  const store = Store.memory();
  const dir = tmpDir("plan-");
  assert.throws(() => importPlan(store, dir, dir));
  assert.equal(store.listRequests().length, 0);
});

const failingFs = (op: keyof ImportFs): ImportFs => ({
  ...nodeFs,
  [op]: () => {
    throw new Error(`${op} failed`);
  },
});

/** What a failed import left behind: `null` when it never created `.foreman/` at all. */
const ls = (repo: string) =>
  existsSync(join(repo, ".foreman")) ? readdirSync(join(repo, ".foreman")) : null;

test("a file write that fails leaves no Request rows and no files", () => {
  const store = Store.memory();
  const repo = tmpDir("target-");
  for (const op of ["writeFileSync", "renameSync"] as const) {
    assert.throws(
      () => importPlan(store, repo, FIXTURE_PLAN, failingFs(op)),
      new RegExp(`${op} failed`),
    );
    assert.deepEqual(store.listRequests(), []);
    assert.equal(ls(repo), null);
  }
});

test("a transaction that fails after the files are in place leaves no files", () => {
  class FailsAtCommit extends Store {
    armed = false;
    override transaction<T>(fn: () => T): T {
      return super.transaction(() => {
        const out = fn();
        if (this.armed) throw new Error("commit failed");
        return out;
      });
    }
  }
  const store = new FailsAtCommit(":memory:");
  store.armed = true;
  const repo = tmpDir("target-");
  assert.throws(() => importPlan(store, repo, FIXTURE_PLAN), /commit failed/);
  assert.deepEqual(store.listRequests(), []);
  assert.equal(ls(repo), null);
});

test("a failed import keeps a .foreman/ that was already there, with its contents", () => {
  const store = Store.memory();
  const repo = tmpDir("target-");
  nodeFs.mkdirSync(join(repo, ".foreman"));
  nodeFs.writeFileSync(join(repo, ".foreman", "config.toml"), 'check = "npm run check"\n');
  assert.throws(() => importPlan(store, repo, FIXTURE_PLAN, failingFs("renameSync")));
  assert.deepEqual(ls(repo), ["config.toml"]);
});

test("a Task's file_path comes from its own ID", () => {
  const store = Store.memory();
  const repo = tmpDir("target-");
  importPlan(store, repo, FIXTURE_PLAN);
  for (const t of store.listTasks()) {
    assert.equal(t.file_path, join(".foreman", "R-1", "tasks", `${t.id}.md`));
    assert.equal(t.stage, "workup");
  }
});
