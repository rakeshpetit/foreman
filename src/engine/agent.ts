import { join } from "node:path";
import { agentsFor } from "../config/agents.ts";
import type { ResolvedConfig } from "../config/layers.ts";
import type { StageConfig } from "../config/pipeline.ts";
import { resolveSkills } from "../config/skill.ts";
import { assembleRunSpec, type BlockingFinding, type PriorReport } from "../runner/prompt.ts";
import type { Runner } from "../runner/runner.ts";
import type { Store, TaskRow } from "../store/store.ts";
import { blockingFindings, priorReports } from "./context.ts";
import type { StageExecutor } from "./tick.ts";
import { isRouted, type Verdict } from "./verdict.ts";

export interface AgentExecutorOptions {
  store: Store;
  runner: Runner;
  /** The Task's Request's config: the Pipeline that picks each Stage's Agents, and the Agents and Skills to load. */
  config: Pick<ResolvedConfig, "pipeline" | "taskAgents" | "agents" | "skillRoots">;
}

/** What earlier Runs of the Task left for the Stage's Agents to read. */
interface History {
  reports: PriorReport[];
  findings: BlockingFinding[];
}

/**
 * The `agent` stage executor: runs the Stage's Agents in turn, one Run each via the Runner, and
 * combines their Verdicts by `require`. `all` runs every Agent, so a Round carries every
 * reviewer's findings; `any` stops at the first PASS. A Verdict the engine cannot route (`BLOCKED`,
 * `SCOPE_CHANGE`) ends the Stage at once and is the Stage's Verdict, for `tick` to report.
 *
 * Each Run's prompts come from its Agent's AGENT.md (`assembleRunSpec`). Every Agent of a pass
 * reads the same history, taken before the pass starts.
 */
export function agentExecutor(opts: AgentExecutorOptions): StageExecutor {
  return async (task, stage) => {
    let passed = 0;
    const agents = agentsFor(opts.config, task, stage);
    const history: History = {
      reports: priorReports(opts.store, task.id),
      findings: blockingFindings(opts.store, opts.config, task, stage),
    };
    for (const agent of agents) {
      const verdict = await runAgent(opts, task, stage, agent, history);
      if (!isRouted(verdict)) return verdict;
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
  stage: StageConfig,
  agentName: string,
  history: History,
): Promise<Verdict> {
  const milestone = opts.store.getMilestone(task.milestone_id);
  const request = milestone && opts.store.getRequest(milestone.request_id);
  if (!request) throw new Error(`no Request for task ${task.id}`);
  const runId = opts.store.createRun({
    task_id: task.id,
    request_id: request.id,
    stage: stage.name,
    agent: agentName,
  });
  const started = Date.now();
  try {
    const loaded = opts.config.agents.get(agentName);
    if (!loaded) throw new Error(`stage "${stage.name}": unknown agent "${agentName}"`);
    const requestDir = join(request.target_repo, ".foreman", request.id);
    const spec = assembleRunSpec({
      runId,
      agent: loaded.agent,
      skills: resolveSkills(loaded.agent.skills, {
        roots: opts.config.skillRoots,
        source: loaded.path,
      }),
      task,
      request,
      stage: stage.name,
      paths: {
        task: join(
          request.target_repo,
          task.file_path ?? join(".foreman", request.id, "tasks", `${task.id}.md`),
        ),
        spec: join(requestDir, "spec.md"),
        plan: join(requestDir, "plan.md"),
        precedents: join(request.target_repo, ".foreman", "precedents.md"),
        report: join(requestDir, "runs", `${runId}-${stage.name}.md`),
        workdir: request.target_repo,
      },
      ...history,
    });
    const result = await opts.runner.run(spec);
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
