# Foreman v1: implementation plan

Written 2026-10-26, from the design in [CONTEXT.md](../../CONTEXT.md) and [ADRs 0001–0009](../adr/). The tasks are in [TASKS.md](./TASKS.md).

## Approach

1. **Tracer bullet first.** Milestone 1 takes one Request through *stub* Stages end to end, with real SQLite, `STATUS.md`, CLI and ntfy. Each later Milestone fills in one layer behind a seam that already works. The system never sits half-wired.
2. **Fakes before the real thing.** Every external dependency has a fake: `claude`, Docker, git remote, ntfy, Telegram. These fakes let the whole pipeline be tested end to end in seconds. Real integrations come in behind the same interfaces.
3. **Spike the risky parts before building on them.** M3 starts with spikes on `claude -p` in a container, subscription auth, the egress allowlist and structured Verdicts. If a spike fails, the matching ADR is revised before M3 continues.
4. **Dogfood from M6.** Once M5 is done, foreman can run Tasks with real Agents, Gates, git and Manual Mode Approvals through the CLI. From then on, **foreman builds its own remaining Milestones** in Manual Mode, starting from this plan imported by hand (`foreman import`). Each Task you approve doubles as a test of foreman itself.

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node **24.20.0** (asdf `.tool-versions`) | LTS. Built-in `node:sqlite` and TypeScript type stripping, so there is no build step to run it |
| Language | TypeScript, `tsc --noEmit` for type checks | ADR 0001 |
| Tests | `node:test` + `node:assert` | No test-framework dependency |
| Lint/format | Biome | One tool, fast |
| Dependencies | `smol-toml`, `yaml` (frontmatter), `zod` (config validation with readable errors) | Keep the list short. Any other dependency needs a reason |
| CLI parsing | `node:util` `parseArgs` | No dependency |
| Agents | `claude -p --output-format json --json-schema … --append-system-prompt … --model … --effort … --dangerously-skip-permissions` | ADR 0001 / 0003. Verdicts come back as structured output, not parsed from prose |
| Containers | Docker, one per Run. An allowlisting egress proxy container on an `internal` network | ADR 0003, same pattern as knowledge's ADR 0001 relay |

The single repo-wide check is `npm run check` = Biome + `tsc --noEmit` + `node --test`. foreman's own `.foreman/config.toml` points at it, so foreman runs the same check on itself.

## Architecture

The modules are deep: each has a small interface over a lot of behaviour. Each external system sits behind one interface with a real and a fake implementation.

```
cli ─┐
tg  ─┼─▶ commands ──▶ engine ──▶ stage executors ──┬─▶ runner ──▶ (docker ▸ claude -p)
     │   (one bus)     │  ▲                         ├─▶ gates  ──▶ (git, check cmd, files)
     │                 │  └── sweeper               └─▶ owner  ──▶ approvals
     │                 ▼
     └──────────────  store (SQLite)  ──▶ status (STATUS.md)   notify (ntfy, telegram)
                       ▲
               config (pipeline.toml, AGENT.md, skills, layers)      git (worktrees, branches, merge, push)
```

| Module | Owns | Interface (sketch) |
|---|---|---|
| `store` | SQLite schema, migrations, every query | Typed repositories: `requests`, `tasks`, `runs`, `approvals`, `events`… Nothing else touches SQL |
| `config` | Loading and merging the three layers, validating `pipeline.toml`, parsing AGENT.md, resolving skills | `loadConfig(targetRepo, requestOverrides) → ResolvedConfig`, `agentsFor(task, stage)` |
| `engine` | The state machine: picking the next actionable Task, leases, routing pass/fail, Rounds, Breaker, Milestone completion | `tick() → TickResult`, pure routing in `route(stage, verdict, task) → Transition` |
| `runner` | Running one Agent Run: assembling the prompt, launching the container, collecting the result | `Runner.run(RunSpec) → RunResult` (impls: `FakeRunner`, `ContainerRunner`) |
| `gates` | Each Gate as a small function over the worktree and the database | `Gate.check(ctx) → {passed, detail}`, registered by name. A Gate returns this `GateResult`, never a Verdict; the gate executor turns `passed` into the Stage's `PASS` or `FAIL` |
| `git` | Worktrees, branches, commits, `--no-ff` merges, push, diff stats, red-before checkouts | `Git` (impls: real git; tests use temp repos with a bare remote) |
| `owner` | Approval requests and replies, Escalations, Proposals, Consent, Precedents | `request(kind, subject)`, `decide(id, verdict, notes)` |
| `commands` | Every Owner command, used by both the CLI and Telegram | `execute(Command) → Reply` |
| `notify` | ntfy pings, Telegram outbound | `Notifier.send(Notification)` (impls: real, fake, multi) |
| `telegram` | The bot: long-polling, owner check, staleness, mapping replies to commands | Adapter into `commands` |
| `status` | Rendering `STATUS.md` from the store | `render(store) → string` |

