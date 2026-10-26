import { join } from "node:path";
import { agentExecutor } from "../engine/agent.ts";
import { type TickResult, tick } from "../engine/tick.ts";
import { type Notifier, notifySafely, requestDone, taskDone } from "../notify/notifier.ts";
import { FakeRunner } from "../runner/fake.ts";
import type { Runner } from "../runner/runner.ts";
import { writeStatus } from "../status/status.ts";
import type { Store } from "../store/store.ts";

export interface RunOptions {
  home: string;
  untilIdle: boolean;
  runner?: Runner;
  notifier?: Notifier;
}

/** Ticks the engine, rewriting STATUS.md after every tick. Returns the tick results. */
export async function runEngine(store: Store, opts: RunOptions): Promise<TickResult[]> {
  const results: TickResult[] = [];
  do {
    const [first] = store.listRequests().filter((r) => r.phase === "building");
    const executor = agentExecutor({
      runner: opts.runner ?? new FakeRunner(),
      workdir: first?.target_repo ?? opts.home,
      reportsDir: join(opts.home, "reports"),
    });
    const result = await tick(store, { executor });
    results.push(result);
    if (result.kind === "ran" && result.transition.kind === "done") {
      await onTaskDone(store, result.task, opts.notifier);
    }
    writeStatus(store, opts.home);
    if (result.kind === "idle" || result.kind === "paused") break;
  } while (opts.untilIdle);
  return results;
}

async function onTaskDone(store: Store, taskId: string, notifier?: Notifier): Promise<void> {
  const task = store.getTask(taskId);
  const milestone = task && store.getMilestone(task.milestone_id);
  if (!task || !milestone) return;
  if (notifier) await notifySafely(notifier, taskDone(task.id, task.title));

  const request = store.getRequest(milestone.request_id);
  if (!request) return;
  const allDone = store
    .listMilestones(request.id)
    .flatMap((m) => store.listTasks(m.id))
    .every((t) => t.status === "done" || t.status === "dropped");
  if (!allDone) return;
  store.updateRequest(request.id, { phase: "done" });
  store.addEvent("request.done", request.id);
  if (notifier) await notifySafely(notifier, requestDone(request.id, request.title));
}
