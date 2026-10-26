# Foreman v1: tasks

These are the tasks for [PLAN.md](./PLAN.md). IDs are `M<milestone>-T<nn>`. Each task is meant to be about 300 changed lines or fewer, tests included, and reviewable in one sitting.

- **Kind:** `core` (engine, store, config), `cli`, `infra` (images, scripts, git), `integration` (Docker, Claude, ntfy, Telegram), `agents` (AGENT.md and Skills), `docs`, `spike` (a time-boxed investigation that produces a written finding), `owner` (needs you).
- **Size:** S ≈ under 100 lines, M ≈ 100–300, L = split it before starting.
- **Depends:** tasks that must be merged first. Tasks with no dependency on each other can run in either order.

This file is also the input format for `foreman import` (M1-T02). From M6 on, foreman builds these tasks itself.

---

## M0 · Scaffold

### M0-T01 · Toolchain and check command
- **Kind:** infra · **Size:** S · **Depends:** none
- **Do:** Add `.tool-versions` (`nodejs 24.20.0`), `package.json` (`"type": "module"`, `bin: foreman`), and a strict `tsconfig.json` (`noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`). Add `biome.json`, then `src/cli/main.ts` printing its version and one `node:test` test.
- **Done when:**
  - `npm run check` (Biome + `tsc --noEmit` + `node --test`) passes.
  - `node src/cli/main.ts --version` works with no build step.

### M0-T02 · Repo hygiene
- **Kind:** infra · **Size:** S · **Depends:** M0-T01
- **Do:** Add a `.gitignore`, a README skeleton (purpose, links to CONTEXT, ADRs and plan, dev setup), and a `.githooks/pre-push` running `npm run check` (`core.hooksPath`). Add foreman's own `.foreman/config.toml` with `check = "npm run check"`.
- **Done when:** a push with a failing check is blocked locally, and the README explains setup in under one screen.

### M0-T03 · GitHub remote
- **Kind:** owner · **Size:** S · **Depends:** M0-T02
- **Do (you):** create the private repo, add it as the remote, and push `main`.
- **Done when:** `git push` works from the Mac.

---

## M1 · Tracer bullet

### M1-T01 · Store: schema and repositories
- **Kind:** core · **Size:** M · **Depends:** M0-T01
- **Do:** `node:sqlite` with migrations versioned by `PRAGMA user_version`. Create the tables from PLAN.md (`requests`, `milestones`, `tasks`, `task_deps`, `runs`, `approvals`, `leases`, `queue_state`, `events`), plus typed repository functions and ID allocation (`R-n`, `M-n`, `T-n`). The database lives at `$FOREMAN_HOME/foreman.db` (default `~/.foreman`).
- **Done when:**
  - Tests on a temporary database cover migrating from empty, migrating twice (a no-op), and creating and reading every entity.
  - No SQL appears outside `src/store`.

### M1-T02 · Import a hand-written plan
- **Kind:** core · **Size:** M · **Depends:** M1-T01
- **Do:** `foreman import <target-repo> <plan-dir>` parses `PLAN.md` and `TASKS.md` in this file's format (milestones, task headings, Kind, Size, Depends, Do, Done when) into a Request with its Milestones and Tasks (`origin = planned`). It writes `.foreman/R-n/{plan.md, tasks/T-n.md}` into the Target repo.
- **Done when:**
  - This repo's `docs/plan/TASKS.md` imports cleanly as a fixture.
  - An unknown dependency or a duplicate ID fails with the line number.

### M1-T03 · Engine: route and tick
- **Kind:** core · **Size:** M · **Depends:** M1-T01
- **Do:** A pure `route(stage, outcome, task) → Transition` over a hard-coded `[workup, implement, review]` Pipeline. `tick()` does the following:
  1. skips if the queue is paused;
  2. picks the next actionable Task (dependencies merged, earliest Milestone first, one at a time);
  3. takes a lease;
  4. runs the stage executor;
  5. routes the Task;
  6. writes an event.
- **Done when:**
  - Table tests cover `route()`: pass moves to the next stage, fail goes back to implement, and the last stage leads to done.
  - A tick with nothing to do returns `idle`.
  - Dependencies are respected.

### M1-T04 · Runner interface and FakeRunner
- **Kind:** core · **Size:** S · **Depends:** M1-T03
- **Do:** Define the `Runner.run(RunSpec) → RunResult` interface and an `agent` executor that calls it. `FakeRunner` reads a script (stage → verdict, files to write, usage) and writes the report file.
- **Done when:** the engine runs a Task through all stub stages with FakeRunner, and a scripted `fail` causes a Round.