**Engine loop.** `foreman run` loops `tick()`. Each tick:
1. stops if the queue is paused;
2. sweeps expired leases;
3. picks the next actionable Task (not blocked by dependencies or approvals, oldest Milestone first, one at a time);
4. takes a lease;
5. runs the current Stage's executor;
6. records the result;
7. routes the Task;
8. writes an event and re-renders `STATUS.md`.

Every step is idempotent, so a crash mid-Run is recovered by the Sweeper.

**Stages are data.** The engine knows only three executor types: `agent`, `gate` and `owner`. Workup, Implement, Review, Verify and Research are names in `pipeline.toml`, not code paths.

**Agents come from Kinds.** A Stage never names its Agents. `agentsFor(task, stage)` takes the Task's per-Task override, then its Kind's entry for the Stage, then the `default` Kind's entry (ADR 0011). Every agent Stage must have a `[kinds.default]` entry, which config validation checks.

**Overrides at Go.** The per-Task Agent overrides "recorded at Go" are written straight to `agent_overrides` until M7-T06 adds `foreman go --agent`. Until then they are a seam for tests, not something an Owner can set.

**Lanes.** Lane skipping (a Stage's `lanes`, and a failed Stage's `on_fail` target having to run in the same lanes) landed with M2-T02. M10-T01 therefore adds only the fast lane's size threshold and its one-review-Round limit.

## Data model (SQLite)

Tables marked *(later)* are not in `src/store/schema.ts` yet. Their Milestone adds them as a new migration. Every other table matches `schema.ts` column for column. `schema.ts` is the source of truth, so change it first and this list after.

```
counters     (kind, n)   -- the last number issued per ID kind (request, milestone, task, approval); the `n` in `R-n`, `M-n`, `T-n`, `A-n`
requests     (id 'R-n', title, target_repo, mode manual|auto, phase planning|building|done,
              token_budget, created_at)
milestones   (id 'M-n', request_id, seq, title, branch, status, created_at)
tasks        (id 'T-n', milestone_id, seq, ref, title, kind, origin planned|research|owner,
              parent_task_id, size_est, lane normal|fast, stage, stage_state, round_stage,
              round_total, status queued|active|awaiting_owner|parked|done|dropped,
              agent_overrides json, branch, file_path)   -- ref = the plan file's own ID (e.g. `M1-T03`)
task_deps    (task_id, depends_on)
runs         (id, task_id, request_id, stage, agent, model, effort, started_at, ended_at,
              verdict, tokens_in, tokens_out, cache_read, cache_write, context_peak,
              cost_usd, duration_ms, exit_code, report_path, error)
gate_results (id, task_id, stage, gate, passed, detail, at)   -- (later)
approvals    (id 'A-n', kind go|task|milestone|amendment|consent, subject_id, status
              pending|approved|rejected, notes, channel cli|telegram, requested_at, decided_at)
escalations  (id 'E-n', task_id, handoff_path, status open|answered, answer, precedent bool)   -- (later)
proposals    (id 'P-n', request_id, from_task_id, title, body_path, status open|admitted|dropped)   -- (later)
consents     (repo_path, granted bool, decided_at)   -- (later)
leases       (task_id, holder, expires_at)
queue_state  (paused, paused_until, reason)   -- paused with null paused_until = until resumed
events       (id, at, type, subject, payload json)   -- append-only, used for retrospectives
```

## File layout

**The foreman repo**
```
src/{cli,commands,engine,store,config,runner,gates,git,owner,notify,telegram,status}/
defaults/pipeline.toml            # foreman's default Pipeline
agents/<name>/AGENT.md            # default Agent library
skills/<name>/SKILL.md            # foreman-specific Skills (handoff format, verdict discipline)
images/{base,web}/Dockerfile      # Agent images
test/fakes/{claude,ntfy,telegram}/
docs/{adr,plan}/  CONTEXT.md  README.md
```

**Foreman's data directory** (`~/.foreman/`, outside every repo): `foreman.db`, `STATUS.md`, `telegram.env`, `claude.env` (subscription token), `worktrees/<repo>/<task>/`.

**In a Target repo:** `.foreman/config.toml` (check, run, healthcheck and e2e commands, Kinds, overrides, `e2e_red_before`), optional `.foreman/agents/` and `.foreman/skills/`, and `.foreman/R-<n>/` (`spec.md`, `plan.md`, `tasks/T-<n>.md`, `runs/<run-id>-<stage>.md`, `handoffs/`, `evidence/T-<n>/`, `summary/T-<n>.md`), committed with the code. `precedents.md` lives at `.foreman/precedents.md`.

## Milestones

