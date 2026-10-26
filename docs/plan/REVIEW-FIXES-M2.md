# Foreman v1: M2 review fixes

Tasks that address every finding from two reviews of M2:

- M2-T01 to M2-T05 (`dfe5370...9d779af`). M2-T06 landed after this review; where it touches a finding (its `ConfigError` and `strictAgents`), the task below covers it too.
- M2-T07 and M2-T08 (`8d6caf0...dfaf0d7`). These landed before the fixes from the first review, so M2-T12, M2-T14, M2-T15 and M2-T16 grew to cover them, and M2-T17 and M2-T18 are new.

The format, Kinds and Sizes follow [TASKS.md](./TASKS.md), so `foreman import` can read this file. IDs carry on from M2-T08. Do them all before starting M3.

**Where each finding goes:**

| Finding | Axis | Task |
| --- | --- | --- |
| A failed Stage whose `on_fail` target is outside the Task's lane routes forward, possibly to done | Standards | M2-T09 |
| A config that no longer fits the Task writes no event, and `tick` reports its Stage as `""` | Standards | M2-T09 |
| Lane skipping arrived in M2-T02, ahead of M10-T01 | Spec | M2-T09, M2-T16 |
| `lane` is a plain string in `route.ts` and `pipeline.ts`, which also re-declares `LANES` | Standards | M2-T10 |
| `as` casts in `pipeline.ts:162`, `prompt.ts:155` and `prompt.ts:165` | Standards | M2-T10 |
| `BlockingFinding.from` is a string that may hold `"owner"` | Standards | M2-T10 |
| "Verdict" is `PASS \| FAIL` in the engine but any string in AGENT.md, `verdictSchema` and `PriorReport` | Standards, Spec | M2-T11 |
| An Agent can declare Verdicts the engine can't route; nothing requires `PASS` | Spec | M2-T11 |
| Gates return a `Verdict` (CONTEXT: "No Verdict can override a Gate") | Standards | M2-T11 |
| The unknown-Agent check never runs outside tests (`strictAgents` is off everywhere) | Spec | M2-T12 |
| `assembleRunSpec` is never called; no code collects earlier reports or blocking findings | Spec | M2-T13 |
| `output.file` is parsed but never used | Spec | M2-T13 |
| Ten optional `RunSpec` fields that "the FakeRunner ignores" | Standards | M2-T13 |
| The Precedents pointer's wording differs from M5-T07 | Spec | M2-T13 |
| Template variables are checked in both `agent.ts` and `prompt.ts`; unknown Gates in both `pipeline.ts` and `executors.ts` | Standards | M2-T14 |
| `formatPath`, the config error class, the known-names message and BOM stripping are each written more than once | Standards | M2-T14 |
| `scriptNames` in `main.ts` walks the Pipeline that `config/pipeline.ts` owns | Standards | M2-T14 |
| `STUB_GATES` lives in `engine/`, not `src/gates/` (PLAN), and the CLI imports it from there | Standards | M2-T14 |
| `Values` in `prompt.ts` names nothing | Standards | M2-T14 |
| `engine.test.ts` and `runner.test.ts` depend on the shipped `defaults/pipeline.toml` | Standards | M2-T15 |
| `defaults/pipeline.toml` has no `[kinds.default]`, which M2-T07 falls back to | Spec | M2-T16 |
| `task_approval` runs in every Mode; ADR 0005 needs it in Manual Mode only, with Gates re-run after Owner commits | Spec | M2-T16 |
| **M2-T07 and M2-T08:** | | |
| `runEngine` finds the Task's Request itself, and the Task is picked twice (`run.ts` and `tick.ts`) (M1-T10) | Standards | M2-T17 |
| A Request that starts building after `run` starts gets the bare defaults, unvalidated | Spec | M2-T17 |
| `RunOptions.pipeline` and `pipelines` are two ways to say "this Task's Pipeline"; `main.ts` loads the defaults outside `loadConfig` | Standards | M2-T17 |
| A broken `defaults/pipeline.toml` is never tested against `run`; only the Target repo's config is | Spec | M2-T17 |
| `agentExecutor`'s `agentsFor` is optional and repeats its final fallback, so leaving it out ignores Kinds | Standards | M2-T17 |
| The `phase === "building"` filter is written in both `run.ts` and `tick.ts` | Standards | M2-T17 |
| `agentsFor` parses `agent_overrides` again on every tick instead of using the validated `taskAgents` | Standards, Spec | M2-T18 |
| `AgentsTask` names nothing; `DEFAULT_KIND` is exported but used in one file; a redundant null guard in `commands/config.ts:13` | Standards | M2-T18 |
| The e2e test's Go-override comment cites M5-T08; the `--agent` flag on Go is M7-T06 | Spec | M2-T18 |
| The e2e routes to Agents with no AGENT.md, which passes only while `strictAgents` is off | Spec | M2-T12 |
| `scriptNames` now walks several Pipelines; `commands/run.ts` imports `resolveConfig` from `commands/config.ts`, which pulls in `STUB_GATES` | Standards | M2-T14 |
| The e2e `cli()` builder repeats setup inline; a new `runner.test.ts` store is never closed (M1-T26) | Standards | M2-T15 |
| M2-T07 kept both `[kinds.default]` and Stage `agents` as fallbacks without the M2-T16 decision; Stage `agents` is a fourth level the spec didn't ask for | Standards, Spec | M2-T16 |
| An override "recorded at Go" is a test seam only; Go takes no flag until M7-T06 | Spec | M2-T16 |