### M1-T05 · STATUS.md renderer
- **Kind:** core · **Size:** S · **Depends:** M1-T01
- **Do:** `status.render(store)` shows Requests (phase, Mode), progress for each Milestone, a Task table (stage, Round, Origin, status), things waiting on the Owner, the last 10 events, and whether the queue is paused. It writes atomically to `$FOREMAN_HOME/STATUS.md` after every tick.
- **Done when:** a snapshot test covers a database with mixed states, and the file is never half-written (write to a temp file, then rename).

### M1-T06 · ntfy notifier
- **Kind:** integration · **Size:** S · **Depends:** M0-T01
- **Do:** A `Notifier` interface, an ntfy implementation (server and topic from config; title, priority and tags) and a fake ntfy HTTP server for tests. It sends on: Task done, Request done, engine error.
- **Done when:** the fake server records the expected calls, and an ntfy failure is logged but never stops the engine.

### M1-T07 · CLI skeleton
- **Kind:** cli · **Size:** M · **Depends:** M1-T02, M1-T03, M1-T05
- **Do:** Add `foreman import | go <R> | run [--until-idle] | status | pause | resume` using `parseArgs`, with `FOREMAN_HOME` overridable. `go` records a minimal Approval and moves the Request to `building`.
- **Done when:** `foreman --help` lists the commands, and every command has a test that runs it against a temporary `FOREMAN_HOME`.

### M1-T08 · End-to-end tracer test
- **Kind:** core · **Size:** S · **Depends:** M1-T04, M1-T06, M1-T07
- **Do:** Import a fixture plan with 2 Milestones and 4 Tasks (one dependency), run `go`, then `run --until-idle` with FakeRunner and one scripted review failure.
- **Done when:**
  - All Tasks are done and Rounds are recorded.
  - `STATUS.md` shows completion.
  - ntfy received a "Request done" ping.
  - The events table tells the whole story in order.

---

## M2 · Configurable pipeline

### M2-T01 · pipeline.toml schema
- **Kind:** core · **Size:** M · **Depends:** M1-T03
- **Do:** A zod schema covering:
  - stages (`name`, `type agent|gate|owner`, `agents`, `require all|any`, `gates`, `on_pass`, `on_fail`, `max_rounds`, `lanes`);
  - `kinds` (kind → stage → agents);
  - `breaker` (`per_stage`, `per_task`);
  - `notify`;
  - `lanes`.
  
  Also write `defaults/pipeline.toml` with the full v1 Pipeline from ADR 0005/0006 (owner stages and gates may still be stubs).
- **Done when:** invalid configs fail with readable messages (unknown stage in routing, unknown agent, a cycle with no exit), and the defaults validate.

### M2-T02 · Engine driven by config
- **Kind:** core · **Size:** M · **Depends:** M2-T01
- **Do:** Replace the hard-coded Pipeline. Routing comes from `on_pass`/`on_fail`. Add three executor types: `agent`, `gate` (with a stub registry) and `owner` (a stub that auto-approves for now). Multi-agent stages run their Agents in turn and combine Verdicts by `require`.
- **Done when:**
  - The M1 end-to-end test passes on `defaults/pipeline.toml`.
  - A test covers `require = "all"` with one failing reviewer → Round.

### M2-T03 · AGENT.md parser
- **Kind:** core · **Size:** S · **Depends:** M0-T01
- **Do:** Frontmatter schema: `model`, `effort`, `image`, `tools`, `skills.preload`, `skills.available`, `output.verdicts`, `timeout`, `max_tokens`. The body is a template with `{{task.*}}`, `{{request.*}}` and `{{paths.*}}` variables.
- **Done when:** a fixture Agent parses, and an unknown variable or an empty Verdict list is an error that names the file.

### M2-T04 · Skill resolution
- **Kind:** core · **Size:** S · **Depends:** M2-T03
- **Do:** Resolve each Skill name in this order: Target repo's `.foreman/skills/` → foreman's `skills/` → `~/.claude/skills/` (following symlinks). Return each Skill's folder and, for preloaded Skills, its `SKILL.md` body.
- **Done when:** precedence is tested, and a missing Skill is a config error listing the paths that were searched.

### M2-T05 · Prompt assembly
- **Kind:** core · **Size:** M · **Depends:** M2-T03, M2-T04
- **Do:** Build a `RunSpec`:
  - **System prompt:** the AGENT.md body, the preloaded Skills, the Output contract instructions and a pointer to the Precedents file.
  - **User prompt:** the Task file, Spec and Plan paths, earlier stage reports for this Task, and blocking findings from the last Round.
  - **Verdict:** a JSON schema built from `output.verdicts`.
- **Done when:** golden-file tests cover a first Round, a rework Round with findings, and a stage with no Skills.

### M2-T06 · Config layering
- **Kind:** core · **Size:** M · **Depends:** M2-T01, M2-T03
- **Do:** Merge foreman's defaults → the Target repo's `.foreman/config.toml` (plus `agents/` and `skills/`) → per-Request overrides (Mode, per-Task Agent overrides). `foreman config show R-n [--task T-n]` prints the resolved config with the source of each value.
- **Done when:** tests show a Target repo override winning over the default and a Request override winning over the Target repo, and `config show` names the source for each key.