| # | Milestone | Ends with | Dogfood? |
|---|---|---|---|
| M0 | Scaffold | Empty repo with `npm run check` green, CI-equivalent pre-push | by hand |
| M1 | Tracer bullet | `foreman import` → `go` → `run` takes a Request through stub Stages to done. `STATUS.md` and ntfy work | by hand |
| M2 | Configurable pipeline | `pipeline.toml` and AGENT.md drive the Stages. Skills resolve. Kinds map to Agents. Three config layers merge | by hand |
| M3 | Real Runs in containers | Spikes done. A real `claude -p` runs in a container with structured Verdicts. Every Run is recorded. Usage-limit pause works | by hand |
| M4 | Git and Gates | Worktrees, Task and Milestone branches, foreman-owned commits, merge and push. All code Gates | by hand |
| M5 | Owner control | CLI Approvals, Manual/Auto Mode, Breaker, Handoff, Escalation, Precedent, Scope change and Amendment, first real Agents | by hand |
| M6 | Telegram and summaries | foreman's own bot, all Owner commands from the phone, Task summary on ntfy | **foreman builds it** |
| M7 | Planning phase | Intake, Plan, Decompose, Plan review, Go package, Scaffold for new repos, `gh repo create` | foreman |
| M8 | Live verification | Verify images, Playwright and API verifiers, E2E handling, Evidence Gate, `.env` Consent | foreman |
| M9 | Research | Research after each Task and each Milestone, Origin, Proposals, duplicate check, Growth alert | foreman |
| M10 | Hardening and docs | Fast lane, time and token caps, Sweeper hardening, launch script, full README, retrospective queries | foreman |

**Why this order:** each Milestone up to M5 is a prerequisite for dogfooding, and nothing after M5 is. Telegram (M6) comes before the planning phase (M7) because approving from the phone makes every later Milestone faster to run. Verification (M8) comes after planning because foreman's own Tasks are CLI and library code, which the check command covers. Live verification matters most for web Target repos.

**What foreman cannot build for itself:** foreman runs from an **installed copy** (`npm run install-local` → `~/.foreman/app`, pinned to a tag on `main`), never from the checkout it is changing. Each Milestone Approval is followed by a reinstall. A broken Task branch therefore cannot break the orchestrator that is running it.

## Testing strategy

- **Unit:** `engine.route` (pure), config merging and validation, AGENT.md parsing, each Gate against fixture repos, `status.render` snapshots.
- **Store in tests:** `Store.memory()` opens a private in-memory SQLite database with every migration applied, so engine and command tests need no temp directory. Tests that go through the CLI use a temporary `FOREMAN_HOME` instead.
- **Integration:**
  - The fake `claude` is a script that reads `FAKE_CLAUDE_SCRIPT` (stage → files to write, verdict, usage, optional exit or usage-limit error). The fake Docker passes calls through to it on the host.
  - Temporary git repos use a bare "remote".
  - Fake ntfy and Telegram are local HTTP servers that record calls.
- **End to end (one per Milestone from M1):** a scripted Request runs through `foreman run --until-idle`, and the test asserts on the final database, the git graph, `STATUS.md` and the notifications sent.
- **Live smoke tests** (`npm run smoke`, run by hand and not part of `check`): one real `claude -p` in a container, one real ntfy, one real Telegram message.

## Risks and spikes

| Risk | Spike (M3) | Fallback |
|---|---|---|
| Subscription auth doesn't work inside a container | `claude setup-token`, then `CLAUDE_CODE_OAUTH_TOKEN` into a container, then a trivial `-p` call | Use an API key for container Runs (changes ADR 0001) |
| Egress allowlist on Docker Desktop | `internal` network plus a proxy container allowing only `api.anthropic.com`, npm and PyPI | Allow all egress, with no credentials in the container (weaker; recorded in ADR 0003) |
| Verdicts come back as prose | `--json-schema` with a Verdict schema, then confirm the `structured_output` field | Ask for a sentinel line and parse it |
| How the usage-limit error looks | Capture the real error from `-p` at the limit (or from the docs) | Treat any rate-limit exit as a pause for a fixed time |
| `--dangerously-skip-permissions` refused as root | Run as a non-root user in the image | — |
| Native `--agents` could replace custom prompt assembly | Compare `--agents <file>` with `--append-system-prompt` for skill loading | Keep the custom launch (ADR 0004 is unaffected) |
| Context usage isn't reported | Check the `usage` and `modelUsage` fields in the JSON result | Use `stream-json` and take the last turn's input tokens as the context peak |

## Out of v1

Mobile verification, parallel Tasks, the web dashboard, process-improvement Research, safety retrospectives (ADR 0007/0008). The seams are left open: `max_parallel`, the `status` module reading the database, a `process` Proposal tag.