**Not filed:**

- `TaskRow.kind` stays a `string`, because Kinds are open-ended by design.
- A broken config not stopping `run` for a Request that isn't building is extra, but harmless.

---

## M2 · Review fixes

### M2-T09 · A failure never routes forward

- **Kind:** core · **Size:** S · **Depends:** none
- **Do:**
  - Keep the lane skipping from M2-T02; M10-T01 then only adds the fast lane's threshold and its review limit (M2-T16 records this).
  - On `FAIL`, `route` goes to the `on_fail` Stage itself, without walking `on_pass` through `enter`.
  - Validation rejects a Stage whose `on_fail` target doesn't run in every lane the failing Stage runs in. The message names both Stages and the lane.
  - When the Task's Stage no longer fits the config (`tick.ts:76-80`), write a `stage.misconfigured` event with the message before returning the error, as `stage.crashed` does (M1-T14). The Task stays untouched for the Owner to fix the config.
  - `TickResult.stage` is a `Stage` or absent, never `""`.
- **Done when:**
  - A Pipeline where an all-lanes `review` fails to a `normal`-only `implement` is rejected, naming `review`, `implement` and `fast`.
  - `route` table tests show every `FAIL` landing on its Stage's `on_fail`.
  - A tick on a Task whose Stage was removed from the config writes `stage.misconfigured` and leaves the Task's row as it was.

### M2-T10 · Domain types for Lane and findings

- **Kind:** core · **Size:** S · **Depends:** none
- **Do:**
  - Use the store's `Lane` in `route.ts` (`Routable.lane`, `enter`) and `pipeline.ts` (`lanes`). Keep one list of lanes and build the zod enum from it; delete `pipeline.ts`'s own `LANES`.
  - Remove the casts at `pipeline.ts:162` (let the schema type `on_fail`), `prompt.ts:155` and `prompt.ts:165` (type the lookup instead of casting the key).
  - Type `BlockingFinding.from` as a union of Stage, Agent and `"owner"`, rather than a free string.
- **Done when:**
  - `tsc` rejects an unknown lane in a typed Pipeline.
  - `src/config`, `src/engine` and `src/runner` have no `as` casts except `as const` and the `NodeJS.ErrnoException` narrowing.

### M2-T11 · Verdict means one thing

- **Kind:** core · **Size:** M · **Depends:** M2-T10
- **Do:**
  - Make `Verdict` one closed union of the Verdicts CONTEXT allows (`PASS`, `FAIL`, `BLOCKED`, `SCOPE_CHANGE`). `output.verdicts`, `verdictSchema`, `PriorReport.verdict` and `RunResult.verdict` all use it.
  - The AGENT.md parser rejects an unknown Verdict and an Output contract without `PASS`, naming the file.
  - A Verdict the engine can't route yet (`BLOCKED`, `SCOPE_CHANGE`, until M5-T06 and M5-T08) is an error: the Task goes back to `queued` with a `verdict.unhandled` event, as `stage.crashed` does.
  - Gates return `{ passed, detail }` as PLAN sketches, not a `Verdict`. The gate executor turns that into the Stage's `PASS` or `FAIL`.
