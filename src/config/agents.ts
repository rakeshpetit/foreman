import { z } from "zod";
import type { TaskRow } from "../store/store.ts";
import { ConfigError, type TaskAgents } from "./layers.ts";
import type { Pipeline, StageConfig } from "./pipeline.ts";

/** The Kind a Task gets when its own Kind has no entry for a Stage. */
export const DEFAULT_KIND = "default";

const taskAgentsSchema = z.record(z.string(), z.array(z.string().min(1)).min(1));

/** What `agentsFor` reads of a Task: its Kind and the Agent overrides recorded at Go. */
export type AgentsTask = Pick<TaskRow, "id" | "kind" | "agent_overrides">;

/** A Task's `agent_overrides` column as Stage → Agents. Empty when none were recorded. */
export function parseTaskAgents(task: Pick<TaskRow, "id" | "agent_overrides">): TaskAgents {
  if (task.agent_overrides === null) return {};
  try {
    return taskAgentsSchema.parse(JSON.parse(task.agent_overrides));
  } catch {
    throw new ConfigError([
      `${task.id}: agent_overrides is not a {"<stage>": ["<agent>", ...]} object`,
    ]);
  }
}

/**
 * The Agents that run `stage` for `task`, most specific first: the Task's own override (chosen at
 * Go), its Kind's entry for the Stage, the `default` Kind's entry, then the Stage's own `agents`.
 * Empty for a Stage that has none to choose, such as a gate or owner Stage.
 */
export function agentsFor(pipeline: Pipeline, task: AgentsTask, stage: StageConfig): string[] {
  return (
    parseTaskAgents(task)[stage.name] ??
    pipeline.kinds[task.kind]?.[stage.name] ??
    pipeline.kinds[DEFAULT_KIND]?.[stage.name] ??
    stage.agents ??
    []
  );
}
