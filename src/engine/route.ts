import { DONE, type Pipeline, type StageConfig } from "../config/pipeline.ts";
import type { Lane } from "../store/lane.ts";
import type { RoutedVerdict } from "./verdict.ts";

/** A Stage name from `pipeline.toml`. Which names exist is the Pipeline's business, not the engine's. */
export type Stage = string;

/** The Round counters `route` reads from a Task. */
export interface RoundCounts {
  round_stage: number;
  round_total: number;
}

/** What `route` needs of a Task: its Rounds and the lane that decides which Stages it runs. */
export interface Routable extends RoundCounts {
  lane: Lane;
}

export type Transition =
  | ({ kind: "goto"; stage: Stage } & RoundCounts)
  | ({ kind: "done" } & RoundCounts);

export function stageOf(pipeline: Pipeline, name: string): StageConfig {
  const stage = pipeline.stages.find((s) => s.name === name);
  if (!stage) {
    const known = pipeline.stages.map((s) => s.name).join(", ");
    throw new Error(`no stage "${name}" in the Pipeline (stages: ${known})`);
  }
  return stage;
}

/** The first Stage at or after `from` (following `on_pass`) that runs in `lane`, or `DONE`. */
export function enter(pipeline: Pipeline, from: string, lane: Lane): string {
  let at = from;
  while (at !== DONE) {
    const stage = stageOf(pipeline, at);
    if (!stage.lanes || stage.lanes.includes(lane)) return at;
    at = stage.on_pass;
  }
  return DONE;
}

/**
 * Pure routing over the configured Pipeline, and the only place Rounds are counted.
 * A pass goes to `on_pass` and a fail to `on_fail`; a failed Stage costs a Round (ADR 0010).
 * `round_stage` counts the Rounds caused by the Stage that sent the Task back, so it survives the
 * passes of a Stage the Task was sent back to (any Stage that is another Stage's `on_fail`) and
 * resets when any other Stage passes. A pass skips Stages outside the Task's lane; a fail goes to
 * `on_fail` itself, which the Pipeline's validation guarantees runs in every lane its Stage runs in.
 */
export function route(
  pipeline: Pipeline,
  stage: Stage,
  verdict: RoutedVerdict,
  task: Routable,
): Transition {
  const config = stageOf(pipeline, stage);
  if (verdict === "FAIL") {
    return {
      kind: "goto",
      stage: config.on_fail,
      round_stage: task.round_stage + 1,
      round_total: task.round_total + 1,
    };
  }
  const reworked = pipeline.stages.some((s) => s.name !== stage && s.on_fail === stage);
  const round_stage = reworked ? task.round_stage : 0;
  const next = enter(pipeline, config.on_pass, task.lane);
  return next === DONE
    ? { kind: "done", round_stage, round_total: task.round_total }
    : { kind: "goto", stage: next, round_stage, round_total: task.round_total };
}