### M2-T07 · Kind → Agents mapping
- **Kind:** core · **Size:** S · **Depends:** M2-T02, M2-T06
- **Do:** `agentsFor(task, stage)` uses `kinds`, then per-Task overrides, then falls back to the `default` Kind.
- **Done when:** a `ui` Task and an `api` Task get different reviewers, and an override recorded at Go wins.

### M2-T08 · End-to-end: configurable pipeline
- **Kind:** core · **Size:** S · **Depends:** M2-T05, M2-T07
- **Do:** Extend the end-to-end test with two Kinds that route to different fake Agents, one override at Go, and a broken `pipeline.toml`.
- **Done when:** the Runs record the expected Agents, and `foreman run` refuses to start on a broken config, naming the error.

---

## M3 · Real Runs in containers

### M3-T01 · Spike: Claude in a container
- **Kind:** spike · **Size:** S · **Depends:** M0-T01
- **Do:** Answer these questions:
  - Does a `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN` authenticate `claude -p` inside a container?
  - Does `--dangerously-skip-permissions` need a non-root user?
  - Does `--json-schema` return a reliable structured Verdict?
  - Which JSON result fields carry tokens, cache, context and cost?
  - What do usage-limit and auth errors look like?
  - Can `--agents <file>` replace `--append-system-prompt` for skill loading?
- **Done when:** `docs/spikes/claude-in-container.md` records the answers with real output. ADR 0001/0003/0004 are amended if any answer contradicts them.

### M3-T02 · Spike: egress allowlist
- **Kind:** spike · **Size:** S · **Depends:** M0-T01
- **Do:** Try an `internal: true` Docker network plus a proxy container (e.g. tinyproxy or squid) that allows only `api.anthropic.com`, `registry.npmjs.org` and `pypi.org` / `files.pythonhosted.org`.
- **Done when:** `docs/spikes/egress.md` shows `github.com` blocked and Anthropic and npm reachable from an Agent container, and ADR 0003 is amended if a fallback is needed.

### M3-T03 · Agent images and network
- **Kind:** infra · **Size:** M · **Depends:** M3-T01, M3-T02
- **Do:**
  - `images/base/Dockerfile`: Node 24, git, Python 3 + `uv`, a pinned Claude Code, non-root user `agent`.
  - The egress proxy image and its network definition.
  - `foreman images build`.
- **Done when:** both images build, and a container on the network passes the spike's allow and deny checks.

### M3-T04 · ContainerRunner
- **Kind:** integration · **Size:** M · **Depends:** M3-T03, M2-T05
- **Do:** `docker run --rm` with:
  - the worktree mounted at `/work`;
  - Skills copied into `/home/agent/.claude/skills`;
  - the token from `$FOREMAN_HOME/claude.env`;
  - the egress network;
  - the label `foreman.run=<id>`;
  - a wall-clock timeout that kills the container.
  
  Parse the JSON result into a `RunResult`.
- **Done when:** tests through a fake `docker` shim (which calls the fake `claude`) cover success, timeout, a non-zero exit and an invalid Verdict.

### M3-T05 · Run recording
- **Kind:** core · **Size:** M · **Depends:** M3-T04
- **Do:**
  - Fill in every `runs` column (tokens in/out, cache read/write, context peak, cost, duration, Verdict).
  - Save the raw JSON to `$FOREMAN_HOME/runs/<id>.json` and copy the report into `.foreman/R-n/runs/`.
  - A missing output file or an invalid Verdict counts as an *infrastructure* failure: one retry, then an Escalation. It does not cost a Round.
- **Done when:** a fixture JSON result produces a complete row, and the retry-then-escalate path is tested.
- **Decisions:**
  - Every `RunFailure` (timeout, failed container, invalid Verdict) and a Verdict with no report is an infrastructure failure: one retry in the same tick, each attempt its own `runs` row, then an Escalation. Until M5-T06 an Escalation is a `parked` Task, a `task.escalated` event and a high-priority ntfy; the engine goes on to the next Task. M5-T06 must also let a parked Task's dependants proceed once it is answered.
  - A bad token (`auth`: 401 or "Not logged in") is not retried and parks nothing: the engine stops with an engine-error ntfy, and the Task stays queued, for the Owner to fix the token.
  - The context peak is the largest context among the calls in `usage.iterations`. Claude's result lists only the last call, so this approximates the peak; exact numbers need `stream-json` (not done).
  - The report is not copied: the Agent already writes it to `<target repo>/.foreman/R-n/runs/`. M4-T02 commits it from the worktree.
  - M3-T06's usage-limit check must run before the retry, or a limit will be retried and escalated.

