import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { engineError, notifySafely, requestDone, taskDone } from "../src/notify/notifier.ts";
import { NtfyNotifier } from "../src/notify/ntfy.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";

const fake = new FakeNtfy();
let notifier: NtfyNotifier;
before(async () => {
  notifier = new NtfyNotifier({ server: `${await fake.start()}/`, topic: "foreman" });
});
after(() => fake.stop());

test("records title, priority, tags and body for Task done, Request done and engine error", async () => {
  fake.calls.length = 0;
  await notifier.send(taskDone("T-1", "do a thing"));
  await notifier.send(requestDone("R-1", "Build it"));
  await notifier.send(engineError(new Error("boom")));
  assert.deepEqual(fake.calls, [
    {
      topic: "foreman",
      title: "Task done: T-1",
      priority: undefined,
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
