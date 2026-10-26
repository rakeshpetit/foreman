# Foreman v1: M3 review fixes

Tasks that address every finding from one two-axis review of M3-T01 to M3-T07 (`a85eefe...356ee51`).

The format, Kinds and Sizes follow [TASKS.md](./TASKS.md), so `foreman import` can read this file. IDs carry on from M3-T07. Do them all before starting M4.

**Where each finding goes:**

| Finding | Axis | Task |
| --- | --- | --- |
| `foreman run` never builds a `ContainerRunner`; without `--fake` it says "the real Runner arrives in M3" (M1-T09) | Standards, Spec | M3-T08 |
| PLAN's M3 exit ("A real `claude -p` runs in a container") holds only through `npm run smoke` | Spec | M3-T08 |
| No M3 end-to-end test through `foreman run --until-idle` (PLAN, Testing strategy: one per Milestone from M1) | Spec | M3-T08 |
| `context_peak` is null on every real Run: the `usage.iterations` approximation needs data the real result lacks, so the "complete row" passes only on the fixture | Spec | M3-T09 |
| ADR 0001 says the reset time comes from `rate_limit_event` in `stream-json`; ADR 0003 leaves `stream-json` to M3-T05 and M3-T06; neither uses it | Standards, Spec | M3-T09 |
| The usage limit is found by matching error text, and its reset by a regex for `"resetsAt"` over the raw output, against the spike's advice | Spec | M3-T09 |
| Reading `resetsAt` as milliseconds when it is too big to be seconds was not asked for | Spec | M3-T09 |
| The model recorded is the first key of `modelUsage`, which may be a helper model | Spec | M3-T09 |
| On a timeout, a failed `docker kill` is ignored, and nothing removes a container still running with the token | Standards | M3-T10 |
| A `CliDocker` ENOENT or `maxBuffer` overflow rejects with a plain `Error`, which is neither a `RunFailure` nor retried | Standards | M3-T10 |
| `ensureNetwork` checks only that `foreman-agents` exists; one made without `--internal` silently allows direct egress (ADR 0003) | Spec | M3-T10 |
| The fake `docker` is in-process; there is no shim calling a fake `claude`, and `CliDocker`'s spawn and kill path is untested | Spec | M3-T10, M3-T13 |
| An Owner pause set while a Run was in flight is kept, but the ntfy still says "paused until X" | Spec | M3-T11 |
| `tick.ts:115-116` re-derives "paused by the Owner" instead of asking the store (M1-T21) | Standards | M3-T11 |
| A failed Run never records `exit_code` ("every `runs` column") | Spec | M3-T11 |
| `RunFailure` takes five positional arguments, with an `undefined` filler at `container.ts:252` | Standards | M3-T11 |
| `home` means the token directory in `ContainerRunnerOptions` and the raw-output directory in `AgentExecutorOptions` | Standards | M3-T12 |
| `tokenCount` also types `total_cost_usd`; `spent` holds model and effort; the same output is `raw` on `RunResult` and `stdout` on `RunFailure` | Standards | M3-T12 |
| `#runContainer` and `#dockerArgs` both take `(name, tokenFile, skillsDir, spec)`; `runAgent` and `attemptRun` both take `(opts, task, stage, agentName, history)` | Standards | M3-T12 |
| The put-back-and-log-an-event transaction is written three times in `tick.ts`; two hand-rolled `sleep`s | Standards | M3-T12 |
| `Usage` carries Claude's field names through the Runner seam, and `usageColumns` translates them again | Standards | M3-T12 |
| `engine/agent.ts` holds the retry policy, the usage-limit translation, the report check, the column mapping and the raw-file I/O | Standards | M3-T12 |
| `keepRaw` calls `console.error`; elsewhere `log` is injected (`notifier.ts:57`) | Standards | M3-T12 |
| `RunSpec.maxTokens` is filled but ignored (M2-T13) | Standards | M3-T12 |
| `readOutput`'s doc says it returns "why it is not that"; it returns `undefined` | Standards | M3-T12 |
| PLAN's File layout lacks `src/docker/` and `src/smoke/`, says `images/{base,web}` and `test/fakes/{claude,…}` | Standards | M3-T13 |
| PLAN's Testing strategy describes a fake `claude` read from `FAKE_CLAUDE_SCRIPT` that the fake Docker passes calls to | Standards, Spec | M3-T13 |

**Not filed:**