### M3-T06 · Pause on usage limit
- **Kind:** core · **Size:** S · **Depends:** M3-T05
- **Do:** Recognise the usage-limit error (its shape comes from M3-T01), then set `queue_state.paused_until` to the reset time, send one ntfy and resume on its own. `foreman resume` overrides the pause.
- **Done when:** a scripted limit error pauses the queue, the Task is not charged a Round, and the queue resumes after the (faked) clock passes the reset time.
- **Decisions:**
  - The Runner recognises a limit by Claude's `is_error` text ("You've hit/reached your … limit"), not by `rate_limit_event`: the Runner uses `--output-format json`, whose result carries no such event. The reset time is the first `"resetsAt"` (epoch seconds) in the output, if any. Both are inferred from the spike, not seen, and must be confirmed against the first real limit.
  - A limit is never retried and never escalates: `tick` pauses the queue (`paused_until` = reset, reason, a `queue.paused` event), puts the Task back to `queued` at the same Stage with no Round, and `runEngine` sends one main-topic ntfy and stops.
  - With no reset time, or one not in the future, the pause is a fixed 30 minutes; if the limit is still on, the next Run pauses again.
  - An Owner's `foreman pause` set while the Run was in flight is kept: the limit does not turn it into a timed pause.
  - Known limits: only the usage-limit text triggers the pause (any other limit wording is an ordinary failure: one retry, then an Escalation); a multi-Agent Stage that hits the limit midway reruns its first Agents after the reset; the Task's `task.started` event repeats, as after a crash.
  - "Resumes on its own" means `tick` stops treating the queue as paused once `paused_until` passes. Nothing wakes `foreman run`: the next `run` picks the Task up.

### M3-T07 · Smoke test
- **Kind:** integration · **Size:** S · **Depends:** M3-T05
- **Do:** `npm run smoke` makes one real Run (a trivial Agent that writes `hello.md` with Verdict `PASS`) in a real container, and prints the recorded row.
- **Done when:** it passes on your Mac with your subscription token. It is not part of `npm run check`.
- **Decisions:**
  - It builds the images first, runs against a throwaway repo and an in-memory Store, and removes both afterwards. The token comes from `$FOREMAN_HOME/claude.env`. `test/smoke.test.ts` covers its logic through the fake `docker`.
  - First real run (2026-10-26): `PASS`, `hello.md` written, one `runs` row with tokens, cost and duration. `context_peak` was null: the real result had no `usage.iterations`, so the M3-T05 approximation yields nothing for a one-call Run.

---

## M4 · Git and Gates

### M4-T01 · Git module
- **Kind:** infra · **Size:** M · **Depends:** M1-T01
- **Do:**
  - Add and remove worktrees under `$FOREMAN_HOME/worktrees/<repo>/<task>`.
  - Branches: `foreman/R-n/m<k>`, `foreman/R-n/m<k>/T-n`.
  - Commit as the Owner's git identity with a `Co-Authored-By: foreman` trailer.
  - `--no-ff` merge into the Milestone branch, push a branch, diff stat against the base.
- **Done when:** tests on temporary repos with a bare remote cover branch creation, commit, merge and push. A merge conflict is reported as an outcome, never auto-resolved.

### M4-T02 · Commit protocol
- **Kind:** core · **Size:** M · **Depends:** M4-T01, M3-T05
- **Do:**
  - Agents never commit. After each Agent stage, foreman commits the worktree.
  - Changes to test files (globs from config) go in a **separate** `test:` commit.
  - `.foreman/R-n/` files go in a `foreman:` commit.
- **Done when:** a Run that touches source, tests and reports produces three commits in a fixed order, and an Agent's own `git commit` attempt is undone and flagged (the `.git` mount is read-only).

### M4-T03 · Gate framework and check-command Gate
- **Kind:** core · **Size:** M · **Depends:** M2-T02, M3-T03
- **Do:** A `gate` executor runs the named Gates in turn and records them in `gate_results`. The `check_passes` Gate runs the Target repo's check command in a base container and attaches its output.
- **Done when:** a passing and a failing fixture repo give the right outcomes, and a failure's output is part of the next Implement prompt.

### M4-T04 · Red-before / green-after Gate
- **Kind:** core · **Size:** M · **Depends:** M4-T02, M4-T03
- **Do:** Workup's report names the acceptance test command.
  - `red_before`: on the Task branch with only the `test:` commit applied, the test must **fail**.
  - `green_after`: after Implement, it must pass.
- **Done when:** fixtures cover a test that already passes (a fake red → the Gate fails), a correct red → green, and an implementation that leaves the test red.

### M4-T05 · Test-integrity Gate
- **Kind:** core · **Size:** M · **Depends:** M4-T02
- **Do:** In the Task diff, flag:
  - deleted test files;
  - newly added skip/focus markers (`.skip`, `.only`, `xit`, `it.todo`, `pytest.mark.skip`, `@Disabled`; the patterns are configurable);
  - a net drop in assertions in changed test files.
