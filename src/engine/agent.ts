import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentsFor } from "../config/agents.ts";
import type { ResolvedConfig } from "../config/layers.ts";
import type { StageConfig } from "../config/pipeline.ts";
import { resolveSkills } from "../config/skill.ts";
import { assembleRunSpec, type BlockingFinding, type PriorReport } from "../runner/prompt.ts";
import { RunFailure, type Runner } from "../runner/runner.ts";
import type { Store, TaskRow } from "../store/store.ts";
import { blockingFindings, priorReports } from "./context.ts";
import { Escalation } from "./escalation.ts";
import { openRun } from "./recording.ts";
import type { StageExecutor } from "./tick.ts";
import { UsageLimit } from "./usage-limit.ts";
import { isRouted, type Verdict } from "./verdict.ts";

export interface AgentExecutorOptions {
  store: Store;
  runner: Runner;
  /** Where the raw output of every Run is kept, named for the Run (`<runsDir>/<id>.json`). */
  runsDir: string;
  /** Where a failure to keep the raw output is reported. Default: stderr. */
  log?: (msg: string) => void;
  /** The Task's Request's config: the Pipeline that picks each Stage's Agents, and the Agents and Skills to load. */
  config: Pick<ResolvedConfig, "pipeline" | "taskAgents" | "agents" | "skillRoots">;
}

/** What one Agent's Run needs: the Stage's Task, which Agent, and what earlier Runs left. */
interface Assignment {
  opts: AgentExecutorOptions;
  task: TaskRow;
  stage: StageConfig;
  agentName: string;
  history: History;
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
 * token is not retried: it throws, and the engine stops for the Owner to fix it. A usage limit is
 * not retried either: it throws a `UsageLimit`, and `tick` pauses the queue until the reset.
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
      const verdict = await runAgent({ opts, task, stage, agentName: agent, history });
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

/** How long to pause for a usage limit whose reset time is unknown, or not in the future. */
const FALLBACK_PAUSE_MS = 30 * 60_000;

async function runAgent(assignment: Assignment): Promise<Verdict> {
  const { opts, task, stage, agentName } = assignment;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptRun(assignment);
    } catch (e) {
      // Anything but a failed Run (a bug, a missing token file) or a bad token is not for a retry to fix.
      if (!(e instanceof RunFailure) || e.kind === "auth") throw e;
      if (e.kind === "usage-limit") throw new UsageLimit(e.message, resetOf(e, opts.store.now()));
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

/** The reset time a limit failure gives, or a fixed wait from `now` when it gives none or a past one. */
function resetOf(failure: RunFailure, now: Date): Date {
  const { resetsAt } = failure;
  return resetsAt && resetsAt > now ? resetsAt : new Date(now.getTime() + FALLBACK_PAUSE_MS);
}

/** One Run, recorded in its `runs` row whether it succeeds or not. */
async function attemptRun({ opts, task, stage, agentName, history }: Assignment): Promise<Verdict> {
  const milestone = opts.store.getMilestone(task.milestone_id);
  const request = milestone && opts.store.getRequest(milestone.request_id);
  if (!request) throw new Error(`no Request for task ${task.id}`);
  const recording = openRun(opts, {
    task_id: task.id,
    request_id: request.id,
    stage: stage.name,
    agent: agentName,
  });
  const runId = recording.runId;
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
    recording.planned(spec);
    const result = await opts.runner.run(spec);
    await recording.returned(spec, result);
    if (!existsSync(result.reportPath)) {
      throw new RunFailure(
        "missing-report",
        `${agentName} left no report at ${result.reportPath}`,
        { exitCode: 0 },
      );
    }
    recording.finish(result);
    return result.verdict;
  } catch (e) {
    await recording.fail(e);
    throw e;
  }
}
