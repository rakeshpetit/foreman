---
status: accepted (decided 2026-10-26 in the M2 review fixes; built in M2-T16)
---

# Agents come from Kinds, and a `default` Kind covers the rest

ADR 0004 says Agents are chosen by Kind and that `pipeline.toml` declares the Agents for each Stage. M2-T01 gave each Stage an `agents` list and `kinds` a Kind → Stage → Agents mapping. M2-T07 then added a `default` Kind as the fallback. Both survived into `agentsFor`, so a Task's Agents came from four places: its override at Go, its Kind, the `default` Kind and the Stage's own `agents`. The defaults had no `[kinds.default]`, so only the Stage's `agents` ever fired and the `default` Kind did nothing. A review found the fourth level was never asked for.

## Decisions

- **A Stage has no `agents` of its own.** The `agents` key is removed from the Stage schema, and `pipeline.toml` rejects it with a message that points at `[kinds.default]`.
- **`[kinds.default]` names the Agents of every agent Stage.** Config validation requires an entry for each Stage of type `agent`, so a Task can never reach a Stage with no Agents. `defaults/pipeline.toml` carries these entries.
- **`agentsFor(task, stage)` has three levels,** most specific first: the Task's override (chosen at Go), its Kind's entry for the Stage, then the `default` Kind's entry. A gate or owner Stage has none, so the result is empty.
- `require` stays on the Stage, because how the Verdicts of several Agents combine belongs to the Stage and not to the Kind.
- A Target repo adds a Kind, or changes one Stage's Agents for every Task, with `[kinds.*]` in `.foreman/config.toml`. Layers merge Kinds by Stage, so it names only what it changes.
- TASKS.md (M2-T01, M2-T07) keeps its original wording. This ADR supersedes M2-T01's `agents` Stage field, and M2-T07's order stays as written.

## Considered options

- **Keep Stage `agents` as the fallback and drop the `default` Kind:** rejected. M2-T07 names the `default` Kind, "Agents are chosen by Kind" (ADR 0004) points the same way, and a Stage field would stay as a second place to say what a Kind says.
- **Keep both fallbacks:** rejected. Four levels is one more than the spec asked for, and which of the two fallbacks applied would depend on which a config happened to set.

## Consequences

- Reading the Agents of a Stage means reading `kinds`, not the Stage. `foreman config show` lists them as `kinds.default.<stage>`.
- A Target repo that replaces `stages` must also fix `[kinds.default]`, since an entry for a Stage that no longer exists is an error.
- The Agent library (M5-T10, M10-T07) and the Go package (M7-T06) read Kind → Stage → Agents only.