- **Done when:** each pattern has a fixture, and an allowlist line in the Task file (`allow_test_removal: <reason>`) lets an approved removal through.

### M4-T06 · Diff-size Gate
- **Kind:** core · **Size:** S · **Depends:** M4-T01
- **Do:** Count changed lines, excluding `.foreman/`, lockfiles and generated globs from config. Going over the ceiling routes to `SCOPE_CHANGE` (the M5 flow) instead of failing.
- **Done when:** lines under, at and over the ceiling are tested, and exclusions are respected.

### M4-T07 · End-to-end: real code through the Gates
- **Kind:** core · **Size:** M · **Depends:** M4-T04, M4-T05, M4-T06
- **Do:** A fixture Target repo (a tiny TS library), with the fake `claude` writing real code and tests. Cover a clean pass, a fake red, weakened tests and an oversized diff.
- **Done when:** the git graph (commits and merges on the Milestone branch) and the `gate_results` match what the test expects for each case.

---

## M5 · Owner control

### M5-T01 · Approvals
- **Kind:** core · **Size:** M · **Depends:** M2-T02
- **Do:** An `owner` module with `request(kind, subject)` and `decide(id, verdict, notes)`. `owner` stages create a pending Approval and the engine skips that Task until it is decided. CLI: `foreman approvals`, `foreman approve <A|T|M-id>`, `foreman reject <id> "notes"`.
- **Done when:** a pending Approval holds the Task and lets other Tasks run (later on, when parallelism exists), and deciding it resumes the Task on the next tick.

### M5-T02 · Manual and Automatic Mode
- **Kind:** core · **Size:** M · **Depends:** M5-T01
- **Do:**
  - The Mode is per Request, with its default from config.
  - Manual adds a `task_approval` owner stage before merge.
  - `reject` costs a Round, and its notes reach the Implement prompt as a blocking finding.
  - `foreman mode R-n manual|auto` takes effect from the next Task.
- **Done when:** end-to-end tests cover a Request in manual (pause, approve, merge), a reject that leads to rework, and switching to auto mid-Request.

### M5-T03 · Owner commits in Manual Mode
- **Kind:** core · **Size:** S · **Depends:** M5-T02, M4-T03
- **Do:** On `approve`, detect commits on the Task branch that foreman didn't make (by author or trailer). If there are any, re-run the Gate stages before merging.
- **Done when:** a manual commit that breaks the check is caught and the Task goes back with the Gate output, and a clean manual commit merges.

### M5-T04 · Milestone completion and Approval
- **Kind:** core · **Size:** M · **Depends:** M5-T01, M4-T01
- **Do:** When every Task in a Milestone is done:
  1. the Milestone gate stages run (full check on the Milestone branch);
  2. an Owner Milestone Approval is requested;
  3. on approval: merge to `main`, push, tag `R-n-m<k>`; the next Milestone branches from the new `main`.
- **Done when:** in the end-to-end test, `main` moves only after `approve M-n`, and `reject` creates an `owner`-origin Task with the notes.

### M5-T05 · Breaker
- **Kind:** core · **Size:** S · **Depends:** M2-T02
- **Do:** Enforce the Round limits for each stage and each Task from config. When one trips, park the Task and start an Escalation (M5-T06).
- **Done when:** with limits 3/6, the 4th review Round, or the 7th Round in total, parks the Task.

### M5-T06 · Handoff and Escalation
- **Kind:** core · **Size:** M · **Depends:** M5-T05
- **Do:**
  - On a `BLOCKED` Verdict or a tripped Breaker, the Agent's Handoff (situation, what was tried, blocker, decision needed; Skill `handoff`) is stored, an `escalations` row is written, and a high-priority ntfy is sent.
  - CLI: `foreman escalations`, `foreman answer E-n "text" [--resume-at <stage>] [--precedent]`.
  - The answer goes into the next prompt.
- **Done when:** the path from escalation to answer to resume is tested end to end, and the Round counters reset on answer.

### M5-T07 · Precedents
- **Kind:** core · **Size:** S · **Depends:** M5-T06
- **Do:** `--precedent` appends a dated entry (question, decision, Task) to the Target repo's `.foreman/precedents.md`. Prompt assembly tells planner, reviewer and implementer Agents to read it before returning `BLOCKED`.
- **Done when:** the file only ever grows (append-only), and the prompts reference it.

### M5-T08 · Scope change: flow
- **Kind:** core · **Size:** M · **Depends:** M5-T01, M4-T06
- **Do:** A `SCOPE_CHANGE` Verdict (or an oversized diff) parks the Task. Then:
  1. the planner Agent runs in amend mode and writes `amendment-A-n.md`;
  2. plan review checks it;
  3. an `amendment` Approval is requested from the Owner.
