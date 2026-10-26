import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ContainerRunner } from "../src/runner/container.ts";
import { verdictSchema } from "../src/runner/prompt.ts";
import { RunFailure, type RunSpec } from "../src/runner/runner.ts";
import { claudeResult, FakeDocker, flagValue, flagValues } from "./fakes/docker/docker.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function setup(opts: Partial<ConstructorParameters<typeof ContainerRunner>[0]> = {}) {
  const home = tmpDir("foreman-home-");
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  const workdir = tmpDir("foreman-work-");
  const docker = new FakeDocker();
  const runner = new ContainerRunner({ docker, home, user: "501:20", ...opts });
  return { home, workdir, docker, runner };
}

function spec(workdir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 7,
    task: "T-1",
    stage: "implement",
    agent: "implementer",
    workdir,
    reportPath: join(workdir, ".foreman", "R-1", "runs", "7-implement.md"),
    systemPrompt: `You are the implementer. Report to ${join(workdir, ".foreman", "R-1", "runs", "7-implement.md")}.\n`,
    userPrompt: `# T-1\n\n- Task file: \`${join(workdir, ".foreman", "R-1", "tasks", "T-1.md")}\`\n`,
    verdictSchema: verdictSchema(["PASS", "FAIL"]),
    skills: [],
    ...overrides,
  };
}

/** The one Agent container the Runner started. */
function agentRun(docker: FakeDocker): string[] {
  const runs = docker.calls.filter((c) => c[0] === "run" && c.includes("--rm"));
  assert.equal(runs.length, 1);
  return runs[0] as string[];
}