- **Done when:**
  - Parser tests cover an unknown Verdict and a missing `PASS`, each naming the file.
  - A FakeRunner script returning `BLOCKED` gives a `verdict.unhandled` event and a `queued` Task.
  - The `Gate` type mentions no `Verdict`.

### M2-T12 · Unknown Agents are caught in `run`

- **Kind:** agents · **Size:** S · **Depends:** none
- **Do:**
  - Add a stub `AGENT.md` under foreman's `agents/` for every Agent `defaults/pipeline.toml` names (in Stages and Kinds), with a placeholder role prompt and a valid Output contract. M5-T10 and M10-T07 replace them.
  - Remove the `strictAgents` option so `loadConfig` always checks Agent names, in Stages, Kinds and per-Task overrides (`checkTaskAgents`). Give `loadPipeline` the same check from foreman's `agents/`.
  - Give the e2e fixture Target repo stub `agents/` for the Agents its Kinds and override name (`implementer-core`, `implementer-cli`, `reviewer-cli`, `reviewer-override`), so the M2-T08 test passes with the check on.
- **Done when:**
  - A typo in an `agents` list makes `foreman run` exit non-zero, naming the Agent, the Stage and the Agents it knows.
  - An override naming an unknown Agent fails the same way, naming the Task.
  - The defaults and the e2e fixture validate with the check on.

### M2-T13 · Prompt assembly drives every Agent Run

- **Kind:** core · **Size:** M · **Depends:** M2-T11, M2-T12
- **Do:**
  - The `agent` executor loads the Run's Agent and builds its `RunSpec` with `assembleRunSpec`.
  - Collect the Task's earlier stage reports from its `runs` rows. Collect the blocking findings from the report of the Run that caused the last Round.
  - Decide how `output.file` and M1-T18's `runs/<run-id>-<stage>.md` fit together (for example, `output.file` names the file inside the Run's directory) and use it. Otherwise drop `output.file` from the frontmatter and from CONTEXT's Output contract.
  - Make the `RunSpec` fields required now that the engine fills them; the FakeRunner may still ignore them.
  - Word the Precedents pointer as M5-T07 does: read it before returning `BLOCKED`.
- **Done when:**
  - In the e2e test every Run's `RunSpec` carries the system prompt from its AGENT.md.
  - The rework Round's user prompt holds the failed review's report.
  - `RunSpec` has no optional prompt fields, and the golden files are updated.

### M2-T14 · Config tidy-up

- **Kind:** core · **Size:** M · **Depends:** M2-T11
- **Do:**
  - Check each rule once:
    - Template variables at parse time only; `renderTemplate` trusts a parsed Agent.
    - Unknown Gates at validation only; drop the check in `executors.ts:28`.
  - Share the repeated helpers:
    - One `formatPath`.
    - One base class for config-file errors, with `PipelineError`, `AgentError`, `SkillError` and `ConfigError` all built on it.
    - One known-names message helper.
    - One BOM strip, written as `\uFEFF`.
  - Move `scriptNames` into `config/pipeline.ts`, and use it from `checkMeaning`. Since M2-T08 it walks every building Request's Pipeline, so it takes a list of Pipelines.
  - Move `resolveConfig` from `commands/config.ts` into `src/config`, so no command imports another.
  - Move `STUB_GATES` to `src/gates/`, as PLAN's file layout says.
  - Rename `Values` in `prompt.ts` to say what it holds.
- **Done when:**
  - `main.ts` catches the one base error class.
  - `formatPath` is defined once.
  - No invisible characters remain in `src/`.
  - The existing tests pass, with only their imports changed.

### M2-T15 · Test hygiene for M2

- **Kind:** core · **Size:** S · **Depends:** M2-T09
- **Do:**
  - Give `engine.test.ts` and `runner.test.ts` a small fixture Pipeline from `test/helpers.ts`, instead of reading `defaults/pipeline.toml` (M1-T26). Keep the "defaults validate" test in `pipeline.test.ts` and the e2e test on the defaults. Where a test really needs the defaults, use the `defaultPipeline()` helper.
  - Move the e2e test's `cli()` builder (`e2e.test.ts:149-163`) into `test/helpers.ts`, and use it in both e2e tests.
  - Close every store a test opens, including the new one at `runner.test.ts:250`.
