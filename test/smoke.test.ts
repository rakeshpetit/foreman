import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runSmoke } from "../src/smoke/smoke.ts";
import { claudeResult, FakeDocker, flagValues } from "./fakes/docker/docker.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function setup() {
  const home = tmpDir("foreman-smoke-home-");
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  const tmp = tmpDir("foreman-smoke-tmp-");
  const docker = new FakeDocker();
  const out: string[] = [];
  return {
    home,
    docker,
    out,
    run: () => runSmoke({ docker, home, user: "501:20", tmp, out: (l) => out.push(l) }),
  };
}

const MODEL = { modelUsage: { "claude-sonnet-5-5": {} } };

/** Plays the Agent: writes `hello.md` and the report into the worktree the container was given. */
function agent(docker: FakeDocker, { hello = true, report = true } = {}) {
  docker.claude = (args) => {
    const work = flagValues(args, "--volume")
      .find((v) => v.endsWith(":/work"))
      ?.slice(0, -":/work".length);
    assert.ok(work);
    if (hello) writeFileSync(join(work, "hello.md"), "hello\n");
    if (report) {
      const file = join(work, ".foreman", "R-1", "runs", "1-implement.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# report");
    }
    return { code: 0, stdout: claudeResult(MODEL), stderr: "" };
  };
}

describe("runSmoke", () => {
  it("builds the images, makes one Run in a container and prints the recorded row", async () => {
    const { docker, out, run } = setup();
    agent(docker);
    const row = await run();
    assert.equal(docker.callsStarting("build").length, 2);
    assert.equal(docker.callsStarting("run", "--rm").length, 1);
    assert.equal(row.verdict, "PASS");
    assert.equal(row.tokens_out, 34);
    const printed = out.join("\n");
    assert.match(printed, /verdict: PASS/);
    assert.match(printed, /tokens_out: 34/);
    assert.match(printed, /hello\.md/);
  });

  it("removes its scratch repo and raw output when it passes", async () => {
    const { docker, out, run } = setup();
    agent(docker);
    await run();
    const repo = /repo: (.+)/.exec(out.join("\n"))?.[1];
    assert.ok(repo);
    assert.equal(existsSync(repo), false);
    assert.doesNotMatch(out.join("\n"), /kept for diagnosis/);
  });

  it("keeps the repo and raw output when it fails, and says where", async () => {
    const { docker, out, run } = setup();
    agent(docker, { hello: false });
    await assert.rejects(run());
    const repo = /repo: (.+)/.exec(out.join("\n"))?.[1];
    assert.ok(repo);
    assert.equal(existsSync(repo), true);
    assert.match(out.join("\n"), new RegExp(`kept for diagnosis: ${repo}`));
  });

  it("fails when the Agent returns a Verdict other than PASS", async () => {
    const { docker, run } = setup();
    agent(docker);
    const pass = docker.claude;
    docker.claude = (args) => {
      pass(args);
      return {
        code: 0,
        stdout: claudeResult({ ...MODEL, structured_output: { verdict: "FAIL" } }),
        stderr: "",
      };
    };
    await assert.rejects(run(), /returned FAIL, not PASS/);
  });

  it("fails when the row is incomplete", async () => {
    const { docker, run } = setup();
    agent(docker);
    const pass = docker.claude;
    docker.claude = (args) => {
      pass(args);
      // No `modelUsage`: the row cannot say which model ran.
      return { code: 0, stdout: claudeResult(), stderr: "" };
    };
    await assert.rejects(run(), /the row has no model/);
  });

  it("fails when the Agent did not write hello.md", async () => {
    const { docker, run } = setup();
    agent(docker, { hello: false });
    await assert.rejects(run(), /hello\.md/);
  });

  it("fails with the Run's error when it leaves no usable result", async () => {
    const { docker, run } = setup();
    docker.claude = () => ({ code: 1, stdout: "", stderr: "boom" });
    await assert.rejects(run(), /boom/);
  });

  it("names the missing token file", async () => {
    const { docker } = setup();
    const empty = tmpDir("foreman-smoke-empty-");
    await assert.rejects(runSmoke({ docker, home: empty, out: () => {} }), /claude setup-token/);
  });
});
