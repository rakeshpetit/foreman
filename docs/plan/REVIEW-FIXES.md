# Foreman v1: M0–M1 review fixes

Tasks that address every finding from the review of M0 and M1 (`53300cb...eb0dd28`). The format, Kinds and Sizes follow [TASKS.md](./TASKS.md), so `foreman import` can read this file. IDs carry on from M1-T08. Do them all before starting M2.

**Where each finding goes:**

| Finding | Axis | Task |
|---|---|---|
| `foreman run` uses FakeRunner by default and marks real Tasks done | Spec | M1-T09 |
| Workdir is the first building Request's repo, not the Task's own | Standards, Spec | M1-T10 |
| A dropped dependency blocks its dependent Task forever | Standards | M1-T11 |
| Milestones never complete; Request completion lives in the CLI layer | Spec | M1-T12 |
| `route` has no `task` parameter (M1-T03) | Spec | M1-T13 |
| `round_stage` resets too early, so review Rounds never add up | Spec | M1-T13 |
| The engine-error ping is never sent; a crashed stage leaves no event | Standards, Spec | M1-T14 |
| No `catch` at the CLI boundary | Standards | M1-T15 |
| `Store.open` runs before the command is known | Standards | M1-T15 |
| ntfy server and topic come from env vars, not config | Spec | M1-T16 |
| ntfy `fetch` has no timeout | Standards | M1-T16 |
| The Task-done ping uses the main topic, not `foreman-usage` at low priority (ADR 0009) | Standards | M1-T16 |
| No Run rows are recorded and usage is thrown away | Standards, Spec | M1-T17 |
| Reports go to `$FOREMAN_HOME/reports`, not `.foreman/R-n/runs/` (ADR 0002) | Standards, Spec | M1-T18 |
| The e2e test never checks the events table; key events are never written | Spec | M1-T19 |
| `recentEvents` loads every event, then slices | Standards | M1-T19 |
| STATUS.md is not rewritten after `go`, `import`, `pause` and `resume` (ADR 0002) | Standards | M1-T20 |
| The paused-queue check is duplicated in `tick.ts` and `status.ts` | Standards | M1-T21 |
| `FAR_FUTURE` stands for "paused indefinitely" | Standards | M1-T21 |
| `import` has the shape `[planDir] [--repo]`, not `<target-repo> <plan-dir>` | Spec | M1-T22 |
| Do and Done when are not parsed; duplicate Milestone IDs are not caught | Spec | M1-T22 |
| `ParsedTask.size` becomes `size_est` | Standards | M1-T22 |
| A file-write error after the commit leaves the Request rows in SQLite | Standards | M1-T23 |
| Import stores a placeholder `file_path`, then patches it | Standards | M1-T23 |
| The first stage is `"workup"` in import but `PIPELINE[0]` in tick | Standards | M1-T23 |
| `stage`, `origin`, `lane` and Approval `kind`/`channel` are plain strings; `as Stage` cast | Standards | M1-T24 |
| `Outcome`, `RunResult.verdict` and `FakeStep.verdict` name one concept three ways (CONTEXT: Verdict) | Standards | M1-T24 |
| `"PASS"` in the store test and `"pass"` in the engine | Standards | M1-T24 |
| `requests.status` exists next to `phase` and is never used | Standards | M1-T24 |
| The four `list*` methods repeat the same filter shape | Standards | M1-T25 |
| The "no SQL outside `src/store`" test misses `DELETE`/`PRAGMA`; `Store.db` is public | Spec | M1-T25 |
| Test setup is copied across the engine, runner and status tests | Standards | M1-T26 |
| `import.test.ts` asserts on the live `docs/plan/TASKS.md` | Standards | M1-T26 |
| Tests depend on the directory they run from; temp directories are never removed | Standards | M1-T26 |
| `main.test.ts` imports mid-file and imports `main.ts` twice | Standards | M1-T26 |
| The pre-push hook needs a manual `git config` step | Spec | M1-T27 |
| A failed Workup goes back to Workup, not implement, with no recorded decision | Spec | M1-T28 |
| Unplanned additions (`counters`, `tasks.ref`, `Store.memory`, `typecheck`) are not in PLAN or README | Spec | M1-T28 |

