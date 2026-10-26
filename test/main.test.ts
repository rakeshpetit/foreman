import assert from "node:assert/strict";
import { test } from "node:test";
import { version } from "../src/cli/main.ts";

test("version reads package.json", () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/main.ts";

function cli() {
  const root = mkdtempSync(join(tmpdir(), "foreman-cli-"));
  const home = join(root, "home");
  const plan = join(root, "plan");
  mkdirSync(plan);
  writeFileSync(join(plan, "PLAN.md"), "# Tiny plan\n");
  writeFileSync(
    join(plan, "TASKS.md"),
    `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** x
### M1-T02 · B
- **Kind:** core · **Size:** S · **Depends:** M1-T01
- **Do:** y
`,
  );
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    main(argv, {
      env: { FOREMAN_HOME: home },
      cwd: root,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { root, home, plan, out, err, run };
}

test("--help lists the commands", async () => {
  const { run, out } = cli();
  assert.equal(await run("--help"), 0);
  for (const c of ["import", "go", "run", "status", "pause", "resume"]) {
    assert.match(out.join("\n"), new RegExp(`^  ${c}\\b`, "m"));
  }
});

test("unknown command fails", async () => {
  const { run, err } = cli();
  assert.equal(await run("nope"), 1);
  assert.match(err[0] ?? "", /Unknown command: nope/);
});

test("import creates a Request", async () => {
  const { run, out, plan, root } = cli();
  assert.equal(await run("import", plan, "--repo", root), 0);
  assert.match(out[0] ?? "", /Imported R-1: 1 milestones, 2 tasks/);
});

test("go approves and moves the Request to building; rejects unknown or repeated", async () => {
  const { run, plan, root, err } = cli();
  await run("import", plan, "--repo", root);
  assert.equal(await run("go", "R-9"), 1);
  assert.equal(await run("go", "R-1"), 0);
  assert.equal(await run("go", "R-1"), 1);
  assert.match(err.join("\n"), /R-9/);
  assert.match(err.join("\n"), /already building/);
  await run("status");
});

test("run --until-idle finishes Tasks, writes STATUS.md; without go nothing runs", async () => {
  const { run, plan, root, out, home } = cli();
  await run("import", plan, "--repo", root);
  await run("run", "--until-idle");
  assert.equal(out.at(-1), "Ran 0 stages");
  await run("go", "R-1");
  assert.equal(await run("run", "--until-idle"), 0);
  assert.equal(out.at(-1), "Ran 6 stages");
  assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /Phase: done/);
});

test("run without --until-idle runs one tick", async () => {
  const { run, plan, root, out } = cli();
  await run("import", plan, "--repo", root);
  await run("go", "R-1");
  await run("run");
  assert.equal(out.at(-1), "Ran 1 stage");
});

test("pause and resume toggle the queue, shown by status", async () => {
  const { run, out, plan, root } = cli();
  await run("import", plan, "--repo", root);
  await run("go", "R-1");
  assert.equal(await run("pause"), 0);
  await run("run", "--until-idle");
  assert.equal(out.at(-1), "Ran 0 stages");
  await run("status");
  assert.match(out.at(-1) ?? "", /Queue:\*\* paused/);
  assert.equal(await run("resume"), 0);
  await run("run");
  assert.equal(out.at(-1), "Ran 1 stage");
});