describe("ContainerRunner", () => {
  it("runs one container and turns Claude's result into a RunResult", async () => {
    const { workdir, docker, runner } = setup();
    const s = spec(workdir);
    const result = await runner.run(s);
    assert.deepEqual(result, {
      verdict: "PASS",
      reportPath: s.reportPath,
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
        context_peak: null,
        cost_usd: 0.01,
      },
      raw: claudeResult(),
    });
    assert.equal(docker.callsStarting("run", "--rm").length, 1);
  });

  it("reads every usage figure, the model and the raw output from a real result", async () => {
    const { workdir, docker, runner } = setup();
    const raw = readFileSync(join(import.meta.dirname, "fixtures/claude/result.json"), "utf8");
    docker.claude = () => ({ code: 0, stdout: raw, stderr: "" });
    const result = await runner.run(spec(workdir));
    assert.deepEqual(result.usage, {
      input_tokens: 9,
      output_tokens: 410,
      cache_read_input_tokens: 12000,
      cache_creation_input_tokens: 3500,
      // The fullest context of any turn: input + cache read + cache write of the second.
      context_peak: 6 + 11351 + 137,
      cost_usd: 0.0412,
    });
    assert.equal(result.model, "claude-sonnet-5-5");
    assert.equal(result.raw, raw);
  });

  it("starts the container labelled, on the egress network, as the host user, with the token and proxy", async () => {
    const { home, workdir, docker, runner } = setup();
    await runner.run(spec(workdir));
    const args = agentRun(docker);
    assert.equal(flagValue(args, "--label"), "foreman.run=7");
    assert.equal(flagValue(args, "--name"), "foreman-run-7");
    assert.equal(flagValue(args, "--network"), "foreman-agents");
    assert.equal(flagValue(args, "--user"), "501:20");
    assert.equal(flagValue(args, "--env-file"), join(home, "claude.env"));
    assert.equal(flagValue(args, "--workdir"), "/work");
    assert.deepEqual(flagValues(args, "--volume"), [`${workdir}:/work`]);
    const env = flagValues(args, "--env");
    assert.ok(env.includes("HTTPS_PROXY=http://proxy:8888"));
    assert.ok(env.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"));
    assert.ok(args.includes("foreman-base"));
    // The token never appears on the command line.
    assert.ok(!args.join(" ").includes("sk-test"));
  });

  it("makes the egress network and proxy ready before the container starts", async () => {
    const { workdir, docker, runner } = setup();
    await runner.run(spec(workdir));
    const runIndex = docker.calls.findIndex((c) => c.includes("--rm"));
    const proxyIndex = docker.calls.findIndex((c) => c.includes("--detach"));
    assert.ok(proxyIndex >= 0 && proxyIndex < runIndex);
  });

  it("launches claude with the prompts, the Verdict schema and the Agent's settings", async () => {
    const { workdir, docker, runner } = setup();
    const s = spec(workdir, { model: "opus", effort: "high", tools: ["Read", "Edit"] });
    await runner.run(s);
    const args = agentRun(docker);
    const claude = args.slice(args.indexOf("claude"));
    assert.deepEqual(claude.slice(0, 2), ["claude", "-p"]);
    assert.ok(claude.includes("--dangerously-skip-permissions"));
    assert.equal(flagValue(claude, "--output-format"), "json");
    assert.deepEqual(JSON.parse(flagValue(claude, "--json-schema") ?? ""), s.verdictSchema);
    assert.equal(flagValue(claude, "--model"), "opus");
    assert.equal(flagValue(claude, "--effort"), "high");
    assert.equal(flagValue(claude, "--tools"), "Read,Edit");
  });

  it("omits the settings the Agent does not set", async () => {
    const { workdir, docker, runner } = setup();
    await runner.run(spec(workdir));
    const claude = agentRun(docker);
    for (const flag of ["--model", "--effort", "--tools"]) assert.ok(!claude.includes(flag), flag);
  });

  it("shows the Agent its files at /work, not at the host path", async () => {
    const { workdir, docker, runner } = setup();
    await runner.run(spec(workdir));
    const claude = agentRun(docker);
    const system = flagValue(claude, "--append-system-prompt") ?? "";
    assert.equal(
      system,
      "You are the implementer. Report to /work/.foreman/R-1/runs/7-implement.md.\n",
    );
    assert.ok(claude[claude.indexOf("-p") + 1]?.includes("`/work/.foreman/R-1/tasks/T-1.md`"));
    assert.ok(!system.includes(workdir));
    assert.ok(!claude.slice(claude.indexOf("claude")).join("\n").includes(workdir));
  });

  it("copies the Skills into a read-only mount for the Run and removes the copy after", async () => {
    const { home, workdir, docker, runner } = setup();
    const skills = tmpDir("foreman-skills-");
    mkdirSync(join(skills, "tdd"));
    writeFileSync(join(skills, "tdd", "SKILL.md"), "tdd skill");
    mkdirSync(join(skills, "diagnose"));
    writeFileSync(join(skills, "diagnose", "SKILL.md"), "diagnose skill");
    let staged = "";
    docker.claude = (args) => {
      const mount = flagValues(args, "--volume").find((v) =>
        v.endsWith(":/home/agent/.claude/skills:ro"),
      );
      assert.ok(mount);
      staged = mount.split(":")[0] as string;
      assert.ok(staged.startsWith(home));
      assert.equal(readFileSync(join(staged, "tdd", "SKILL.md"), "utf8"), "tdd skill");
      assert.equal(readFileSync(join(staged, "diagnose", "SKILL.md"), "utf8"), "diagnose skill");
      return { code: 0, stdout: claudeResult(), stderr: "" };
    };
    await runner.run(
      spec(workdir, {
        skills: [
          { name: "tdd", dir: join(skills, "tdd") },
          { name: "diagnose", dir: join(skills, "diagnose") },
        ],
      }),
    );
    assert.ok(staged);
    assert.ok(!existsSync(staged));
  });

  it("gives Claude a home it can write to, as the host user", async () => {
    const { workdir, docker, runner } = setup();
    await runner.run(spec(workdir));
    const args = agentRun(docker);
    assert.ok(flagValues(args, "--env").includes("HOME=/home/agent"));
    assert.deepEqual(flagValues(args, "--tmpfs"), [
      "/home/agent:rw,uid=501,gid=20,mode=700",
      "/home/agent/.claude:rw,uid=501,gid=20,mode=700",
    ]);
  });

  it("kills the container and fails with `timeout` when the Run outlasts its limit", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = (args) => docker.untilKilled(args);
    await assert.rejects(
      runner.run(spec(workdir, { timeoutMs: 20 })),
      (e) => e instanceof RunFailure && e.kind === "timeout" && /20 ms|timed out/.test(e.message),
    );
    assert.deepEqual(docker.callsStarting("kill"), [["kill", "foreman-run-7"]]);
  });

  it("does not kill a Run that finishes in time", async () => {
    const { workdir, docker, runner } = setup();
    await runner.run(spec(workdir, { timeoutMs: 5_000 }));
    assert.deepEqual(docker.callsStarting("kill"), []);
  });

  it("fails with `failed` on a non-zero exit, with the tail of stderr", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({ code: 125, stdout: "", stderr: "line1\ndocker: no such image\n" });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "failed" &&
        /exited 125.*no such image/s.test(e.message),
    );
  });

  it("names Claude's own error when it exits non-zero with one", async () => {
    const { workdir, docker, runner } = setup();
    const stdout = claudeResult({
      is_error: true,
      subtype: "success",
      result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      api_error_status: 401,
      structured_output: undefined,
      usage: {},
    });
    docker.claude = () => ({ code: 1, stdout, stderr: "" });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "auth" &&
        e.message.includes("401 OAuth access token is invalid") &&
        e.stdout === stdout,
    );
  });

  it("fails with `auth` when Claude says it is not logged in, even with a zero exit", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({
        is_error: true,
        result: "Not logged in · Please run /login",
        structured_output: undefined,
      }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "auth" && /Not logged in/.test(e.message),
    );
  });

  it("fails with `failed`, not `auth`, on any other Claude error", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeResult({
        is_error: true,
        result: "API Error: 529 overloaded",
        api_error_status: 529,
        structured_output: undefined,
      }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "failed",
    );
  });

  it("fails with `invalid-result` when the output is not JSON", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({ code: 0, stdout: "hello", stderr: "" });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "invalid-result" && e.stdout === "hello",
    );
  });

  it("fails with `invalid-result` when there is no structured Verdict", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({ structured_output: undefined }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "invalid-result" && /Verdict/.test(e.message),
    );
  });

  it("keeps what a Run spent on the failure, when its output says", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({ structured_output: undefined }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.usage?.output_tokens === 34 && e.usage.cost_usd === 0.01,
    );
  });

  it("fails with `invalid-result` on a Verdict the Agent may not give", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({ structured_output: { verdict: "BLOCKED" } }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "invalid-result" &&
        /BLOCKED.*PASS, FAIL/.test(e.message),
    );
  });

  it("removes the Skills copy even when the Run fails", async () => {
    const { home, workdir, docker, runner } = setup();
    const skill = tmpDir("foreman-skill-");
    writeFileSync(join(skill, "SKILL.md"), "x");
    docker.claude = () => ({ code: 1, stdout: "", stderr: "boom" });
    await assert.rejects(
      runner.run(spec(workdir, { skills: [{ name: "tdd", dir: skill }] })),
      RunFailure,
    );
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(home), ["claude.env"]);
  });

  it("refuses to start without a token file, and says where to put it", async () => {
    const { workdir, docker } = setup();
    const bare = new ContainerRunner({ docker, home: tmpDir("foreman-empty-"), user: "1:1" });
    await assert.rejects(bare.run(spec(workdir)), /claude\.env.*setup-token/s);
    assert.deepEqual(docker.calls, []);
  });

  it("uses the Agent's image, and the Runner's default timeout when the Agent sets none", async () => {
    const { workdir, docker, runner } = setup({ timeoutMs: 20 });
    docker.claude = (args) => docker.untilKilled(args);
    await assert.rejects(runner.run(spec(workdir, { image: "foreman-web" })), RunFailure);
    assert.ok(docker.callsStarting("run", "--rm")[0]?.includes("foreman-web"));
  });
});
