import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CliDocker, DockerError } from "../src/docker/docker.ts";
import {
  BASE_IMAGE,
  buildImages,
  EGRESS,
  type Egress,
  ensureEgress,
  IMAGES,
  PROXY_IMAGE,
  proxyEnv,
} from "../src/docker/images.ts";
import { FakeDocker } from "./fakes/docker/docker.ts";
import { REPO_ROOT } from "./helpers.ts";

test("buildImages builds the base and proxy images from their folders, in order", async () => {
  const docker = new FakeDocker();
  const built: string[] = [];
  await buildImages(docker, { foremanDir: "/foreman", onBuilt: (i) => built.push(i.name) });
  assert.deepEqual(docker.calls, [
    ["build", "--tag", BASE_IMAGE.name, "/foreman/images/base"],
    ["build", "--tag", "foreman-egress-proxy", "/foreman/images/egress-proxy"],
  ]);
  assert.deepEqual(built, [BASE_IMAGE.name, "foreman-egress-proxy"]);
});

test("buildImages stops at a failed build and says which command failed and why", async () => {
  const docker = new FakeDocker();
  docker.failOn = { prefix: ["build"], stderr: "ERROR: failed to solve: boom" };
  await assert.rejects(
    buildImages(docker, { foremanDir: "/foreman" }),
    (e) =>
      e instanceof DockerError && /docker build failed.*failed to solve: boom/s.test(e.message),
  );
  assert.equal(docker.calls.length, 1);
});

test("ensureEgress creates both networks, starts the proxy and joins it to the internal network", async () => {
  const docker = new FakeDocker();
  await ensureEgress(docker);
  assert.deepEqual(docker.callsStarting("network", "create"), [
    ["network", "create", "--internal", "foreman-agents"],
    ["network", "create", "foreman-egress"],
  ]);
  assert.deepEqual(docker.callsStarting("run"), [
    [
      "run",
      "--detach",
      "--name",
      "foreman-egress-proxy",
      "--network",
      "foreman-egress",
      "foreman-egress-proxy",
    ],
  ]);
  assert.deepEqual(docker.callsStarting("network", "connect"), [
    ["network", "connect", "--alias", "proxy", "foreman-agents", "foreman-egress-proxy"],
  ]);
});

test("ensureEgress is idempotent: a second call changes nothing", async () => {
  const docker = new FakeDocker();
  await ensureEgress(docker);
  const before = docker.calls.length;
  await ensureEgress(docker);
  const second = docker.calls.slice(before).map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(second, ["network inspect", "network inspect", "container inspect"]);
});

test("ensureEgress restarts a stopped proxy without recreating it", async () => {
  const docker = new FakeDocker();
  await ensureEgress(docker);
  const proxy = docker.containers.get(EGRESS.proxyContainer);
  assert.ok(proxy);
  proxy.running = false;
  docker.calls.length = 0;
  await ensureEgress(docker);
  assert.deepEqual(docker.callsStarting("start"), [["start", "foreman-egress-proxy"]]);
  assert.equal(docker.callsStarting("run").length, 0);
});

test("ensureEgress reattaches a proxy that lost the internal network", async () => {
  const docker = new FakeDocker();
  const egress: Egress = { ...EGRESS };
  docker.networks.add(egress.internalNetwork).add(egress.outNetwork);
  docker.containers.set(egress.proxyContainer, { running: true, networks: [egress.outNetwork] });
  await ensureEgress(docker, egress);
  assert.equal(docker.callsStarting("network", "connect").length, 1);
  assert.equal(docker.callsStarting("run").length, 0);
});

test("proxyEnv points every proxy variable at the proxy and turns off telemetry", () => {
  const env = proxyEnv();
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    assert.equal(env[key], "http://proxy:8888");
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
});