- **Done when:** the state flow is tested with fake Agents, and the Task stays parked until the Approval is decided.

### M5-T09 · Scope change: apply the Amendment
- **Kind:** core · **Size:** M · **Depends:** M5-T08, M1-T02
- **Do:** Parse the planner's structured output (edit a Task, split into new Tasks, drop a Task, change dependencies) and apply it in one transaction. Update the Task files.
- **Done when:** a split of one Task into two with a dependency between them applies cleanly, and an invalid Amendment is rejected without partial writes.

### M5-T10 · First real Agents
- **Kind:** agents · **Size:** M · **Depends:** M3-T07, M4-T07
- **Do:**
  - Agents: `workup-tdd`, `implementer-tdd` (moves up to Opus on Round ≥ 2), `reviewer-standards`, `reviewer-spec` and `planner` (amend mode).
  - foreman Skills: `verdict-discipline` (Output contract rules) and `handoff`. The user's `tdd` and `code-review` Skills are reused.
  - Wire them into `defaults/pipeline.toml`.
- **Done when:** `npm run smoke -- --pipeline` takes one real Task on the fixture Target repo through workup → implement → gates → review with real Claude.

### M5-T11 · Install locally and import for dogfooding
- **Kind:** infra · **Size:** S · **Depends:** M5-T10
- **Do:**
  - `npm run install-local` copies a tagged `main` to `$FOREMAN_HOME/app` and puts a `foreman` shim on `PATH`.
  - `docs/dogfood.md` checklist: install, import `docs/plan` M6+ as R-1 against this repo, `go --mode manual`.
- **Done when:** the installed foreman runs while the checkout is on another branch, and R-1 shows M6–M10 in `STATUS.md`.

---

## M6 · Telegram and summaries · *foreman builds this*

### M6-T01 · Telegram bot loop
- **Kind:** integration · **Size:** M · **Depends:** M5-T11
- **Do:**
  - Long-poll `getUpdates` with the token from `$FOREMAN_HOME/telegram.env`.
  - Accept private chats from the Owner's ID only; drop updates older than 10 minutes and say so once.
  - Run inside `foreman run`.
  - Add a fake Telegram API server for tests.
- **Done when:** a stranger's message is dropped and logged by ID only, and stale updates are dropped and counted.

### M6-T02 · Commands from Telegram
- **Kind:** integration · **Size:** M · **Depends:** M6-T01
- **Do:**
  - Route `/status`, `/approve`, `/reject`, `/answer`, `/mode`, `/pause`, `/resume`, `/go`, `/admit`, `/drop` and `/consent` through the same `commands` module as the CLI.
  - Replying to a foreman message decides the thing it was about.
- **Done when:** every command has a fake-server test, and the CLI and Telegram give the same results for the same input.

### M6-T03 · Outbound Owner messages
- **Kind:** integration · **Size:** M · **Depends:** M6-T02
- **Do:**
  - Approval requests come with inline Approve/Reject buttons.
  - Escalations carry the Handoff text; text over about 4000 characters is split, and anything over 3 messages is sent as a `.md` file.
  - Amendments show the proposed Task changes.
- **Done when:** a button press decides the Approval, and long Handoffs arrive whole.

### M6-T04 · Task summary
- **Kind:** core · **Size:** M · **Depends:** M3-T05
- **Do:** When a Task ends, write `.foreman/R-n/summary/T-n.md` and send it on the ntfy `foreman-usage` topic at low priority. It lists:
  - each Run's stage, Agent, model, tokens, context peak, cost, duration and Verdict;
  - the Task's totals;
  - running totals for the Request.

  `notify.usage = "task" | "off"`.
- **Done when:** a Task with 6 Runs gives exactly one ntfy, and its numbers match the `runs` rows.

### M6-T05 · Retrospective queries
- **Kind:** cli · **Size:** S · **Depends:** M3-T05
- **Do:** `foreman runs [--request R] [--task T] [--agent A] [--since D] [--csv]`, plus `--by stage|agent|model` aggregates (cost, average Rounds, Verdict counts, average context).
- **Done when:** the aggregates over a fixture database match totals worked out by hand.

---

## M7 · Planning phase

### M7-T01 · New Request
- **Kind:** cli · **Size:** S · **Depends:** M5-T01
- **Do:** `foreman new <repo-path>` registers a Request for an existing repo. `foreman new --create <name>` runs `git init` under `~/Documents/projects/personal/<name>`, and records that a remote is wanted, pending Go.
- **Done when:** both paths are tested, and `--create` refuses a directory that already exists.

