import { isSettled, type Store, type TaskRow } from "../store/store.ts";
import { PIPELINE, route, type Stage, type Transition, type Verdict } from "./route.ts";

export type StageExecutor = (task: TaskRow, stage: Stage) => Promise<Verdict>;

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
      verdict: Verdict;
      transition: Transition;
      completed: Completed;
    }
  /** The executor threw. The Task is back to `queued` at the same Stage and the engine should stop. */
  | { kind: "error"; task: string; stage: Stage; message: string };

export interface TickOptions {
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
  for (const req of store.listRequests().filter((r) => r.phase === "building")) {
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
    const stage = task.stage ?? PIPELINE[0];
    store.transaction(() => {
      store.updateTask(task.id, { status: "active", stage });
      // A Task starts when it leaves `queued`: the first tick, and again after a crash put it back.
      if (task.status !== "active") store.addEvent("task.started", task.id, { stage });
    });
    let verdict: Verdict;
    try {
      verdict = await opts.executor(task, stage);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store.transaction(() => {
        store.updateTask(task.id, { status: "queued", stage });
        store.addEvent("stage.crashed", task.id, { stage, message });
      });
      return { kind: "error", task: task.id, stage, message };
    }
    const transition = route(stage, verdict, task);
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
  verdict: Verdict,
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