- **Done when:**
  - Renaming a Stage or reordering Gates in `defaults/pipeline.toml` breaks only `pipeline.test.ts` and the e2e test.
  - The two e2e tests share their setup.

### M2-T16 · The plan catches up with M2

- **Kind:** docs · **Size:** S · **Depends:** M2-T09, M2-T11
- **Do:**
  - Decide what a Task with no matching Kind gets. M2-T07 kept both fallbacks, `[kinds.default]` and then Stage `agents`, and the defaults have no `[kinds.default]`, so only Stage `agents` ever fires. Choose one:
    - add `[kinds.default]` to the defaults and drop Stage `agents`; or
    - keep Stage `agents` as the fallback and drop the `default` Kind from `agentsFor`.

    Record the decision in a new ADR, and make `agentsFor` and `defaults/pipeline.toml` match it. Leave TASKS.md as it is.
  - Note in PLAN that an override "recorded at Go" is written straight to `agent_overrides` until M7-T06 adds `foreman go --agent`.
  - Note in PLAN that lane skipping landed with M2-T02, so M10-T01 only adds the fast lane's threshold and its one-review-Round limit.
  - Note in ADR 0005 that `task_approval` runs in every Mode for now, and that M5-T02 needs the schema to make an owner Stage depend on Mode and to re-run the Gates after Owner commits.
  - Add the Verdict set (M2-T11) to CONTEXT, and the Gate result shape to PLAN.
- **Done when:**
  - An ADR records the default-Kind decision.
  - `agentsFor` and `defaults/pipeline.toml` match the decision.
  - PLAN and ADR 0005 carry the notes.

### M2-T17 · The engine picks the Task and its Pipeline

- **Kind:** core · **Size:** M · **Depends:** M2-T09
- **Do:**
  - Move the Request lookup out of `runEngine`, as M1-T10 asks.
    - `tick` picks the Task once and asks a `pipelineFor(task)` for its Pipeline.
    - `runEngine` no longer calls `nextActionable` or `requestIdOf`.
  - Resolve each Request's config through `loadConfig` the first time one of its Tasks is picked, and cache it for the rest of the run. A Request that starts building mid-run then gets its own validated config, not the bare defaults.
    - `foreman run` still resolves every building Request up front, so a broken config stops it before any Agent runs.
    - A broken config found mid-run is a tick error, with a `stage.misconfigured` event (M2-T09).
  - Drop `RunOptions.pipeline` and the separate `loadPipeline(DEFAULT_PIPELINE_PATH)` in `main.ts`. The defaults are always the first layer of `loadConfig`.
  - Make `agentsFor` a required option of `agentExecutor`, and drop its `?? stage.agents ?? []` fallback.
  - Add `Store.buildingRequests()` and use it in `run.ts` and `tick.ts`.
- **Done when:**
  - A test that sets a second Request to building between two ticks runs its Task with its Target repo's Kinds.
  - A test with a broken `defaults/pipeline.toml` (through `loadConfig`'s `foremanDir`) makes `foreman run` refuse to start, naming the error.
  - `runEngine` contains no Task or Request lookup.

### M2-T18 · One source for per-Task overrides

- **Kind:** core · **Size:** S · **Depends:** M2-T17
- **Do:**
  - Parse and check `agent_overrides` once, when the Request's config is resolved, as M1-T24 does for other stored rows. `agentsFor` reads the validated `taskAgents` from `ResolvedConfig` and no longer parses the Task row.
  - Drop the null guard in `commands/config.ts:13`, which `parseTaskAgents` already covers.
  - Rename `AgentsTask` to say what it holds, and stop exporting `DEFAULT_KIND` unless another module needs it.
  - Point the e2e test's Go-override comment at M7-T06, not M5-T08.
- **Done when:**
  - A malformed `agent_overrides` fails when the config is resolved, naming the Task, before any Agent runs.
  - `agentsFor` takes no raw Task row JSON.