---

## M1 · Review fixes

### M1-T09 · `run` needs an explicit Runner
- **Kind:** cli · **Size:** S · **Depends:** none
- **Do:** Stop `runEngine` falling back to `new FakeRunner()`. `foreman run` takes `--fake <script.json>` to use FakeRunner. With no flag and no real Runner yet (M3), it exits non-zero with a message saying so. Tests and the e2e test pass the Runner in explicitly.
- **Done when:**
  - `foreman run` with no `--fake` on an imported, approved Request exits non-zero and leaves every Task `queued`.
  - `foreman run --fake <script>` behaves as `run` does today.

### M1-T10 · Each Task runs in its own Request's repo
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Build the executor's workdir from the picked Task's own Request (Task → Milestone → Request → `target_repo`), not from the first building Request. Do this inside the engine or the executor, after `nextActionable` has picked the Task, so `runEngine` no longer looks up a Request itself.
- **Done when:** a test with two building Requests in different repos, where the first has nothing actionable, runs the second Request's Task with the second repo as its workdir.

### M1-T11 · Dropped dependencies count as settled
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Add one "settled" predicate (`done` or `dropped`) and use it in `nextActionable` and in Request completion, so the two can't disagree again.
- **Done when:** a Task whose only dependency is `dropped` is actionable, and a test covers it.

### M1-T12 · The engine owns Milestone and Request completion
- **Kind:** core · **Size:** M · **Depends:** M1-T11
- **Do:** Move the completion logic out of `commands/run.ts` into the engine's `apply`, inside the same transaction as the Task update:
  1. When every Task in a Milestone is settled, set the Milestone to `done` and write `milestone.done`.
  2. When every Milestone in a Request is done, set the Request to `done` and write `request.done`.
  3. The `TickResult` reports what completed, and `runEngine` only sends the notifications.

  M5-T04 adds the Milestone Approval on top of this.
- **Done when:**
  - The e2e test sees both Milestones `done`.
  - A Request whose last Task is dropped (not run) also completes.
  - `commands/run.ts` contains no completion logic.

### M1-T13 · `route(stage, verdict, task)` owns Round counting
- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Change the signature to `route(stage, verdict, task)` as M1-T03 specifies. Move the Round arithmetic out of `apply` into `route`, so the returned `Transition` carries the new `round_stage` and `round_total`. `round_stage` counts the Rounds caused by the Stage that sent the Task back. It resets only when that Stage passes, not when implement passes on the way back to review.
- **Done when:**
  - Table tests cover review fail → implement pass → review fail → implement pass → review fail, ending with `round_stage = 3` and `round_total = 3`.
  - A review pass resets `round_stage` to 0.
  - `apply` contains no Round arithmetic.

### M1-T14 · Engine errors are recorded and notified
- **Kind:** core · **Size:** S · **Depends:** M1-T12
- **Do:** In `tick`, catch an executor error:
  1. Put the Task back to `queued` at the same Stage.
  2. Write a `stage.crashed` event with the message.
  3. Return `{ kind: "error" }`.

  `runEngine` then sends `engineError` through `notifySafely`, rewrites STATUS.md and stops the loop.
- **Done when:** a test with an executor that throws sees the event, one ntfy engine-error ping on the fake server, a rewritten STATUS.md, a `queued` Task and a non-zero exit from `foreman run`.

### M1-T15 · Clean errors at the CLI boundary
- **Kind:** cli · **Size:** S · **Depends:** M1-T14
- **Do:**
  - Check that the command is known before calling `Store.open`, so `foreman bogus` creates nothing.
  - Catch errors in `main`. `ImportError`, a missing file and other expected failures go through `fail()` as one line on stderr with a non-zero exit. Anything else prints the stack and exits non-zero.
- **Done when:**
  - `foreman bogus` leaves `FOREMAN_HOME` empty.
  - Importing a TASKS.md with an unknown dependency prints `line N: …` with no stack trace.

