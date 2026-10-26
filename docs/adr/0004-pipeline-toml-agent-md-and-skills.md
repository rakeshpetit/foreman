---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Stages and Agents are hand-edited files: pipeline.toml, AGENT.md, and standard SKILL.md

The Owner must be able to configure every Stage in detail, and to keep several kinds of implementer, reviewer and verifier Agents, without rebuilding foreman. So the Pipeline and the Agents are plain files, not code. Skills stay standard Claude Code SKILL.md folders, so one Skill serves both foreman and the Owner's interactive sessions.

## Decisions

- **`pipeline.toml`** declares:
  - the ordered Stages, each of type `agent`, `gate` or `owner`;
  - the Agent(s) for each Stage, with `require = "all" | "any"` when there are several;
  - `on_pass` and `on_fail` routing;
  - the Breaker limits;
  - the Fast lane;
  - the **Kind → Agents** mapping;
  - notification settings.
- **`agents/<name>/AGENT.md`** defines one Agent. Its frontmatter sets `model`, `effort`, the container `image`, its tools, `skills.preload`, `skills.available` and the Output contract (the file it writes and its allowed Verdicts). Its body is the role prompt.
- **AGENT.md is "who and what must be produced"; SKILL.md is "how".** One Agent uses many Skills, and one Skill is used by many Agents. Gates and Output contracts never live in a Skill.
- **Skill loading:**
  - At launch, the listed skill folders are copied unchanged into the container's `.claude/skills/`, from foreman's `skills/`, the Target repo's `.foreman/skills/` or `~/.claude/skills/`.
  - **Preloaded** skills are also inlined into the prompt, because a model may choose not to invoke a skill, and gate-critical techniques such as TDD must not be optional.
- **Three config layers,** each overriding the one before: foreman's defaults → the Target repo's `.foreman/` (its check, run, healthcheck and e2e commands, extra Agents, Kind mappings) → per-Request settings chosen at Go (Mode, and per-Task Agent overrides).
- **Agents are chosen by Kind,** which is tagged at Decompose. The Owner can override the choice at Go.
- **Default models:** Opus for Plan, Plan review and code review. Sonnet for Implement, Verify and per-Task Research. An implementer moves up to Opus after a failed Round.

## Considered options

- **Stages defined in TypeScript:** rejected, because changing a Stage would mean a code change and a rebuild.
- **A router Agent that picks Agents for each Task:** rejected, because selection by Kind is predictable and adding an Agent is just a config edit.
- **Generating Claude Code's native `.claude/agents/*.md` subagents instead of a custom launch:** checked in the M3-T01 spike ([claude-in-container](../spikes/claude-in-container.md)). `--agents <file>` plus `--agent` carries the role prompt, but its `skills` field does not preload Skill content, so the custom launch stays. The AGENT.md format the Owner edits is unchanged.

## Consequences

- Prompt bloat (23% of the article's skill text was removable) shows up as a file diff. Each Task summary records context usage so the bloat can be seen.
