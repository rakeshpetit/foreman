import type { Store, TaskRow } from "../store/store.ts";
import { type Outcome, PIPELINE, route, type Stage, type Transition } from "./route.ts";

export type StageExecutor = (task: TaskRow, stage: Stage) => Promise<Outcome>;

export type TickResult =
  | { kind: "idle" }
  | { kind: "paused"; reason: string | null }
  | { kind: "ran"; task: string; stage: Stage; outcome: Outcome; transition: Transition };

export interface TickOptions {
  executor: StageExecutor;
  holder?: string;
  leaseMs?: number;
}

/** The next Task to work on: building Requests only, dependencies done, earliest Milestone first. */
export function nextActionable(store: Store): TaskRow | undefined {
  const done = new Set(
    store
      .listTasks()
      .filter((t) => t.status === "done")
      .map((t) => t.id),
  );
  for (const req of store.listRequests().filter((r) => r.phase === "building")) {
    for (const m of store.listMilestones(req.id)) {
      const task = store
        .listTasks(m.id)
        .find(
          (t) =>
            (t.status === "queued" || t.status === "active") &&
            store.dependenciesOf(t.id).every((d) => done.has(d)),
        );
      if (task) return task;
    }
  }
  return undefined;
}

export async function tick(store: Store, opts: TickOptions): Promise<TickResult> {
  const q = store.queueState();
  if (q.paused_until && new Date(q.paused_until) > store.now()) {
    return { kind: "paused", reason: q.reason };
  }

  const task = nextActionable(store);
  if (!task) return { kind: "idle" };

  if (!store.takeLease(task.id, opts.holder ?? `pid-${process.pid}`, opts.leaseMs ?? 3_600_000)) {
    return { kind: "idle" };
  }
  try {
    const stage = (task.stage ?? PIPELINE[0]) as Stage;
    store.updateTask(task.id, { status: "active", stage });
    const outcome = await opts.executor(task, stage);
    const transition = route(stage, outcome);
    apply(store, task, stage, outcome, transition);
    return { kind: "ran", task: task.id, stage, outcome, transition };
  } finally {
    store.releaseLease(task.id);
  }
}

function apply(
  store: Store,
  task: TaskRow,
  stage: Stage,
  outcome: Outcome,
  transition: Transition,
): void {
  store.transaction(() => {
    if (transition.kind === "done") {
      store.updateTask(task.id, { status: "done", round_stage: 0 });
    } else {
      store.updateTask(task.id, {
        stage: transition.stage,
        round_stage: transition.round ? task.round_stage + 1 : 0,
        round_total: task.round_total + (transition.round ? 1 : 0),
      });
    }
    store.addEvent("stage.completed", task.id, {
      stage,
      outcome,
      next: transition.kind === "done" ? "done" : transition.stage,
    });
  });
}
