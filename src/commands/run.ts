import type { Pipeline } from "../config/pipeline.ts";
import { agentExecutor } from "../engine/agent.ts";
import {
  type GateRegistry,
  gateExecutor,
  ownerExecutor,
  STUB_GATES,
  stageExecutor,
} from "../engine/executors.ts";
import { type TickResult, tick } from "../engine/tick.ts";
import {
  engineError,
  type Notifier,
  notifySafely,
  requestDone,
  taskDone,
} from "../notify/notifier.ts";
import type { Runner } from "../runner/runner.ts";
import { writeStatus } from "../status/status.ts";
import type { Store } from "../store/store.ts";

export interface RunOptions {
  home: string;
  untilIdle: boolean;
  runner: Runner;
  pipeline: Pipeline;
  gates?: GateRegistry;
  notifier?: Notifier;
}

/** Ticks the engine, rewriting STATUS.md after every tick. Stops on idle, paused or an error. Returns the tick results. */
export async function runEngine(store: Store, opts: RunOptions): Promise<TickResult[]> {
  const results: TickResult[] = [];
  const executor = stageExecutor({
    agent: agentExecutor({ store, runner: opts.runner }),
    gate: gateExecutor(opts.gates ?? STUB_GATES),
    owner: ownerExecutor,
  });
  do {
    const result = await tick(store, { pipeline: opts.pipeline, executor });
    results.push(result);
    if (opts.notifier) await notifyTick(store, result, opts.notifier);
    writeStatus(store, opts.home);
    if (result.kind !== "ran") break;
  } while (opts.untilIdle);
  return results;
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
