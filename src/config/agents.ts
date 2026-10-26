import type { TaskRow } from "../store/store.ts";
import type { ResolvedConfig } from "./layers.ts";
import { DEFAULT_KIND, type StageConfig } from "./pipeline.ts";

/** What `agentsFor` needs to know of a Task: which one it is, and its Kind. */
export type KindedTask = Pick<TaskRow, "id" | "kind">;

/**
 * The Agents that run `stage` for `task`, most specific first: the Task's own override (chosen at
 * Go, already checked in `config.taskAgents`), its Kind's entry for the Stage, then the `default`
 * Kind's entry (ADR 0011). Empty for a Stage with no Agents to choose, such as a gate or owner Stage.
 */
export function agentsFor(
  config: Pick<ResolvedConfig, "pipeline" | "taskAgents">,
  task: KindedTask,
  stage: StageConfig,
): string[] {
  const { kinds } = config.pipeline;
  return (
    config.taskAgents[task.id]?.[stage.name] ??
    kinds[task.kind]?.[stage.name] ??
    kinds[DEFAULT_KIND]?.[stage.name] ??
    []
  );
}
