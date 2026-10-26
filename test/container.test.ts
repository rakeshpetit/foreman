import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CliDocker, DockerError } from "../src/docker/docker.ts";
import { ContainerRunner } from "../src/runner/container.ts";
import { verdictSchema } from "../src/runner/prompt.ts";
import { RunFailure, type RunSpec } from "../src/runner/runner.ts";
import {
  assistantLine,
  claudeResult,
  claudeStream,
  FakeDocker,
  flagValue,
  flagValues,
  rateLimitLine,
  resultLine,
} from "./fakes/docker/docker.ts";
import { removeTmpDirs, tmpDir } from "./helpers.ts";

afterEach(removeTmpDirs);

function setup(opts: Partial<ConstructorParameters<typeof ContainerRunner>[0]> = {}) {
  const home = tmpDir("foreman-home-");
  writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
  const workdir = tmpDir("foreman-work-");
  const docker = new FakeDocker();
  const runner = new ContainerRunner({
    docker,
    tokenFile: join(home, "claude.env"),
    user: "501:20",
    ...opts,
  });
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
        tokens_in: 12,
        tokens_out: 34,
        cache_read: 5,
        cache_write: 6,
        context_peak: 2 + 5 + 6,
        cost_usd: 0.01,
      },
      stdout: claudeResult(),
    });
    assert.equal(docker.callsStarting("run", "--rm").length, 1);
  });

  it("reads every usage figure, the model and the raw stream from a real stream of three calls", async () => {
    const { workdir, docker, runner } = setup();
    const raw = readFileSync(join(import.meta.dirname, "fixtures/claude/stream.jsonl"), "utf8");
    docker.claude = () => ({ code: 0, stdout: raw, stderr: "" });
    const result = await runner.run(spec(workdir));
    assert.deepEqual(result.usage, {
      tokens_in: 9,
      tokens_out: 410,
      cache_read: 22800,
      cache_write: 11937,
      // The largest of the three calls' contexts (input + cache read + cache write): 11003, 11802, 11941.
      context_peak: 4 + 11800 + 137,
      cost_usd: 0.0412,
    });
    assert.equal(result.model, "claude-sonnet-5-5");
    assert.equal(result.stdout, raw);
  });

  it("takes the context peak from the fullest call, not the last", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeStream([
        assistantLine({ input_tokens: 1, cache_read_input_tokens: 100 }),
        assistantLine({
          input_tokens: 1,
          cache_creation_input_tokens: 900,
          cache_read_input_tokens: 100,
        }),
        assistantLine({ input_tokens: 1, cache_read_input_tokens: 300 }),
        resultLine(),
      ]),
      stderr: "",
    });
    assert.equal((await runner.run(spec(workdir))).usage.context_peak, 1001);
  });

  it("has no context peak when the stream shows no call to the model", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({ code: 0, stdout: claudeStream([resultLine()]), stderr: "" });
    assert.equal((await runner.run(spec(workdir))).usage.context_peak, null);
  });

  it("reads the result out of a stream with lines that are not JSON", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: `warning: something\n${claudeResult()}\n{"truncated":`,
      stderr: "",
    });
    assert.equal((await runner.run(spec(workdir))).verdict, "PASS");
  });

  it("records the model that cost the most, when a cheap helper model is listed first", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({
        modelUsage: {
          "claude-haiku-4-5": { costUSD: 0.0003 },
          "claude-sonnet-5-5": { costUSD: 0.04 },
          "claude-haiku-4-6": { costUSD: 0.0001 },
        },
      }),
      stderr: "",
    });
    assert.equal((await runner.run(spec(workdir))).model, "claude-sonnet-5-5");
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
    assert.equal(flagValue(claude, "--output-format"), "stream-json");
    assert.ok(claude.includes("--verbose"));
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
      (e) =>
        e instanceof RunFailure &&
        e.kind === "timeout" &&
        e.exitCode === 137 &&
        /20 ms|timed out/.test(e.message),
    );
    assert.deepEqual(docker.callsStarting("kill"), [["kill", "foreman-run-7"]]);
  });

  it("removes the container with `rm -f` when the kill does not stop it", async () => {
    const { workdir, docker, runner } = setup({ killGraceMs: 20 });
    docker.ignoreKill = true;
    docker.claude = (args) => docker.untilKilled(args);
    await assert.rejects(
      runner.run(spec(workdir, { timeoutMs: 20 })),
      (e) =>
        e instanceof RunFailure && e.kind === "timeout" && !/may still be running/.test(e.message),
    );
    assert.deepEqual(docker.callsStarting("kill"), [["kill", "foreman-run-7"]]);
    assert.deepEqual(docker.callsStarting("rm"), [["rm", "-f", "foreman-run-7"]]);
  });

  it("names the container when the kill and `rm -f` both fail", async () => {
    const { workdir, docker, runner } = setup({ killGraceMs: 20 });
    docker.ignoreKill = true;
    docker.claude = (args) => docker.untilKilled(args);
    docker.failOn = { prefix: ["rm"], stderr: "daemon not responding" };
    await assert.rejects(
      runner.run(spec(workdir, { timeoutMs: 20 })),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "timeout" &&
        /foreman-run-7 may still be running/.test(e.message),
    );
  });

  it("does not `rm -f` after a kill that worked", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = (args) => docker.untilKilled(args);
    await assert.rejects(runner.run(spec(workdir, { timeoutMs: 20 })), RunFailure);
    assert.deepEqual(docker.callsStarting("rm"), []);
  });

  it("removes the container and fails with `failed` when `docker run` itself rejects", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => Promise.reject(new Error("stdout maxBuffer length exceeded"));
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "failed" && /maxBuffer/.test(e.message),
    );
    assert.deepEqual(docker.callsStarting("rm"), [["rm", "-f", "foreman-run-7"]]);
  });

  it("says the container may still be running when `docker run` rejects and `rm -f` fails", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => Promise.reject(new Error("killed by SIGTERM"));
    docker.failOn = { prefix: ["rm"], stderr: "daemon not responding" };
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && /foreman-run-7 may still be running/.test(e.message),
    );
  });

  it("starts no Run when foreman-agents exists but is not internal", async () => {
    const { workdir, docker, runner } = setup();
    docker.networks.add("foreman-agents");
    docker.openNetworks.add("foreman-agents");
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof DockerError &&
        /foreman-agents/.test(e.message) &&
        /docker network rm foreman-agents/.test(e.message),
    );
    assert.deepEqual(docker.callsStarting("run"), []);
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
      (e) => e instanceof RunFailure && e.kind === "failed" && e.exitCode === 1,
    );
  });

  it("fails with `usage-limit` on a rejected rate_limit_event, with that event's resetsAt", async () => {
    const { workdir, docker, runner } = setup();
    const stdout = claudeResult(
      {
        is_error: true,
        result: "You've hit your 5-hour usage limit",
        structured_output: undefined,
      },
      [rateLimitLine("allowed", 1793000000), rateLimitLine("rejected", 1793039400)],
    );
    docker.claude = () => ({ code: 1, stdout, stderr: "" });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "usage-limit" &&
        e.resetsAt?.getTime() === 1793039400_000 &&
        e.stdout === stdout,
    );
  });

  it("goes by the event, not the text, when the stream has one", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeResult({ is_error: true, result: "Something else went wrong" }, [
        rateLimitLine("rejected", 1793039400),
      ]),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "usage-limit",
    );
  });

  it("does not read a reset time as milliseconds", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeResult({ is_error: true, result: "You've hit your weekly usage limit" }, [
        rateLimitLine("rejected", 1793039400_000),
      ]),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.resetsAt?.getTime() === 1793039400_000_000,
    );
  });

  it("fails with `usage-limit` on a rejected event even when no result line follows", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeStream([
        assistantLine({ input_tokens: 1 }),
        rateLimitLine("rejected", 1793039400),
      ]),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) =>
        e instanceof RunFailure &&
        e.kind === "usage-limit" &&
        e.resetsAt?.getTime() === 1793039400_000,
    );
  });

  it("falls back to the error text for a stream with no rate_limit_event, with no reset time", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 0,
      stdout: claudeResult({
        is_error: true,
        result: "You have reached your weekly usage limit",
        structured_output: undefined,
      }),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "usage-limit" && e.resetsAt === undefined,
    );
  });

  it("falls back to the error text when the stream's only rate_limit_event is `allowed`", async () => {
    // A real stream starts with an `allowed` event, so a limit may come with no event of its own.
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeResult({ is_error: true, result: "You've hit your 5-hour usage limit" }, [
        rateLimitLine("allowed", 1793039400),
      ]),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "usage-limit" && e.resetsAt === undefined,
    );
  });

  it("does not mistake a warning for a limit", async () => {
    const { workdir, docker, runner } = setup();
    docker.claude = () => ({
      code: 1,
      stdout: claudeResult({ is_error: true, result: "API Error: 529 overloaded" }, [
        rateLimitLine("allowed_warning", 1793039400),
      ]),
      stderr: "",
    });
    await assert.rejects(
      runner.run(spec(workdir)),
      (e) => e instanceof RunFailure && e.kind === "failed",
    );
  });

  it("does not mistake a successful Run's rate-limit event for a limit", async () => {
    const { workdir, docker, runner } = setup();
    for (const status of ["allowed", "rejected"]) {
      docker.claude = () => ({
        code: 0,
        stdout: claudeResult({}, [rateLimitLine(status, 1793039400)]),
        stderr: "",
      });
      assert.equal((await runner.run(spec(workdir))).verdict, "PASS", status);
    }
  });

  it("fails with `invalid-result` when the output has no result", async () => {
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
      (e) => e instanceof RunFailure && e.usage?.tokens_out === 34 && e.usage.cost_usd === 0.01,
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
    const bare = new ContainerRunner({
      docker,
      tokenFile: join(tmpDir("foreman-empty-"), "claude.env"),
      user: "1:1",
    });
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

// The real CliDocker and ContainerRunner, spawning the `docker` shim in test/fakes/docker.
describe("through the docker shim", () => {
  const shimDir = join(import.meta.dirname, "fakes", "docker");
  const savedEnv = { ...process.env };

  /** Puts the shim first on PATH, with its state in a fresh directory. Returns that directory. */
  function useShim(env: Record<string, string> = {}): string {
    const state = tmpDir("foreman-shim-");
    process.env.PATH = `${shimDir}${delimiter}${savedEnv.PATH}`;
    process.env.FAKE_DOCKER_STATE = state;
    Object.assign(process.env, env);
    return state;
  }

  afterEach(() => {
    for (const key of ["PATH", "FAKE_DOCKER_STATE", "FAKE_CLAUDE_OUTPUT", "FAKE_DOCKER_EXIT"]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function shimRunner(opts: Partial<ConstructorParameters<typeof ContainerRunner>[0]> = {}) {
    const home = tmpDir("foreman-home-");
    writeFileSync(join(home, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-test\n");
    return new ContainerRunner({
      docker: new CliDocker(),
      tokenFile: join(home, "claude.env"),
      user: "501:20",
      ...opts,
    });
  }

  it("CliDocker resolves with the exit code and output of a non-zero exit", async () => {
    const out = join(tmpDir("foreman-out-"), "out.txt");
    writeFileSync(out, "partial output\n");
    useShim({ FAKE_CLAUDE_OUTPUT: out, FAKE_DOCKER_EXIT: "3" });
    const result = await new CliDocker().run(["run", "--rm", "--name", "x"]);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "partial output\n");
  });

  it("CliDocker rejects when there is no docker", async () => {
    process.env.PATH = tmpDir("foreman-empty-bin-");
    await assert.rejects(
      new CliDocker().run(["ps"]),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT",
    );
  });

  it("ContainerRunner runs the shim's output through to a RunResult", async () => {
    const out = join(tmpDir("foreman-out-"), "stream.jsonl");
    writeFileSync(out, claudeResult());
    useShim({ FAKE_CLAUDE_OUTPUT: out });
    const workdir = tmpDir("foreman-work-");
    const result = await shimRunner().run(spec(workdir));
    assert.equal(result.verdict, "PASS");
    assert.equal(result.stdout, claudeResult());
  });

  it("ContainerRunner fails a non-zero exit with `failed`", async () => {
    const out = join(tmpDir("foreman-out-"), "out.txt");
    writeFileSync(out, "");
    useShim({ FAKE_CLAUDE_OUTPUT: out, FAKE_DOCKER_EXIT: "2" });
    await assert.rejects(
      shimRunner().run(spec(tmpDir("foreman-work-"))),
      (e) => e instanceof RunFailure && e.kind === "failed" && /exited 2/.test(e.message),
    );
  });

  it("ContainerRunner kills a timed-out Run and leaves no process behind", async () => {
    const state = useShim();
    await assert.rejects(
      shimRunner().run(spec(tmpDir("foreman-work-"), { timeoutMs: 300 })),
      (e) => e instanceof RunFailure && e.kind === "timeout",
    );
    const calls = readFileSync(join(state, "calls"), "utf8");
    assert.match(calls, /^kill foreman-run-7$/m);
    assert.doesNotMatch(calls, /^rm /m);
    // The shim wrote its pid when `run` started: that process must be gone.
    const pid = Number(readFileSync(join(state, "foreman-run-7.pid"), "utf8"));
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});