test("the proxy allowlist names exactly Anthropic, npm and PyPI, each anchored", () => {
  const lines = readFileSync(join(REPO_ROOT, PROXY_IMAGE.context, "allowlist"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(lines, [
    "^api\\.anthropic\\.com$",
    "^registry\\.npmjs\\.org$",
    "^pypi\\.org$",
    "^files\\.pythonhosted\\.org$",
  ]);
});

test("the base image pins Claude Code and ends as the non-root agent user", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, BASE_IMAGE.context, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
  assert.equal(
    dockerfile
      .trimEnd()
      .split("\n")
      .filter((l) => l.startsWith("USER "))
      .at(-1),
    "USER agent",
  );
});

// The real thing: needs Docker and builds both images, so it runs only when asked for:
//   FOREMAN_DOCKER_TESTS=1 npm test
test("agent containers on the egress network reach Anthropic, npm and PyPI and nothing else", {
  skip: process.env.FOREMAN_DOCKER_TESTS !== "1" && "set FOREMAN_DOCKER_TESTS=1",
  timeout: 600_000,
}, async () => {
  const docker = new CliDocker();
  const egress: Egress = {
    internalNetwork: "foreman-test-agents",
    outNetwork: "foreman-test-egress",
    proxyContainer: "foreman-test-egress-proxy",
    proxyImage: PROXY_IMAGE.name,
  };
  const cleanup = async () => {
    await docker.run(["rm", "--force", egress.proxyContainer]);
    await docker.run(["network", "rm", egress.internalNetwork, egress.outNetwork]);
  };
  await cleanup();
  try {
    await buildImages(docker);
    for (const image of IMAGES)
      assert.equal((await docker.run(["image", "inspect", image.name])).code, 0);
    await ensureEgress(docker, egress);

    const env = Object.entries(proxyEnv()).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const inAgent = (...cmd: string[]) =>
      docker.run([
        "run",
        "--rm",
        "--network",
        egress.internalNetwork,
        ...env,
        BASE_IMAGE.name,
        ...cmd,
      ]);
    const status = async (url: string): Promise<string> => {
      const r = await inAgent(
        "curl",
        "--silent",
        "--output",
        "/dev/null",
        "--max-time",
        "20",
        "--write-out",
        "%{http_code}",
        url,
      );
      return r.stdout;
    };

    // Tinyproxy takes a moment to listen after `docker run`.
    for (let i = 0; i < 20 && (await status("https://registry.npmjs.org/")) !== "200"; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Allowed: the registries answer (Anthropic's root has no page, so 404 means it was reached).
    assert.equal(await status("https://registry.npmjs.org/"), "200");
    assert.equal(await status("https://pypi.org/simple/"), "200");
    assert.equal(await status("https://api.anthropic.com"), "404");
    const npm = await inAgent("npm", "view", "left-pad", "version");
    assert.equal(npm.code, 0, npm.stderr);

    // Denied: everything else, even look-alikes and IP literals.
    for (const url of [
      "https://github.com",
      "https://example.com",
      "https://api.anthropic.com.evil.com",
      "https://1.1.1.1",
    ]) {
      assert.notEqual(await status(url), "200", url);
      assert.match(await status(url), /^(000|403)$/, url);
    }
    const clone = await inAgent("git", "clone", "https://github.com/octocat/Hello-World", "/tmp/x");
    assert.notEqual(clone.code, 0);
    assert.match(clone.stderr, /CONNECT tunnel failed, response 403/);

    // No proxy variables: no route out at all.
    const direct = await docker.run([
      "run",
      "--rm",
      "--network",
      egress.internalNetwork,
      BASE_IMAGE.name,
      "curl",
      "--silent",
      "--max-time",
      "10",
      "--output",
      "/dev/null",
      "https://api.anthropic.com",
    ]);
    assert.notEqual(direct.code, 0);

    // The base image runs as the non-root agent user with the pinned tools.
    const who = await docker.run([
      "run",
      "--rm",
      BASE_IMAGE.name,
      "sh",
      "-c",
      "id -un && claude --version && uv --version && node --version",
    ]);
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /^agent\n2\.1\.310 /);
  } finally {
    await cleanup();
  }
});

// Keep the real docker CLI honest about what `CliDocker` does with a missing binary or a bad exit.
test("CliDocker returns a non-zero exit as a result", async () => {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
  } catch {
    return; // no docker here
  }
  const r = await new CliDocker().run(["network", "inspect", "foreman-does-not-exist"]);
  assert.notEqual(r.code, 0);
});
