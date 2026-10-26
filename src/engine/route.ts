export const PIPELINE = ["workup", "implement", "review"] as const;
export type Stage = (typeof PIPELINE)[number];
export const VERDICTS = ["PASS", "FAIL"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The Round counters `route` reads from a Task. */
export interface RoundCounts {
  round_stage: number;
  round_total: number;
}

export type Transition =
  | ({ kind: "goto"; stage: Stage } & RoundCounts)
  | ({ kind: "done" } & RoundCounts);

/**
 * Pure routing over the hard-coded Pipeline, and the only place Rounds are counted.
 * A failed Stage costs a Round. A failed Workup goes back to Workup, because Implement needs the
 * failing acceptance test first; every other failed Stage goes back to Implement (ADR 0010).
 * `round_stage` counts the Rounds caused by the Stage that sent
 * the Task back, so it survives the implement pass on the way back and resets when any other
 * Stage passes.
 */
export function route(stage: Stage, verdict: Verdict, task: RoundCounts): Transition {
  if (verdict === "FAIL") {
    return {
      kind: "goto",
      stage: stage === "workup" ? "workup" : "implement",
      round_stage: task.round_stage + 1,
      round_total: task.round_total + 1,
    };
  }
  const round_stage = stage === "implement" ? task.round_stage : 0;
  const next = PIPELINE[PIPELINE.indexOf(stage) + 1];
  return next
    ? { kind: "goto", stage: next, round_stage, round_total: task.round_total }
    : { kind: "done", round_stage, round_total: task.round_total };
}