### M7-T02 · Intake
- **Kind:** agents · **Size:** M · **Depends:** M7-T01, M3-T04
- **Do:** `foreman intake R-n` starts an **interactive** `claude` with a TTY in a container, as the `intake` Agent (Skills: `grilling`, `domain-modeling`). The output is `.foreman/R-n/spec.md`, plus `CONTEXT.md` and ADRs in the Target repo. On exit the Request moves to `spec_ready`.
- **Done when:** a manual run produces a Spec, and leaving without one leaves the Request in `intake`.

### M7-T03 · Plan stage
- **Kind:** agents · **Size:** M · **Depends:** M7-T02
- **Do:** A `planner` Agent writes `plan.md` with Milestones (Scaffold first for a new repo) and any ADRs. The Milestones are stored from the planner's structured output.
- **Done when:** a fixture Spec produces a Plan with Milestones, and a new repo always gets Scaffold as Milestone 1.

### M7-T04 · Decompose stage
- **Kind:** agents · **Size:** M · **Depends:** M7-T03, M1-T02
- **Do:** A `decomposer` Agent writes Task files with Kind, size estimate, dependencies, acceptance criteria and lane. They are stored via the import parser.
- **Done when:** the generated Tasks pass the same validation as `foreman import`, and an estimate over the ceiling is split before storing.

### M7-T05 · Plan review
- **Kind:** agents · **Size:** S · **Depends:** M7-T04
- **Do:** A `plan-reviewer` Agent checks Spec ↔ Plan ↔ Tasks (coverage, sizing, dependencies, testability). Rework goes back to Plan or Decompose, with the Breaker applied.
- **Done when:** a scripted rejection loops once and then passes, and a third rejection escalates.

### M7-T06 · Go package
- **Kind:** core · **Size:** M · **Depends:** M7-T05, M6-T03
- **Do:**
  - Send a Go summary by Telegram and CLI: Milestones, a Task table, Kind → Agents, Mode, and the remote to create.
  - `foreman go R-n [--mode manual|auto] [--agent T-3:review=reviewer-security]`.
  - On Go with `--create`: `gh repo create --private`, then push.
- **Done when:** nothing builds before Go, overrides from Go show up in `config show`, and repo creation runs only after Go (tested with a fake `gh`).

### M7-T07 · Scaffold conventions
- **Kind:** agents · **Size:** M · **Depends:** M7-T03, M4-T03
- **Do:** A `scaffolder` Agent and the `scaffold` Kind write `.foreman/config.toml` (check, run, healthcheck, e2e) and a placeholder E2E test that passes. A `config_valid` Gate runs each declared command once.
- **Done when:** a new empty repo reaches Milestone 1 done with all four commands working.

---

## M8 · Live verification

### M8-T01 · Web image
- **Kind:** infra · **Size:** S · **Depends:** M3-T03
- **Do:** `images/web/Dockerfile` adds Playwright and Chromium to the base image.
- **Done when:** a container can screenshot a page served inside it.

### M8-T02 · App lifecycle in Verify
- **Kind:** core · **Size:** M · **Depends:** M8-T01, M2-T06
- **Do:** Start the Target repo's `run` command in the background inside the Verify container, poll `healthcheck` with a timeout, save the app logs as Evidence, and tear down afterwards.
- **Done when:** a healthy app and an app that never becomes healthy are both handled, and logs are always saved.

### M8-T03 · Web verifier
- **Kind:** agents · **Size:** M · **Depends:** M8-T02
- **Do:** A `verifier-web-playwright` Agent with Skill `verify-web` (drive the change described in the acceptance criteria; save screenshots and a trace under `evidence/T-n/`).
- **Done when:** on a fixture web app, a real Run produces screenshots and PASS for a working change, and FAIL for a broken one.

### M8-T04 · API verifier
- **Kind:** agents · **Size:** S · **Depends:** M8-T02
- **Do:** A `verifier-api` Agent saves curl request/response transcripts as Evidence.
- **Done when:** a fixture API gives PASS and FAIL cases with transcripts.

### M8-T05 · E2E handling
- **Kind:** core · **Size:** M · **Depends:** M8-T02, M4-T02
- **Do:** Run the Target repo's E2E command. Verifiers add E2E tests for the change, committed separately as `test:`. With `e2e_red_before = true`, also show that the new E2E test fails on the base commit.
- **Done when:** both settings are tested on a fixture.

### M8-T06 · Evidence Gate
- **Kind:** core · **Size:** S · **Depends:** M8-T03
- **Do:** Check that the Evidence files exist and are referenced in the Verify report, and that the Verdict is PASS.
- **Done when:** a PASS with no Evidence fails the Gate.

### M8-T07 · .env Consent
- **Kind:** core · **Size:** M · **Depends:** M8-T02, M6-T03
- **Do:** On the first Verify for a repo with a `.env`, request a `consent` Approval; the answer is stored per repo. If yes, mount `.env` read-only into **Verify containers only**.
- **Done when:** tests check the mount lists for every stage type (it is absent everywhere except Verify), and "no" runs Verify without it.

