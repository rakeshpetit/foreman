import { join } from "node:path";
import type { StageConfig } from "../config/pipeline.ts";
import type { Runner } from "../runner/runner.ts";
import type { Store, TaskRow } from "../store/store.ts";
import type { Verdict } from "./route.ts";
import type { StageExecutor } from "./tick.ts";

export interface AgentExecutorOptions {
  store: Store;
  runner: Runner;
  /** Which Agents run a Stage for a Task (`agentsFor`). Defaults to the Stage's own `agents`. */
  agentsFor?: (task: TaskRow, stage: StageConfig) => string[];
}

/**
 * The `agent` stage executor: runs the Stage's Agents in turn, one Run each via the Runner, and
 * combines their Verdicts by `require`. `all` runs every Agent, so a Round carries every
 * reviewer's findings; `any` stops at the first PASS.
 */
export function agentExecutor(opts: AgentExecutorOptions): StageExecutor {
  return async (task, stage) => {
    let passed = 0;
    const agents = opts.agentsFor?.(task, stage) ?? stage.agents ?? [];
    for (const agent of agents) {
      const verdict = await runAgent(opts, task, stage.name, agent);
      if (verdict === "PASS") {
        passed++;
        if (stage.require === "any") break;
      }
    }
    return (stage.require === "any" ? passed > 0 : passed === agents.length) ? "PASS" : "FAIL";
  };
}

async function runAgent(
  opts: AgentExecutorOptions,
  task: TaskRow,
  stage: string,
  agent: string,
): Promise<Verdict> {
  const milestone = opts.store.getMilestone(task.milestone_id);
  const request = milestone && opts.store.getRequest(milestone.request_id);
  if (!request) throw new Error(`no Request for task ${task.id}`);
  const runId = opts.store.createRun({ task_id: task.id, request_id: request.id, stage, agent });
  const started = Date.now();
  try {
    const result = await opts.runner.run({
      task: task.id,
      stage,
      agent,
      workdir: request.target_repo,
      reportPath: join(request.target_repo, ".foreman", request.id, "runs", `${runId}-${stage}.md`),
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
}
