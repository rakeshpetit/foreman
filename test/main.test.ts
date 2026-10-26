import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { main, version } from "../src/cli/main.ts";
import type { Docker } from "../src/docker/docker.ts";
import { Store } from "../src/store/store.ts";
import { claudeResult, FakeDocker, flagValues } from "./fakes/docker/docker.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

test("version reads package.json", () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
});

function cli(foremanDir?: string, docker?: Docker) {
  const root = tmpDir("foreman-cli-");
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
- **Done when:** x works.
### M1-T02 · B
- **Kind:** core · **Size:** S · **Depends:** M1-T01
- **Do:** y
- **Done when:** y works.
`,
  );
  const fake = join(root, "fake.json");
  writeFileSync(fake, "{}");
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    main(argv, {
      env: { FOREMAN_HOME: home },
      cwd: root,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      foremanDir,
      docker,
    });
  return { root, home, plan, fake, out, err, run };
}

test("--help lists the commands", async () => {
  const { run, out } = cli();
  assert.equal(await run("--help"), 0);
  for (const c of ["import", "go", "run", "config", "images", "status", "pause", "resume"]) {
    assert.match(out.join("\n"), new RegExp(`^  ${c}\\b`, "m"));
  }
});

test("unknown command fails", async () => {
  const { run, err } = cli();
  assert.equal(await run("nope"), 1);
  assert.match(err[0] ?? "", /Unknown command: nope/);
});

test("an unknown command, no command and --help create nothing in FOREMAN_HOME", async () => {
  const { run, home } = cli();
  assert.equal(await run("bogus"), 1);
  assert.equal(await run(), 0);
  assert.equal(await run("--help"), 0);
  assert.equal(existsSync(home), false);
});

test("import of a TASKS.md with an unknown dependency prints one 'line N:' line and no stack", async () => {
  const { run, err, plan, root } = cli();
  writeFileSync(
    join(plan, "TASKS.md"),
    `## M1 · One
### M1-T01 · A
- **Kind:** core · **Size:** S · **Depends:** M1-T99
- **Do:** x
- **Done when:** x works.
`,
  );
  assert.equal(await run("import", root, plan), 1);
  assert.deepEqual(err, ["line 3: task M1-T01 depends on unknown task M1-T99"]);
});

test("import of a missing plan directory fails in one line with no stack", async () => {
  const { run, err, root } = cli();
  assert.equal(await run("import", root, join(root, "nowhere")), 1);
  assert.equal(err.length, 1);
  assert.match(err[0] ?? "", /ENOENT/);
  assert.doesNotMatch(err[0] ?? "", /\n\s+at /);
});

test("an unexpected error prints its stack and exits non-zero", async () => {
  const { run, err, root } = cli();
  const file = join(root, "not-a-dir");
  writeFileSync(file, "");
  const code = await main(["status"], {
    env: { FOREMAN_HOME: file },
    cwd: root,
    out: () => {},
    err: (l) => err.push(l),
  });
  assert.notEqual(code, 0);
  assert.match(err.join("\n"), /\n\s+at /);
  assert.equal(await run("bogus"), 1);
});

test("import creates a Request", async () => {
  const { run, out, plan, root } = cli();
  assert.equal(await run("import", root, plan), 0);
  assert.match(out[0] ?? "", /Imported R-1: 1 milestones, 2 tasks/);
});

test("import with a missing argument prints usage and imports nothing", async () => {
  const { run, err, plan, root } = cli();
  assert.equal(await run("import"), 1);
  assert.equal(await run("import", root), 1);
  assert.equal(await run("import", root, plan, "extra"), 1);
  assert.equal(err.length, 3);
  for (const e of err) assert.match(e, /Usage: foreman import <target-repo> <plan-dir>/);
  assert.equal(await run("go", "R-1"), 1);
  assert.match(err.at(-1) ?? "", /Unknown request: R-1/);
});

test("go approves and moves the Request to building; rejects unknown or repeated", async () => {
  const { run, plan, root, err } = cli();
  await run("import", root, plan);
  assert.equal(await run("go", "R-9"), 1);
  assert.equal(await run("go", "R-1"), 0);
  assert.equal(await run("go", "R-1"), 1);
  assert.match(err.join("\n"), /R-9/);
  assert.match(err.join("\n"), /already building/);
  await run("status");
});

test("run --until-idle finishes Tasks, writes STATUS.md; without go nothing runs", async () => {
  const { run, plan, root, out, home, fake } = cli();
  await run("import", root, plan);
  await run("run", "--until-idle", "--fake", fake);
  assert.equal(out.at(-1), "Ran 0 stages");
  await run("go", "R-1");
  assert.equal(await run("run", "--until-idle", "--fake", fake), 0);
  // 2 Tasks x the 9 Stages of the default Pipeline.
  assert.equal(out.at(-1), "Ran 18 stages");
  assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /Phase: done/);
});

test("run without --until-idle runs one tick", async () => {
  const { run, plan, root, out, fake } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  await run("run", "--fake", fake);
  assert.equal(out.at(-1), "Ran 1 stage");
});

test("pause and resume toggle the queue, shown by status", async () => {
  const { run, out, plan, root, fake } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  assert.equal(await run("pause"), 0);
  await run("run", "--until-idle", "--fake", fake);
  assert.equal(out.at(-1), "Ran 0 stages");
  await run("status");
  assert.match(out.at(-1) ?? "", /Queue:\*\* paused/);
  assert.equal(await run("resume"), 0);
  await run("run", "--fake", fake);
  assert.equal(out.at(-1), "Ran 1 stage");
});

test("resume clears a timed pause as well as an owner pause", async () => {
  const { run, out, home } = cli();
  assert.equal(await run("pause"), 0);
  await run("status");
  assert.match(out.at(-1) ?? "", /Queue:\*\* paused \(until resumed\)/);
  assert.equal(await run("resume"), 0);

  const store = Store.open(home);
  store.setQueueState({ paused: true, paused_until: "2999-01-01T00:00:00Z", reason: "limit" });
  store.close();
  await run("status");
  assert.match(out.at(-1) ?? "", /Queue:\*\* paused until 2999-01-01T00:00:00Z \(limit\)/);
  assert.equal(await run("resume"), 0);
  await run("status");
  assert.match(out.at(-1) ?? "", /Queue:\*\* running/);
});

/** Everything `run` could change in the Store. */
function snapshot(home: string) {
  const store = Store.open(home);
  try {
    return {
      tasks: store.listTasks(),
      runs: store.listRuns(),
      events: store.listEvents(),
      queue: store.queueState(),
    };
  } finally {
    store.close();
  }
}

test("run without --fake and without claude.env refuses, naming the file and `claude setup-token`", async () => {
  const docker = new FakeDocker();
  const { run, plan, root, home, err } = cli(undefined, docker);
  await run("import", root, plan);
  await run("go", "R-1");
  const before = snapshot(home);
  assert.equal(await run("run", "--until-idle"), 1);
  assert.match(err.at(-1) ?? "", new RegExp(`${join(home, "claude.env")}.*claude setup-token`));
  assert.deepEqual(snapshot(home), before);
  assert.ok(before.tasks.every((t) => t.status === "queued"));
  assert.equal(docker.callsStarting("run").length, 0);
});

test("run without --fake refuses when the Docker daemon is not running", async () => {
  const docker = new FakeDocker();
  docker.daemonDown = true;
  const { run, plan, root, home, err } = cli(undefined, docker);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  await run("import", root, plan);
  await run("go", "R-1");
  const before = snapshot(home);
  assert.equal(await run("run", "--until-idle"), 1);
  assert.match(err.at(-1) ?? "", /Docker daemon is not running/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(docker.callsStarting("run").length, 0);
});

test("run without --fake refuses when docker is not installed", async () => {
  const missing: Docker = {
    run: () => Promise.reject(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })),
  };
  const { run, plan, root, home, err } = cli(undefined, missing);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  await run("import", root, plan);
  await run("go", "R-1");
  const before = snapshot(home);
  assert.equal(await run("run", "--until-idle"), 1);
  assert.match(err.at(-1) ?? "", /docker is not installed/);
  assert.deepEqual(snapshot(home), before);
});

test("run without --fake builds a ContainerRunner and takes a Task through an agent Stage", async () => {
  const docker = new FakeDocker();
  docker.claude = (args) => {
    // The Agent leaves its report where its prompt says, under the worktree it has mounted.
    const workdir = flagValues(args, "--volume")
      .find((v) => v.endsWith(":/work"))
      ?.slice(0, -":/work".length);
    const report = args.join("\n").match(/\/work\/(\.foreman\/R-1\/runs\/\d+-\w+\.md)/)?.[1];
    assert.ok(workdir && report);
    mkdirSync(dirname(join(workdir, report)), { recursive: true });
    writeFileSync(join(workdir, report), "# report");
    return { code: 0, stdout: claudeResult(), stderr: "" };
  };
  const { run, plan, root, home, out } = cli(undefined, docker);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  await run("import", root, plan);
  await run("go", "R-1");
  assert.equal(await run("run"), 0);
  assert.equal(out.at(-1), "Ran 1 stage");

  assert.equal(docker.callsStarting("run", "--rm").length, 1);
  const { runs, tasks } = snapshot(home);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.stage, "workup");
  assert.equal(runs[0]?.verdict, "PASS");
  assert.equal(runs[0]?.exit_code, 0);
  assert.equal(tasks[0]?.status, "active");
  assert.notEqual(tasks[0]?.stage, "workup");
});

test("run --fake <script> plays the script through FakeRunner", async () => {
  const { run, plan, root, home, fake } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  writeFileSync(fake, JSON.stringify({ review: [{ verdict: "FAIL" }] }));
  assert.equal(await run("run", "--until-idle", "--fake", fake), 0);

  const store = Store.open(home);
  try {
    const tasks = store.listTasks();
    assert.ok(tasks.every((t) => t.status === "done"));
    assert.equal(
      tasks.reduce((n, t) => n + t.round_total, 0),
      1,
    );
  } finally {
    store.close();
  }
});

test("run --fake with a missing script fails and leaves every Task queued", async () => {
  const { run, plan, root, home, err } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  assert.equal(await run("run", "--fake", join(root, "missing.json")), 1);
  assert.match(err.at(-1) ?? "", /Cannot read --fake script/);

  const store = Store.open(home);
  try {
    assert.ok(store.listTasks().every((t) => t.status === "queued"));
  } finally {
    store.close();
  }
});

test("run --fake with an unknown Verdict or Stage or Agent fails and leaves every Task queued", async () => {
  const { run, plan, root, home, err, fake } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  for (const [script, why] of [
    [{ review: [{ verdict: "pass" }] }, /verdict must be one of PASS, FAIL, BLOCKED, SCOPE_CHANGE/],
    [{ deploy: [] }, /unknown stage or agent "deploy"/],
  ] as const) {
    writeFileSync(fake, JSON.stringify(script));
    assert.equal(await run("run", "--until-idle", "--fake", fake), 1);
    assert.match(err.at(-1) ?? "", why);
  }

  const store = Store.open(home);
  try {
    assert.ok(store.listTasks().every((t) => t.status === "queued"));
  } finally {
    store.close();
  }
});

test("run with a Runner that throws exits non-zero, notifies once, rewrites STATUS.md and leaves the Task queued", async () => {
  const { root, home, plan, run, err } = cli();
  await run("import", root, plan);
  await run("go", "R-1");
  const sent: string[] = [];
  const code = await main(["run", "--until-idle"], {
    env: { FOREMAN_HOME: home },
    cwd: root,
    out: () => {},
    err: (l) => err.push(l),
    runner: {
      run: async () => {
        throw new Error("runner exploded");
      },
    },
    notifier: { send: async (n) => void sent.push(n.title) },
  });
  assert.equal(code, 1);
  assert.match(err.at(-1) ?? "", /runner exploded/);
  assert.deepEqual(sent, ["Foreman engine error"]);
  assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /stage\.crashed/);

  const store = Store.open(home);
  try {
    assert.ok(store.listTasks().every((t) => t.status === "queued"));
    assert.equal(store.listEvents().filter((e) => e.type === "stage.crashed").length, 1);
  } finally {
    store.close();
  }
});

test("every state-changing command rewrites STATUS.md straight away", async () => {
  const { run, plan, root, home } = cli();
  const statusFile = () => readFileSync(join(home, "STATUS.md"), "utf8");

  await run("import", root, plan);
  assert.match(statusFile(), /### R-1 · /);
  assert.match(statusFile(), /Phase: planning/);

  await run("go", "R-1");
  assert.match(statusFile(), /Phase: building/);
  assert.match(statusFile(), /request\.go R-1/);

  await run("pause");
  assert.match(statusFile(), /Queue:\*\* paused/);

  await run("resume");
  assert.match(statusFile(), /Queue:\*\* running/);
});

test("config show prints the resolved config with the source of each key", async () => {
  const { run, plan, root, home, out, err } = cli();
  mkdirSync(join(root, ".foreman"));
  writeFileSync(
    join(root, ".foreman", "config.toml"),
    'check = "npm test"\n[breaker]\nper_task = 9\n',
  );
  await run("import", root, plan);
  const store = Store.open(home);
  try {
    store.updateTask("T-1", { agent_overrides: JSON.stringify({ review: ["reviewer-spec"] }) });
  } finally {
    store.close();
  }

  out.length = 0;
  assert.equal(await run("config", "show", "R-1"), 0);
  const text = out.join("\n");
  assert.match(text, /^mode\s+= "manual"\s+\(request R-1\)$/m);
  assert.match(text, /^check\s+= "npm test"\s+\(target\)$/m);
  assert.match(text, /^breaker\.per_task\s+= 9\s+\(target\)$/m);
  assert.match(text, /^breaker\.per_stage\s+= 3\s+\(default\)$/m);
  assert.doesNotMatch(text, /task\.T-1/);

  out.length = 0;
  assert.equal(await run("config", "show", "R-1", "--task", "T-1"), 0);
  assert.match(
    out.join("\n"),
    /^task\.T-1\.agents\.review\s+= \["reviewer-spec"\]\s+\(request R-1\)$/m,
  );

  assert.equal(await run("config", "show", "R-9"), 1);
  assert.match(err.at(-1) ?? "", /Unknown request: R-9/);
  assert.equal(await run("config", "show", "R-1", "--task", "T-99"), 1);
  assert.match(err.at(-1) ?? "", /T-99 is not a task of R-1/);
  assert.equal(await run("config"), 1);
  assert.match(err.at(-1) ?? "", /Usage: foreman config show/);
});

test("config show names the file of a broken Target repo config", async () => {
  const { run, plan, root, err } = cli();
  mkdirSync(join(root, ".foreman"));
  writeFileSync(join(root, ".foreman", "config.toml"), "breaker = [");
  await run("import", root, plan);
  assert.equal(await run("config", "show", "R-1"), 1);
  assert.match(err.at(-1) ?? "", /\.foreman\/config\.toml: not valid TOML/);
});

test("run refuses to start when foreman's defaults/pipeline.toml is broken, naming the error", async () => {
  const foremanDir = tmpDir("foreman-broken-");
  mkdirSync(join(foremanDir, "defaults"));
  writeFileSync(join(foremanDir, "defaults", "pipeline.toml"), "[[stages]\nname = \n");
  const { run, plan, root, err, fake, home } = cli(foremanDir);
  await run("import", root, plan);
  await run("go", "R-1");
  assert.equal(await run("run", "--until-idle", "--fake", fake), 1);
  assert.match(err.join("\n"), /defaults\/pipeline\.toml: not valid TOML/);
  const store = Store.open(home);
  try {
    assert.ok(store.listTasks().every((t) => t.status === "queued"));
    assert.equal(store.listRuns().length, 0);
  } finally {
    store.close();
  }
});

function imagesCli(docker: FakeDocker) {
  const { root, home } = cli();
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    main(argv, {
      env: { FOREMAN_HOME: home },
      cwd: root,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      docker,
    });
  return { run, out, err };
}

test("images build builds both images through docker and reports each", async () => {
  const docker = new FakeDocker();
  const { run, out } = imagesCli(docker);
  assert.equal(await run("images", "build"), 0);
  assert.deepEqual(out, ["Built foreman-base", "Built foreman-egress-proxy"]);
  assert.equal(docker.callsStarting("build").length, 2);
});

test("images build with a failing docker build prints one line and exits 1", async () => {
  const docker = new FakeDocker();
  docker.failOn = { prefix: ["build"], stderr: "boom" };
  const { run, err } = imagesCli(docker);
  assert.equal(await run("images", "build"), 1);
  assert.equal(err.length, 1);
  assert.match(err[0] ?? "", /docker build failed.*boom/s);
});

test("images with anything but build prints usage", async () => {
  const { run, err } = imagesCli(new FakeDocker());
  assert.equal(await run("images"), 1);
  assert.match(err[0] ?? "", /Usage: foreman images build/);
});