---

## M9 · Research

### M9-T01 · Per-Task researcher
- **Kind:** agents · **Size:** M · **Depends:** M5-T02
- **Do:** A `researcher-task` Agent (Sonnet) runs after merge (in manual, after `approve`). It reads the diff, Spec, Plan and open Tasks, and returns at most 3 structured findings: `in_spec`, title, why, acceptance criteria, Kind.
- **Done when:** a fixture gap in the Spec produces an `in_spec` finding, and a feature idea produces an out-of-spec finding.

### M9-T02 · Findings become Tasks and Proposals
- **Kind:** core · **Size:** M · **Depends:** M9-T01
- **Do:**
  - An in-spec finding becomes a Task (`origin = research`, `parent_task_id`) in the current Milestone.
  - An out-of-spec finding becomes a Proposal.
  - `foreman proposals`, `admit P-n [--milestone M]` and `drop P-n` work from the CLI and Telegram.
- **Done when:** an admitted Proposal becomes an `owner`-origin Task, and a dropped one never comes back.

### M9-T03 · Duplicate check
- **Kind:** core · **Size:** S · **Depends:** M9-T02
- **Do:** Before filing, compare against open Tasks and Proposals (normalised titles plus token overlap of the acceptance criteria). A duplicate is linked to the existing item, not filed.
- **Done when:** a reworded duplicate is caught in the fixture, and a genuinely new finding is filed.

### M9-T04 · Per-Milestone researcher
- **Kind:** agents · **Size:** S · **Depends:** M9-T02, M5-T04
- **Do:** An optional `researcher-milestone` Agent (Opus) looks across the whole Milestone before Milestone verify. It can be turned on or off in `pipeline.toml`.
- **Done when:** both settings are tested.

### M9-T05 · Origin view and Growth alert
- **Kind:** core · **Size:** S · **Depends:** M9-T02, M1-T05
- **Do:** `STATUS.md` shows planned / research / owner counts per Milestone. A non-blocking ntfy fires once per Milestone when research Tasks pass 50% of the planned Tasks.
- **Done when:** the alert fires exactly once at the threshold.

---

## M10 · Hardening and docs

### M10-T01 · Fast lane
- **Kind:** core · **Size:** S · **Depends:** M7-T04
- **Do:** Tasks with `size_est` under the threshold (30 lines by default) get `lane = fast`. Pipeline stages declare which lanes they apply to: the fast lane skips a separate Workup and allows one review Round.
- **Done when:** a fast Task skips Workup in the end-to-end test.

### M10-T02 · Time and token caps
- **Kind:** core · **Size:** S · **Depends:** M5-T05
- **Do:** Per-stage wall-clock caps (the container is killed) and per-stage token caps (checked from the Run's recorded usage) feed the Breaker.
- **Done when:** a scripted over-cap Run trips the Breaker.

### M10-T03 · Request token budget
- **Kind:** core · **Size:** S · **Depends:** M3-T05
- **Do:** An optional `token_budget` per Request. Crossing it escalates instead of starting the next Run.
- **Done when:** this is tested end to end.

### M10-T04 · Sweeper hardening
- **Kind:** core · **Size:** M · **Depends:** M3-T04, M4-T01
- **Do:** A periodic sweep that:
  - re-queues expired leases;
  - removes orphaned containers (labelled `foreman.run`);
  - prunes worktrees of finished Tasks.
- **Done when:** the test kills `foreman run` mid-Run, starts it again, and the Task finishes with no duplicate commits.

### M10-T05 · Launch script and doctor
- **Kind:** infra · **Size:** S · **Depends:** M6-T01
- **Do:** `scripts/foreman-start` (a tmux session `foreman` with `caffeinate -s foreman run`) and `foreman doctor`, which checks Docker, the images, the Claude token, ntfy, Telegram, the database and the installed version.
- **Done when:** `doctor` names each failing check with how to fix it.

### M10-T06 · README
- **Kind:** docs · **Size:** M · **Depends:** M9-T05
- **Do:** Write the full README:
  - one-time setup (`setup-token`, bot, ntfy topics, images);
  - every command;
  - a walkthrough of daily use and Manual Mode;
  - references for `pipeline.toml`, AGENT.md and the Target repo's `.foreman/config.toml`;
  - troubleshooting.
- **Done when:** a fresh read-through by you, following only the README, sets foreman up on a clean `FOREMAN_HOME`.

### M10-T07 · Complete the Agent library
- **Kind:** agents · **Size:** M · **Depends:** M6-T05
- **Do:** Add `reviewer-security`, `implementer-ui` and `implementer-docs`. Trim prompts using retrospective data (context use per Agent).
- **Done when:** each new Agent has passed one real smoke Run, and the trimmed prompts lower the average context peak in `foreman runs --by agent`.
