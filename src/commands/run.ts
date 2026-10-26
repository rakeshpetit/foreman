import type { ResolvedConfig } from "../config/layers.ts";
import { configResolver, resolveConfig } from "../config/resolve.ts";
import { agentExecutor } from "../engine/agent.ts";
import { gateExecutor, ownerExecutor, stageExecutor } from "../engine/executors.ts";
import { type StageExecutor, type TickResult, tick } from "../engine/tick.ts";
import { STUB_GATES } from "../gates/stub.ts";
import {
  engineError,
  escalation,
  type Notifier,
  notifySafely,
  requestDone,
  taskDone,
  usageLimitPause,
} from "../notify/notifier.ts";
import type { Runner } from "../runner/runner.ts";
import { writeStatus } from "../status/status.ts";
import type { Store } from "../store/store.ts";

export interface RunOptions {
  home: string;
  untilIdle: boolean;
  runner: Runner;
  /** Request id → its resolved config (`resolveConfigs`). One missing here is resolved when its first Task runs. */
  configs?: ReadonlyMap<string, ResolvedConfig>;
  /** foreman's own checkout, for `loadConfig`. */
  foremanDir?: string;
  notifier?: Notifier;
}

/**
 * Resolves the config of every building Request, so a broken one stops `foreman run` before any
 * Agent runs. Throws the first `ConfigError`, `PipelineError` or `AgentError`.
 */
export function resolveConfigs(store: Store, foremanDir?: string): Map<string, ResolvedConfig> {
  const configs = new Map<string, ResolvedConfig>();
  for (const request of store.buildingRequests()) {
    configs.set(request.id, resolveConfig(store, request, foremanDir));
  }
  return configs;
}

/** Ticks the engine, rewriting STATUS.md after every tick. Stops on idle, paused (a usage limit pauses the queue itself) or an error; an Escalation parks its Task and the loop goes on. Returns the tick results. */
export async function runEngine(store: Store, opts: RunOptions): Promise<TickResult[]> {
  const results: TickResult[] = [];
  const configFor = configResolver(store, opts.configs, opts.foremanDir);
  // The same registry `resolveConfig` validates `gates` against, so every Gate a Stage names exists.
  const gate = gateExecutor(STUB_GATES);
  const executor: StageExecutor = (task, stage) =>
    stageExecutor({
      agent: agentExecutor({
        store,
        runner: opts.runner,
        home: opts.home,
        config: configFor(task),
      }),
      gate,
      owner: ownerExecutor,
    })(task, stage);
  do {
    const result = await tick(store, { pipelineFor: (task) => configFor(task).pipeline, executor });
    results.push(result);
    if (opts.notifier) await notifyTick(store, result, opts.notifier);
    writeStatus(store, opts.home);
    if (result.kind !== "ran" && result.kind !== "escalated") break;
  } while (opts.untilIdle);
  return results;
}

async function notifyTick(store: Store, result: TickResult, notifier: Notifier): Promise<void> {
  if (result.kind === "error") return notifySafely(notifier, engineError(result.message));
  if (result.kind === "usage-limit") return notifySafely(notifier, usageLimitPause(result.until));
  if (result.kind === "escalated") {
    return notifySafely(notifier, escalation(result.task, result.message));
  }
  if (result.kind !== "ran") return;
  if (result.transition.kind === "done") {
    const task = store.getTask(result.task);
    if (task) await notifySafely(notifier, taskDone(task.id, task.title));
  }
  const request = result.completed.request && store.getRequest(result.completed.request);
  if (request) await notifySafely(notifier, requestDone(request.id, request.title));
}