### M1-T16 · ntfy: config, timeout and the usage topic
- **Kind:** integration · **Size:** M · **Depends:** none
- **Do:**
  - Read `[ntfy] server, topic, usage_topic` from `$FOREMAN_HOME/config.toml`. The env vars stay as overrides. M2-T03 later folds this into the config merge.
  - Give every `fetch` an `AbortSignal.timeout` (5 s by default).
  - Send the Task-done ping to `usage_topic` at low priority (ADR 0009). M6 later turns it into the full Task summary.
- **Done when:**
  - The fake server records the topic and priority from a test `config.toml`.
  - A fake server that never answers delays a tick by no more than the timeout, and the failure is logged.

### M1-T17 · Every Run is recorded
- **Kind:** core · **Size:** S · **Depends:** M1-T10
- **Do:** In the `agent` executor, call `createRun` before calling the Runner and `finishRun` afterwards with the Verdict, usage, duration, exit code and report path. On a Runner error, record the error on the Run. Stop throwing away `RunResult.usage`.
- **Done when:** after the e2e test there is one `runs` row per stage run (including the failed review and its Round), each with the scripted usage.

### M1-T18 · Reports live in the Target repo
- **Kind:** core · **Size:** S · **Depends:** M1-T17
- **Do:** Write each stage report to `<target_repo>/.foreman/R-n/runs/<run-id>-<stage>.md`, as ADR 0002 and PLAN's file layout say, and store that path on the Run. Remove `$FOREMAN_HOME/reports`.
- **Done when:** the e2e test finds every report under the fixture repo's `.foreman/R-n/runs/`, and nothing under `$FOREMAN_HOME/reports`.

### M1-T19 · The events table tells the whole story
- **Kind:** core · **Size:** M · **Depends:** M1-T12, M1-T14, M1-T17
- **Do:**
  - Write the events that are missing today: `task.started`, `round.started` (with the Stage that caused it), `milestone.done` (from M1-T12), and `lease.taken` and `lease.released`.
  - Change `recentEvents` to `ORDER BY id DESC LIMIT ?` instead of loading the table and slicing it.
  - Extend the e2e test to assert on the full ordered list of event types and subjects.
- **Done when:** the e2e test fails if any event is missing, extra or out of order, and `recentEvents(10)` reads at most 10 rows.

### M1-T20 · STATUS.md after every state change
- **Kind:** cli · **Size:** S · **Depends:** none
- **Do:** Rewrite STATUS.md after `import`, `go`, `pause` and `resume`, as well as after each tick (ADR 0002). Do it in one place, for example a wrapper around every state-changing command, rather than one call per command.
- **Done when:** a CLI test runs each of those commands and sees STATUS.md reflect the change straight away.

### M1-T21 · One honest model of a paused queue
- **Kind:** core · **Size:** S · **Depends:** M1-T20
- **Do:**
  - Add `Store.isPaused()` and use it in both `tick` and `status`.
  - Model "paused until resumed" explicitly, for example `paused_until = NULL` with `reason` set or a `paused` flag, instead of `FAR_FUTURE`.
  - STATUS.md shows "paused (until resumed)" or "paused until <time>".
- **Done when:**
  - `FAR_FUTURE` is gone.
  - Both kinds of pause have a status snapshot.
  - `foreman resume` clears either kind.

### M1-T22 · Import: CLI shape and full parsing
- **Kind:** core · **Size:** M · **Depends:** none
- **Do:**
  - Make the command `foreman import <target-repo> <plan-dir>`, with both arguments required, as M1-T02 specifies.
  - Parse Do and Done when into `ParsedTask` and reject a Task missing either, with its line number.
  - Reject a duplicate Milestone ID with its line number.
  - Name the field the same from parse to store (`size_est` or `size`, one of them).
- **Done when:** parser tests cover a missing Do, a missing Done when and a duplicate Milestone, each with the right line, and `foreman import` with a missing argument prints usage.

