import type { TaskRow } from "../store/store.ts";
import type { Verdict } from "./route.ts";
import type { StageExecutor } from "./tick.ts";

/** A pass/fail condition foreman checks itself, with no Agent involved. */
export type Gate = (task: TaskRow) => Promise<Verdict> | Verdict;

/** Gate name → Gate. */
export type GateRegistry = Readonly<Record<string, Gate>>;

const passes: Gate = () => "PASS";

/** Every Gate the default Pipeline names, as stubs that pass. The real Gates arrive in M4. */
export const STUB_GATES: GateRegistry = {
  red_before: passes,
  green_after: passes,
  check_passes: passes,
  test_integrity: passes,
  diff_size: passes,
  evidence: passes,
};

/** The `gate` stage executor: runs the named Gates in turn and stops at the first that fails. */
export function gateExecutor(registry: GateRegistry): StageExecutor {
  return async (task, stage) => {
    for (const name of stage.gates ?? []) {
      const gate = registry[name];
      if (!gate) {
        throw new Error(`stage "${stage.name}": no gate "${name}" (gates: ${gateNames(registry)})`);
      }
      if ((await gate(task)) === "FAIL") return "FAIL";
    }
    return "PASS";
  };
}

export function gateNames(registry: GateRegistry): string {
  return Object.keys(registry).sort().join(", ");
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
