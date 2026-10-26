import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsFor } from "../config/agents.ts";
import type { ResolvedConfig } from "../config/layers.ts";
import type { StageConfig } from "../config/pipeline.ts";
import { resolveSkills } from "../config/skill.ts";
import { assembleRunSpec, type BlockingFinding, type PriorReport } from "../runner/prompt.ts";
import { RunFailure, type Runner, type Usage } from "../runner/runner.ts";
import type { RunRow, Store, TaskRow } from "../store/store.ts";
import { blockingFindings, priorReports } from "./context.ts";
import { Escalation } from "./escalation.ts";
import type { StageExecutor } from "./tick.ts";
import { isRouted, type Verdict } from "./verdict.ts";

export interface AgentExecutorOptions {
  store: Store;
  runner: Runner;
  /** `$FOREMAN_HOME`: the raw output of every Run is kept in its `runs/` folder, named for the Run. */
  home: string;
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
 * A Run that leaves no usable result (a failed container, a timeout, no valid Verdict, no report)
 * is an infrastructure failure: it costs no Round, gets one retry, and then Escalates. A bad
 * token is not retried: it throws, and the engine stops for the Owner to fix it.
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

/** Tries a Run gets when it leaves no usable result: the first, and one retry. */
const ATTEMPTS = 2;

async function runAgent(
  opts: AgentExecutorOptions,
  task: TaskRow,
  stage: StageConfig,
  agentName: string,
  history: History,
): Promise<Verdict> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptRun(opts, task, stage, agentName, history);
    } catch (e) {
      // Anything but a failed Run (a bug, a missing token file) or a bad token is not for a retry to fix.
      if (!(e instanceof RunFailure) || e.kind === "auth") throw e;
      if (attempt === ATTEMPTS) {
        throw new Escalation(
          `${agentName} left no usable result in ${stage.name} after ${ATTEMPTS} tries: ${e.message}`,
        );
      }
      opts.store.addEvent("run.retried", task.id, {
        stage: stage.name,
        agent: agentName,
        kind: e.kind,
        message: e.message,
      });
    }
  }
}

/** One Run, recorded in its `runs` row whether it succeeds or not. */
async function attemptRun(
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
  // What the row shows if the Run fails after spending something.
  let spent: Partial<RunRow> = {};
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
    spent = { model: spec.model ?? null, effort: spec.effort ?? null };
    const result = await opts.runner.run(spec);
    await keepRaw(opts.home, runId, result.raw);
    spent = {
      model: result.model ?? spec.model ?? null,
      effort: spec.effort ?? null,
      ...usageColumns(result.usage),
    };
    if (!existsSync(result.reportPath)) {
      throw new RunFailure("missing-report", `${agentName} left no report at ${result.reportPath}`);
    }
    opts.store.finishRun(runId, {
      ...spent,
      verdict: result.verdict,
      duration_ms: Date.now() - started,
      exit_code: 0,
      report_path: result.reportPath,
    });
    return result.verdict;
  } catch (e) {
    if (e instanceof RunFailure) {
      if (e.stdout) await keepRaw(opts.home, runId, e.stdout);
      if (e.usage) spent = { ...spent, ...usageColumns(e.usage) };
    }
    opts.store.finishRun(runId, {
      ...spent,
      duration_ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** The `runs` columns a Run's usage fills in. */
function usageColumns(usage: Usage): Partial<RunRow> {
  return {
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    context_peak: usage.context_peak,
    cost_usd: usage.cost_usd,
  };
}

/**
 * Saves what a Run printed to `$FOREMAN_HOME/runs/<id>.json`. It is for diagnosis, so a failure to
 * write it is logged and never hides the Run's own outcome.
 */
async function keepRaw(home: string, runId: number, raw: string): Promise<void> {
  try {
    const dir = join(home, "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${runId}.json`), raw);
  } catch (e) {
    console.error(
      `could not keep the output of Run ${runId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}
