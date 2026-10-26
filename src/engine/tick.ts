import { DONE, type Pipeline, type StageConfig } from "../config/pipeline.ts";
import { isSettled, type Store, type TaskRow } from "../store/store.ts";
import { enter, route, type Stage, stageOf, type Transition } from "./route.ts";
import { isRouted, type RoutedVerdict, type Verdict } from "./verdict.ts";

/**
 * Does the work of one Stage for one Task and says whether it passed. Throws if it cannot run.
 * It may give a Verdict the engine cannot route yet, which `tick` treats as an error.
 */
export type StageExecutor = (task: TaskRow, stage: StageConfig) => Promise<Verdict>;

/** What finished because a Task settled: Milestone ids, and the Request id once its last Milestone is done. */
export interface Completed {
  milestones: string[];
  request: string | null;
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "paused"; reason: string | null }
  | {
      kind: "ran";
      task: string;
      stage: Stage;
      verdict: RoutedVerdict;
      transition: Transition;
      completed: Completed;
    }
  /**
   * The engine should stop. The executor threw or gave a Verdict the engine cannot route, so the
   * Task is back to `queued` at the same Stage; or the config is broken or no longer fits the Task, so it is
   * untouched and `stage` is the Stage it was at, if any.
   */
  | { kind: "error"; task: string; stage?: Stage; message: string };

export interface TickOptions {
  /** The Pipeline that runs `task`. May throw, if the Task's config is broken: that is a tick error. */
  pipelineFor: (task: TaskRow) => Pipeline;
  executor: StageExecutor;
  holder?: string;
  leaseMs?: number;
}

/** The next Task to work on: building Requests only, dependencies done, earliest Milestone first. */
export function nextActionable(store: Store): TaskRow | undefined {
  const settled = new Set(
    store
      .listTasks()
      .filter((t) => isSettled(t.status))
      .map((t) => t.id),
  );
  for (const req of store.buildingRequests()) {
    for (const m of store.listMilestones(req.id)) {
      const task = store
        .listTasks(m.id)
        .find(
          (t) =>
            (t.status === "queued" || t.status === "active") &&
            store.dependenciesOf(t.id).every((d) => settled.has(d)),
        );
      if (task) return task;
    }
  }
  return undefined;
}

export async function tick(store: Store, opts: TickOptions): Promise<TickResult> {
  if (store.isPaused()) return { kind: "paused", reason: store.queueState().reason };

  const task = nextActionable(store);
  if (!task) return { kind: "idle" };

  const holder = opts.holder ?? `pid-${process.pid}`;
  if (!store.takeLease(task.id, holder, opts.leaseMs ?? 3_600_000)) {
    return { kind: "idle" };
  }
  store.addEvent("lease.taken", task.id, { holder });
  try {
    let pipeline: Pipeline;
    let stage: Stage;
    let config: StageConfig;
    try {
      pipeline = opts.pipelineFor(task);
      stage = task.stage ?? enter(pipeline, pipeline.stages[0]?.name ?? DONE, task.lane);
      if (stage === DONE) throw new Error(`no stage runs in the ${task.lane} lane`);
      config = stageOf(pipeline, stage);
    } catch (e) {
      // The config is broken or no longer fits the Task. Leave it untouched for the Owner to fix the config.
      const message = e instanceof Error ? e.message : String(e);
      const at = task.stage ?? undefined;
      store.addEvent("stage.misconfigured", task.id, { stage: at, message });
      return { kind: "error", task: task.id, stage: at, message };
    }
    store.transaction(() => {
      store.updateTask(task.id, { status: "active", stage });
      // A Task starts when it leaves `queued`: the first tick, and again after a crash put it back.
      if (task.status !== "active") store.addEvent("task.started", task.id, { stage });
    });
    let verdict: Verdict;
    try {
      verdict = await opts.executor(task, config);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store.transaction(() => {
        store.updateTask(task.id, { status: "queued", stage });
        store.addEvent("stage.crashed", task.id, { stage, message });
      });
      return { kind: "error", task: task.id, stage, message };
    }
    if (!isRouted(verdict)) {
      // BLOCKED and SCOPE_CHANGE have no route until M5-T06 and M5-T08. Treat them as a crash.
      const message = `stage "${stage}" ended with ${verdict}, which the engine cannot route yet`;
      store.transaction(() => {
        store.updateTask(task.id, { status: "queued", stage });
        store.addEvent("verdict.unhandled", task.id, { stage, verdict, message });
      });
      return { kind: "error", task: task.id, stage, message };
    }
    const transition = route(pipeline, stage, verdict, task);
    const completed = apply(store, task, stage, verdict, transition);
    return { kind: "ran", task: task.id, stage, verdict, transition, completed };
  } finally {
    store.releaseLease(task.id);
    store.addEvent("lease.released", task.id, { holder });
  }
}

function apply(
  store: Store,
  task: TaskRow,
  stage: Stage,
  verdict: RoutedVerdict,
  transition: Transition,
): Completed {
  return store.transaction(() => {
    let completed: Completed = { milestones: [], request: null };
    store.addEvent("stage.completed", task.id, {
      stage,
      verdict,
      next: transition.kind === "done" ? "done" : transition.stage,
    });
    if (transition.kind === "done") {
      store.updateTask(task.id, {
        status: "done",
        round_stage: transition.round_stage,
        round_total: transition.round_total,
      });
      completed = completeAbove(store, task.milestone_id);
    } else {
      store.updateTask(task.id, {
        stage: transition.stage,
        round_stage: transition.round_stage,
        round_total: transition.round_total,
      });
      if (transition.round_total > task.round_total) {
        // `stage` is the Stage that failed and so caused this Round.
        store.addEvent("round.started", task.id, {
          stage,
          round_stage: transition.round_stage,
          round_total: transition.round_total,
        });
      }
    }
    return completed;
  });
}

/** Drops a Task without running it. Dropping the last open Task completes its Milestone and Request. */
export function dropTask(store: Store, taskId: string): Completed {
  return store.transaction(() => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`no such task: ${taskId}`);
    store.updateTask(task.id, { status: "dropped" });
    store.addEvent("task.dropped", task.id);
    return completeAbove(store, task.milestone_id);
  });
}

/** Run inside the transaction that settled a Task: completes its Milestone, then its Request. */
function completeAbove(store: Store, milestoneId: string): Completed {
  const completed: Completed = { milestones: [], request: null };
  const milestone = store.getMilestone(milestoneId);
  if (!milestone || milestone.status === "done") return completed;
  if (!store.listTasks(milestone.id).every((t) => isSettled(t.status))) return completed;
  store.updateMilestone(milestone.id, { status: "done" });
  store.addEvent("milestone.done", milestone.id);
  completed.milestones.push(milestone.id);

  const request = store.getRequest(milestone.request_id);
  if (!request || request.phase === "done") return completed;
  if (!store.listMilestones(request.id).every((m) => m.status === "done")) return completed;
  store.updateRequest(request.id, { phase: "done" });
  store.addEvent("request.done", request.id);
  completed.request = request.id;
  return completed;
}
