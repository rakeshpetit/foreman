import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/main.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import { Store } from "../src/store/store.ts";
import { FakeNtfy } from "./fakes/ntfy/server.ts";

test("tracer: import → go → run --until-idle with a scripted review failure", async () => {
  const ntfy = new FakeNtfy();
  const server = await ntfy.start();
  try {
    const root = mkdtempSync(join(tmpdir(), "foreman-e2e-"));
    const home = join(root, "home");
    const out: string[] = [];
    const run = (...argv: string[]) =>
      main(argv, {
        env: { FOREMAN_HOME: home, FOREMAN_NTFY_SERVER: server, FOREMAN_NTFY_TOPIC: "foreman" },
        cwd: root,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        runner: new FakeRunner({ review: [{ verdict: "fail" }] }),
      });

    const plan = fileURLToPath(new URL("./fixtures/plan", import.meta.url));
    assert.equal(await run("import", plan, "--repo", root), 0);
    assert.equal(await run("go", "R-1"), 0);
    assert.equal(await run("run", "--until-idle"), 0);

    const store = Store.open(home);
    try {
      const tasks = store.listTasks();
      assert.equal(tasks.length, 4);
      assert.ok(tasks.every((t) => t.status === "done"));
      assert.equal(
        tasks.reduce((n, t) => n + t.round_total, 0),
        1,
      );
      assert.equal(store.getRequest("R-1")?.phase, "done");
    } finally {
      store.close();
    }

    assert.match(readFileSync(join(home, "STATUS.md"), "utf8"), /Phase: done/);
    const titles = ntfy.calls.map((c) => c.title);
    assert.ok(titles.includes("Request done: R-1"));
    assert.equal(titles.filter((t) => t?.startsWith("Task done")).length, 4);
  } finally {
    await ntfy.stop();
  }
});
