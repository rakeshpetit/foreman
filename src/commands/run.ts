import { agentsFor } from "../config/agents.ts";
import type { Pipeline } from "../config/pipeline.ts";
import { agentExecutor } from "../engine/agent.ts";
import {
  type GateRegistry,
  gateExecutor,
  ownerExecutor,
  STUB_GATES,
  stageExecutor,
} from "../engine/executors.ts";
import { nextActionable, type TickResult, tick } from "../engine/tick.ts";
import {
  engineError,
  type Notifier,
  notifySafely,
  requestDone,
  taskDone,
} from "../notify/notifier.ts";
import type { Runner } from "../runner/runner.ts";
import { writeStatus } from "../status/status.ts";
import type { Store, TaskRow } from "../store/store.ts";
import { resolveConfig } from "./config.ts";

export interface RunOptions {
  home: string;
  untilIdle: boolean;
  runner: Runner;
  /** The Pipeline for a Task whose Request has none in `pipelines`. */
  pipeline: Pipeline;
  /** Request id → its resolved Pipeline (`resolvePipelines`). */
  pipelines?: ReadonlyMap<string, Pipeline>;
  gates?: GateRegistry;
  notifier?: Notifier;
}

/**
 * Resolves the config of every building Request, so a broken one stops `foreman run` before any
 * Agent runs. Throws the first `ConfigError`, `PipelineError` or `AgentError`.
 */
export function resolvePipelines(store: Store): Map<string, Pipeline> {
  const pipelines = new Map<string, Pipeline>();
  for (const request of store.listRequests().filter((r) => r.phase === "building")) {
    pipelines.set(request.id, resolveConfig(store, request).pipeline);
  }
  return pipelines;
}

/** Ticks the engine, rewriting STATUS.md after every tick. Stops on idle, paused or an error. Returns the tick results. */
export async function runEngine(store: Store, opts: RunOptions): Promise<TickResult[]> {
  const results: TickResult[] = [];
  do {
    const next = nextActionable(store);
    const pipeline = (next && opts.pipelines?.get(requestIdOf(store, next))) ?? opts.pipeline;
    const executor = stageExecutor({
      agent: agentExecutor({
        store,
        runner: opts.runner,
        agentsFor: (task, stage) => agentsFor(pipeline, task, stage),
      }),
      gate: gateExecutor(opts.gates ?? STUB_GATES),
      owner: ownerExecutor,
    });
    const result = await tick(store, { pipeline, executor });
    results.push(result);
    if (opts.notifier) await notifyTick(store, result, opts.notifier);
    writeStatus(store, opts.home);
    if (result.kind !== "ran") break;
  } while (opts.untilIdle);
  return results;
}

function requestIdOf(store: Store, task: TaskRow): string {
  const milestone = store.getMilestone(task.milestone_id);
  if (!milestone) throw new Error(`no Milestone for task ${task.id}`);
  return milestone.request_id;
}

async function notifyTick(store: Store, result: TickResult, notifier: Notifier): Promise<void> {
  if (result.kind === "error") return notifySafely(notifier, engineError(result.message));
  if (result.kind !== "ran") return;
  if (result.transition.kind === "done") {
    const task = store.getTask(result.task);
    if (task) await notifySafely(notifier, taskDone(task.id, task.title));
  }
  const request = result.completed.request && store.getRequest(result.completed.request);
  if (request) await notifySafely(notifier, requestDone(request.id, request.title));
}