- **The report copy stays dropped.** M3-T05's Decision is sound: the Agent writes its report straight to `<target repo>/.foreman/R-n/runs/`, which is where the copy would have gone, and M4-T02 commits it.
- **Small extras stay:** the `parked` lines in STATUS, the `run.retried` event, and the Escalation class with its high-priority ntfy (an M3-T05 Decision covers it). Each is small and useful until M5-T06.
- **`curl` stays in the base image.** The M3-T03 allow and deny checks run it inside the container.
- **Prompts stay in argv.** They name files by path and inline only blocking findings, so they stay small. On a single-user Mac, the prompt showing in `ps` is no risk.
- **No sweep for orphaned containers.** M10-T04 removes containers labelled `foreman.run`; M3-T10 covers only a Run's own container.
- **`TickResult.until` stays an ISO string.** It is what `queue_state.paused_until` stores and what the ntfy prints.
- **The `TickResult` cases in `main.ts` and `run.ts` stay separate.** One prints to the terminal and the other sends ntfys; a shared map would have to cover both jobs.
- **`buildImages` with `onBuilt` in both `main.ts` and `smoke.ts`.** Two one-line call sites.

---

## M3 · Review fixes

### M3-T08 · `foreman run` runs real Agents

- **Kind:** cli · **Size:** M · **Depends:** none
- **Do:**
  - Without `--fake`, `run` builds a `ContainerRunner` from `ctx.docker ?? new CliDocker()` and `$FOREMAN_HOME`. Drop the "No Runner yet" message.
  - Before the first tick, `run` refuses to start, naming the fix, when:
    - `$FOREMAN_HOME/claude.env` is missing;
    - `docker` is not installed or its daemon is not running.

    A building Request then never has its first Task marked `active` for a Run that cannot start.
  - Add the M3 end-to-end test (PLAN, Testing strategy): a scripted Request runs through `foreman run --until-idle` on the `ContainerRunner` and the fake `docker`. Assert on the `runs` rows, the raw files under `$FOREMAN_HOME/runs/`, `STATUS.md` and the ntfys. The script includes one usage limit, followed by `foreman resume` and a second `run` that finishes the Task.
- **Done when:**
  - `foreman run` with no `--fake` and a fake `docker` takes a Task through an `agent` Stage.
  - `foreman run` with no `claude.env` exits non-zero, naming the file and `claude setup-token`, and the store is unchanged.
  - The M3 e2e test passes and covers the usage-limit pause and the resume.

### M3-T09 · Read Claude's stream

- **Kind:** integration · **Size:** M · **Depends:** none
- **Do:**
  - Run `claude` with `--output-format stream-json --verbose`, as the spike advised. Read the output line by line. The final `result` line is today's result object, so `structured_output`, the totals and the cost come from it unchanged.
  - The context peak is the largest `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` over the `assistant` messages' `message.usage`. It is exact, so drop "approximation" from `Usage.context_peak` and drop `usage.iterations` from the schema.
  - A usage limit is a `rate_limit_event` whose `rate_limit_info.status` is not `allowed`, and its reset is that event's `resetsAt` (epoch seconds). Keep the `is_error` text match only as the fallback for a stream with no such event. Drop the regex over the raw output and the milliseconds guess.
  - The model recorded is the `modelUsage` entry with the largest `costUSD`, not the first key.
  - Keep the whole stream as the raw file. Measure the stream's size on the smoke Run and on a multi-turn Run. If a long implement Run could come near `CliDocker`'s 64 MB `maxBuffer`, record the limit in ADR 0003.
  - `npm run smoke` requires `context_peak` like every other column.
  - Docs:
    - In ADR 0001 and ADR 0003, say what was built.
    - In `docs/spikes/claude-in-container.md`, replace the "As built (M3-T06)" note.
    - Add one line to the M3-T05 and M3-T06 Decisions in TASKS.md saying M3-T09 replaced the `iterations` approximation and the text match.
- **Done when:**
  - A fixture stream of three model calls gives the largest of their three contexts as `context_peak`.
  - A fixture stream with a rejected `rate_limit_event` gives a `usage-limit` failure carrying that event's `resetsAt`.
  - A fixture whose `modelUsage` lists a cheap helper model first records the main model.
  - `npm run smoke` passes with `context_peak` set.

### M3-T10 · Containers never outlive their Run

- **Kind:** integration · **Size:** M · **Depends:** none
- **Do:**
  - **Timeout:** after `docker kill`, if `docker run` has not returned within the grace period, run `docker rm -f <name>`. If that fails too, the `RunFailure` message names the container and says it may still be running.
  - **Docker errors:** when `docker.run` rejects during a Run (`maxBuffer` overflow, a signal), `ContainerRunner` removes the container with `docker rm -f` and throws a `RunFailure` of kind `failed`, so the Run is retried and then Escalated. A missing `docker` binary is caught up front by M3-T08.
  - **Egress network:** `ensureNetwork` reads `{{.Internal}}` from `docker network inspect`. When `foreman-agents` exists but is not internal, it throws a `DockerError` naming the network and the `docker network rm` that fixes it, and no Run starts.
  - **Shim:** add a `docker` shim, an executable script under `test/fakes/docker/` put first on `PATH`. Its `run` prints the output named by `FAKE_CLAUDE_OUTPUT`, or sleeps until its `kill` arrives. Test `CliDocker` and `ContainerRunner` through it, as M3-T04 asked. Keep `FakeDocker` for the unit tests.
