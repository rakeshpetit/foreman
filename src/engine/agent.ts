import { join } from "node:path";
import type { Runner } from "../runner/runner.ts";
import type { Store } from "../store/store.ts";
import type { StageExecutor } from "./tick.ts";

export interface AgentExecutorOptions {
  store: Store;
  runner: Runner;
}

/** The `agent` stage executor: one Agent Run per Stage, via the Runner, recorded as a Run row. */
export function agentExecutor(opts: AgentExecutorOptions): StageExecutor {
  return async (task, stage) => {
    const milestone = opts.store.getMilestone(task.milestone_id);
    const request = milestone && opts.store.getRequest(milestone.request_id);
    if (!request) throw new Error(`no Request for task ${task.id}`);
    const runId = opts.store.createRun({ task_id: task.id, request_id: request.id, stage });
    const started = Date.now();
    try {
      const result = await opts.runner.run({
        task: task.id,
        stage,
        workdir: request.target_repo,
        reportPath: join(
          request.target_repo,
          ".foreman",
          request.id,
          "runs",
          `${runId}-${stage}.md`,
        ),
      });
      opts.store.finishRun(runId, {
        verdict: result.verdict,
        tokens_in: result.usage.input_tokens,
        tokens_out: result.usage.output_tokens,
        duration_ms: Date.now() - started,
        exit_code: 0,
        report_path: result.reportPath,
      });
      return result.verdict;
    } catch (e) {
      opts.store.finishRun(runId, {
        duration_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
}