### M1-T23 · Import is all-or-nothing
- **Kind:** core · **Size:** S · **Depends:** M1-T22
- **Do:**
  - Write the `.foreman/R-n/` files into a staging directory first. Commit the database transaction, then rename the staging directory into place. If either step fails, undo the other.
  - Work out each Task's `file_path` from its allocated ID inside the transaction, with no placeholder and no second pass.
  - Take the first Stage from `PIPELINE[0]` rather than writing `"workup"`.
- **Done when:** a test that makes the file write fail leaves no Request rows, and a test that makes the transaction fail leaves no files.

### M1-T24 · Domain types for the store
- **Kind:** core · **Size:** M · **Depends:** M1-T13, M1-T23
- **Do:**
  - Give union types to `TaskRow.stage` (`Stage`), `origin` (`planned | research | owner`), `lane` (`normal | fast`) and the Approval `kind` and `channel`, using the values in PLAN's data model.
  - Validate stored rows at the store boundary, then remove the `as Stage` cast in `tick`.
  - Rename `Outcome` to `Verdict` everywhere (CONTEXT: Verdict, avoid "result"). Use the uppercase values from CONTEXT (`PASS`, `FAIL`), so the store test and the engine agree.
  - Decide what `requests.status` means next to `phase`. Either use it, or drop it in a migration and remove it from PLAN's data model.
- **Done when:**
  - `tsc` rejects an unknown Origin or Stage.
  - No `as Stage` remains.
  - Nothing named `Outcome` remains.
  - `requests.status` is either used or gone from both the schema and PLAN.

### M1-T25 · Store tidy-up
- **Kind:** core · **Size:** S · **Depends:** M1-T24
- **Do:**
  - Pull the optional-filter shape shared by `listMilestones`, `listTasks`, `listRuns` and `listApprovals` into one private helper.
  - Make `Store.db` private.
  - Widen the "no SQL outside `src/store`" test to catch `DELETE`, `PRAGMA`, `CREATE`, `DROP`, `ALTER` and `.prepare(`.
- **Done when:** the widened test passes, `store.db` from outside the store is a type error, and the store tests pass unchanged.

### M1-T26 · Test hygiene
- **Kind:** core · **Size:** M · **Depends:** M1-T22
- **Do:**
  - Add a shared helper in `test/helpers.ts` for "create a Request, set it to building, add a Milestone", and use it in the engine, runner and status tests.
  - Move `import.test.ts`'s detailed assertions onto the fixture under `test/fixtures/plan/`. Keep one test that `docs/plan/TASKS.md` imports cleanly (M1-T02), with no counts.
  - Resolve paths from `import.meta.dirname`, not the working directory.
  - Remove temp directories in `after` hooks.
  - Hoist the imports in `main.test.ts` and import `main.ts` once.
- **Done when:**
  - `node --test` passes when run from the repo root and from `test/`.
  - Editing a dependency in `docs/plan/TASKS.md` does not break any test.
  - The temp directory is clean after a run.

### M1-T27 · The pre-push hook sets itself up
- **Kind:** infra · **Size:** S · **Depends:** none
- **Do:** Add a `prepare` script that runs `git config core.hooksPath .githooks` when inside a git checkout, so `npm install` turns the hook on. Drop the manual step from the README.
- **Done when:** a fresh clone followed by `npm install` blocks a push with a failing check, with no other setup.

### M1-T28 · The plan catches up with the code
- **Kind:** docs · **Size:** S · **Depends:** M1-T13, M1-T24
- **Do:**
  - Decide how a failed Workup routes: back to Workup as now, or to implement as M1-T03 says. CONTEXT says a Round comes from a failed review, Gate or Owner rejection, so also decide whether a Workup failure costs a Round. Make the code and its test match, and record the decision as a new ADR. Leave TASKS.md as it is.
  - Add the `counters` table and `tasks.ref` column to PLAN's data model.
  - Note `Store.memory` as the in-memory test store.
  - Add the `typecheck` script to the README.
- **Done when:** PLAN's data model matches `schema.ts` column for column, and the Workup decision is written in an ADR and the `route` tests.
