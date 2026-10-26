import type { GateRegistry } from "../gates/gate.ts";
import type { StageExecutor } from "./tick.ts";

/**
 * The `gate` stage executor: runs the named Gates in turn and stops at the first that fails.
 * The Stage passes if every Gate passed, and fails otherwise.
 */
export function gateExecutor(registry: GateRegistry): StageExecutor {
  return async (task, stage) => {
    for (const name of stage.gates ?? []) {
      // Validation has checked every name against the registry, so a missing Gate never passes.
      if (!(await registry[name]?.(task))?.passed) return "FAIL";
    }
    return "PASS";
  };
}

/** The `owner` stage executor. A stub that approves at once, until Approvals arrive in M5-T01. */
export const ownerExecutor: StageExecutor = async () => "PASS";

export interface Executors {
  agent: StageExecutor;
  gate: StageExecutor;
  owner: StageExecutor;
}

/** Dispatches each Stage to the executor for its type. */
export function stageExecutor(executors: Executors): StageExecutor {
  return (task, stage) => executors[stage.type](task, stage);
}
