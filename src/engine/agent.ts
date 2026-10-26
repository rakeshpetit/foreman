import { join } from "node:path";
import type { Runner } from "../runner/runner.ts";
import type { StageExecutor } from "./tick.ts";

export interface AgentExecutorOptions {
  runner: Runner;
  workdir: string;
  reportsDir: string;
}

/** The `agent` stage executor: one Agent Run per Stage, via the Runner. */
export function agentExecutor(opts: AgentExecutorOptions): StageExecutor {
  return async (task, stage) => {
    const result = await opts.runner.run({
      task: task.id,
      stage,
      workdir: opts.workdir,
      reportPath: join(opts.reportsDir, task.id, `${stage}-${task.round_total}.md`),
    });
    return result.verdict;
  };
}
