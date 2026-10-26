import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { runEngine } from "../src/commands/run.ts";
import { loadNtfyConfig, ntfyFromConfig } from "../src/notify/config.ts";
import { engineError, notifySafely, requestDone, taskDone } from "../src/notify/notifier.ts";
import { NtfyNotifier } from "../src/notify/ntfy.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import type { Runner } from "../src/runner/runner.ts";
import { Store } from "../src/store/store.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";
import { buildingRequest, defaultPipeline, removeTmpDirs, tmpDir } from "./helpers.ts";

const fake = new FakeNtfy();
let url: string;
let notifier: NtfyNotifier;
before(async () => {
  url = await fake.start();
  notifier = new NtfyNotifier({ server: `${url}/`, topic: "foreman" });
});
after(() => fake.stop());
afterEach(removeTmpDirs);

test("records title, priority, tags and body for Task done, Request done and engine error", async () => {
  fake.calls.length = 0;
  await notifier.send(taskDone("T-1", "do a thing"));
  await notifier.send(requestDone("R-1", "Build it"));
  await notifier.send(engineError(new Error("boom")));
  assert.deepEqual(fake.calls, [
    {
      topic: "foreman-usage",
      title: "Task done: T-1",
      priority: "low",
      tags: "white_check_mark",
      body: "do a thing",
    },
    {
      topic: "foreman",
      title: "Request done: R-1",
      priority: "high",
      tags: "tada",
      body: "Build it",
    },
    {
      topic: "foreman",
      title: "Foreman engine error",
      priority: "high",
      tags: "rotating_light",
      body: "boom",
    },
  ]);
});

test("an ntfy failure is logged, never thrown", async () => {
  fake.status = 500;
  const logs: string[] = [];
  await notifySafely(notifier, taskDone("T-2", "x"), (m) => logs.push(m));
  assert.deepEqual(logs, ["notify failed: ntfy responded 500"]);
  fake.status = 200;

  const down = new NtfyNotifier({ server: "http://127.0.0.1:1", topic: "t" });
  await notifySafely(down, taskDone("T-3", "x"), (m) => logs.push(m));
  assert.equal(logs.length, 2);
});

function seed() {
  const store = Store.memory();
  const { m } = buildingRequest(store, {
    title: "r",
    target_repo: tmpDir("foreman-notify-repo-"),
  });
  store.createTask({ milestone_id: m.id, seq: 1, title: "a" });
  return store;
}

function home(config?: string): string {
  const dir = tmpDir("foreman-notify-");
  if (config !== undefined) writeFileSync(join(dir, "config.toml"), config);
  return dir;
}

test("a publish to a server that never answers is aborted at the timeout and logged", async () => {
  fake.hang = true;
  try {
    const slow = new NtfyNotifier({ server: url, topic: "t", timeoutMs: 200 });
    const logs: string[] = [];
    const started = Date.now();
    await notifySafely(slow, taskDone("T-4", "x"), (m) => logs.push(m));
    assert.ok(Date.now() - started < 2000);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^notify failed: /);
  } finally {
    fake.hang = false;
  }
});

test("a hung ntfy server delays a tick by no more than the timeout, and the failure is logged", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  fake.hang = true;
  try {
    const dir = home();
    const notifier = new NtfyNotifier({ server: url, topic: "t", timeoutMs: 200 });
    const started = Date.now();
    const results = await runEngine(seed(), {
      home: dir,
      untilIdle: true,
      pipeline: defaultPipeline(),
      runner: new FakeRunner(),
      notifier,
    });
    // One Task through the 9 Stages of the default Pipeline.
    assert.equal(results.filter((r) => r.kind === "ran").length, 9);
    // Two pings (Task done, Request done), each cut off at 200 ms.
    assert.ok(Date.now() - started < 2000);
  } finally {
    fake.hang = false;
  }
  const logged = log.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(logged.length, 2);
  assert.ok(logged.every((m) => m.startsWith("notify failed: ")));
});

test("[ntfy] in config.toml sets server, topic and usage_topic; env vars override", () => {
  const dir = home(`# comment
[other]
topic = "nope"

[ntfy]
server = "https://ntfy.example"  # trailing comment
topic = "main-topic"
usage_topic = 'usage-topic'
`);
  assert.deepEqual(loadNtfyConfig(dir, {}), {
    server: "https://ntfy.example",
    topic: "main-topic",
    usageTopic: "usage-topic",
  });
  assert.deepEqual(
    loadNtfyConfig(dir, { FOREMAN_NTFY_SERVER: "http://x", FOREMAN_NTFY_USAGE_TOPIC: "u2" }),
    { server: "http://x", topic: "main-topic", usageTopic: "u2" },
  );
  assert.equal(loadNtfyConfig(home(), {}), undefined);
  assert.equal(loadNtfyConfig(home('[ntfy]\nserver = "http://x"\n'), {}), undefined);
});

test("a test config.toml sends the Task-done ping to usage_topic at low priority", async () => {
  const dir = home(`[ntfy]
server = "${url}"
topic = "main-topic"
usage_topic = "usage-topic"
`);
  fake.calls.length = 0;
  await runEngine(seed(), {
    home: dir,
    untilIdle: true,
    pipeline: defaultPipeline(),
    runner: new FakeRunner(),
    notifier: ntfyFromConfig(dir, {}),
  });
  const done = fake.calls.find((c) => c.title?.startsWith("Task done"));
  assert.equal(done?.topic, "usage-topic");
  assert.equal(done?.priority, "low");
  assert.equal(fake.calls.find((c) => c.title?.startsWith("Request done"))?.topic, "main-topic");
});

test("a Runner that throws sends one engine-error ping, rewrites STATUS.md, stops the loop and leaves the Task queued", async () => {
  const store = seed();
  const dir = home();
  const runner: Runner = {
    run: async () => {
      throw new Error("runner exploded");
    },
  };
  fake.calls.length = 0;
  const results = await runEngine(store, {
    home: dir,
    untilIdle: true,
    pipeline: defaultPipeline(),
    runner,
    notifier,
  });
  assert.deepEqual(
    results.map((r) => r.kind),
    ["error"],
  );
  const pings = fake.calls.filter((c) => c.title === "Foreman engine error");
  assert.equal(pings.length, 1);
  assert.equal(pings[0]?.topic, "foreman");
  assert.equal(pings[0]?.priority, "high");
  assert.equal(pings[0]?.body, "runner exploded");
  assert.equal(fake.calls.length, 1);
  assert.equal(store.listTasks()[0]?.status, "queued");
  assert.equal(store.listEvents().filter((e) => e.type === "stage.crashed").length, 1);
  assert.match(readFileSync(join(dir, "STATUS.md"), "utf8"), /stage\.crashed/);
});
