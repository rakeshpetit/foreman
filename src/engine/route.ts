export const PIPELINE = ["workup", "implement", "review"] as const;
export type Stage = (typeof PIPELINE)[number];
export type Outcome = "pass" | "fail";

export type Transition = { kind: "goto"; stage: Stage; round: boolean } | { kind: "done" };

/** Pure routing over the hard-coded Pipeline. A failed Stage costs a Round. */
export function route(stage: Stage, outcome: Outcome): Transition {
  if (outcome === "fail") {
    return { kind: "goto", stage: stage === "workup" ? "workup" : "implement", round: true };
  }
  const next = PIPELINE[PIPELINE.indexOf(stage) + 1];
  return next ? { kind: "goto", stage: next, round: false } : { kind: "done" };
}
