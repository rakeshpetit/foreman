import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { render, writeStatus } from "../src/status/status.ts";
import { Store } from "../src/store/store.ts";

function mixed() {
  const s = Store.memory();
  s.now = () => new Date("2026-01-01T00:00:00Z");
  const r = s.createRequest({ title: "Build it", target_repo: "/r", mode: "auto" });
  s.updateRequest(r.id, { phase: "building" });
  const m1 = s.createMilestone({ request_id: r.id, seq: 1, title: "first" });
  const m2 = s.createMilestone({ request_id: r.id, seq: 2, title: "second" });
  const a = s.createTask({ milestone_id: m1.id, seq: 1, title: "a" });
  const b = s.createTask({ milestone_id: m1.id, seq: 2, title: "b", origin: "research" });
  const c = s.createTask({ milestone_id: m2.id, seq: 1, title: "c" });
  s.updateTask(a.id, { status: "done" });
  s.updateTask(b.id, { status: "active", stage: "implement", round_total: 2 });
  s.updateTask(c.id, { status: "awaiting_owner" });
  s.createApproval({ kind: "go", subject_id: r.id });
  s.addEvent("stage.completed", a.id);
  return s;
}

test("render snapshot for mixed states", () => {
  assert.equal(
    render(mixed()),
    `# Foreman status

**Queue:** running

## Requests

### R-1 · Build it

Phase: building · Mode: auto

- M-1 first: 1/2 tasks done
- M-2 second: 0/1 tasks done

## Tasks

| Task | Title | Stage | Round | Origin | Status |
|---|---|---|---|---|---|
| T-1 | a | - | 0 | planned | done |
| T-2 | b | implement | 2 | research | active |
| T-3 | c | - | 0 | planned | awaiting_owner |

## Waiting on the Owner

- A-1: go approval for R-1
- T-3: c

## Recent events

- 2026-01-01T00:00:00.000Z stage.completed T-1
`,
  );
});

test("paused queue is shown", () => {
  const s = mixed();
  s.setQueueState({ paused_until: "2999-01-01T00:00:00Z", reason: "limit" });
  assert.match(render(s), /\*\*Queue:\*\* paused until 2999-01-01T00:00:00Z \(limit\)/);
});

test("writeStatus writes atomically, leaving no temp file", () => {
  const home = mkdtempSync(join(tmpdir(), "foreman-status-"));
  const path = writeStatus(mixed(), home);
  assert.equal(readFileSync(path, "utf8"), render(mixed()));
  assert.deepEqual(readdirSync(home), ["STATUS.md"]);
});