- **Done when:**
  - Through the shim:
    - A non-zero exit resolves with its code.
    - A missing `docker` rejects.
    - A timed-out Run is killed and leaves no process behind.
  - Through `FakeDocker`:
    - A `kill` that does nothing leads to `rm -f`.
    - A `foreman-agents` network that is not internal stops the Run with the `DockerError`.

### M3-T11 · Usage-limit pause and failed Runs tell the truth

- **Kind:** core · **Size:** S · **Depends:** none
- **Do:**
  - Add a `Store` method for "paused by the Owner" (paused, with no `paused_until`), next to `isPaused`, and use it in `tick`.
  - When a limit hits while the Owner's pause is on, `tick` still writes `queue.paused`, but its `usage-limit` result says the Owner's pause was kept. The ntfy then says the queue stays paused until `foreman resume`, not "paused until X". The terminal line in `main.ts` says the same.
  - Give `RunFailure` an options object, `new RunFailure(kind, message, { stdout, usage, exitCode, resetsAt })`, in place of its positional arguments. `ContainerRunner` sets `exitCode` from `docker run`'s exit code, and `attemptRun` records it in the failed Run's `exit_code`.
- **Done when:**
  - A test that pauses the queue during a Run that then hits the limit sends a ntfy naming `foreman resume` and no reset time, and `queue_state` keeps `paused_until` null.
  - A Run whose container exits 3 leaves `exit_code` 3 on its `runs` row.
  - `src/` has no `RunFailure` call with an `undefined` argument.

### M3-T12 · M3 tidy-up

- **Kind:** core · **Size:** M · **Depends:** M3-T09, M3-T11
- **Do:**
  - **Names:**
    - Split `home` into what each option holds. `ContainerRunnerOptions.tokenFile` is the path to `claude.env`. `AgentExecutorOptions.runsDir` is where raw output is kept. Drop `runsHome` from `smoke.ts`.
    - Rename `tokenCount`, since it also types the cost.
    - Rename `spent` to say it is the row recorded so far.
    - Use one name for what a Run printed on both `RunResult` and `RunFailure`.
  - **Usage:** make `Usage` the `runs` columns it fills (`tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `context_peak`, `cost_usd`). `ContainerRunner` maps Claude's names once, `usageColumns` goes, and the FakeRunner's script `usage` uses the same names.
  - **Shared types:**
    - Bundle what one container launch needs (name, token file, Skills folder, spec) into one value that `#runContainer` and `#dockerArgs` share.
    - Bundle `(opts, task, stage, agentName, history)` into one value for `runAgent` and `attemptRun`.
  - **`tick.ts`:** one helper for "put the Task back with this status and write this event", used by the usage-limit, Escalation, `stage.crashed` and `verdict.unhandled` paths.
  - **Sleep:** use `setTimeout` from `node:timers/promises` in `container.ts` and `images.ts`.
  - **`engine/agent.ts`:**
    - Move Run recording (opening and finishing the `runs` row, keeping the raw file) into its own module, so `agent.ts` keeps the Stage's Agents, the retry and the Escalation.
    - Inject `log` for the raw-file warning, as `notifier.ts` does.
  - **`RunSpec.maxTokens`:** drop it. M10-T02 checks token caps against the recorded usage, reading `max_tokens` from the Agent.
  - **`readOutput`:** fix its doc to say it returns `undefined` for output that is not a result.
- **Done when:**
  - The existing tests pass, with only names, imports and fixture field names changed.
  - No options type has a field called `home`.
  - `src/` has one way to sleep.
  - `RunSpec` has no field a Runner ignores.

### M3-T13 · The plan catches up with M3

- **Kind:** docs · **Size:** S · **Depends:** M3-T10
- **Do:**
  - **PLAN, File layout:**
    - Add `src/docker/` and `src/smoke/`.
    - Make `images/` read `{base,egress-proxy}`, with `web` arriving in M8.
    - Make `test/fakes/` list `docker` beside `ntfy` and `telegram`, with no `claude`.
  - **PLAN, Testing strategy:** describe what M3 built.
    - `FakeDocker` plays `claude` in process, for unit and e2e tests.
    - The `docker` shim on `PATH` prints a fixture from `FAKE_CLAUDE_OUTPUT`, for `CliDocker`.
    - Drop `FAKE_CLAUDE_SCRIPT`.
  - **ADR 0003:** mark M3 done in its status line: images, network, `ContainerRunner`, recording and the usage-limit pause.
- **Done when:**
  - Every folder under `src/`, `images/` and `test/fakes/` appears in PLAN's File layout.
  - PLAN's Testing strategy names only fakes that exist.
